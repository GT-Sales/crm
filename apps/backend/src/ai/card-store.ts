import { createHash } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import {
  auditEvents,
  withTenantTx,
  type DatabaseClient,
  type TenantTransaction,
} from '@gt-sales/db';
import {
  emailTemplateLabel,
  flowStepSchema,
  isLeadStage,
  isOrderLeadType,
  isSiteTemplateKey,
  leadFormSchema,
  leadStageLabel,
  stageGates,
  updateWorkspaceLeadRequestSchema,
  type AiLeadEditChanges,
  type AiLeadEditContext,
  type AiOrderDetailField,
  type AiStageMoveNeed,
  type FlowStep,
  type PropertyCatalog,
  type SiteProperty,
} from '@gt-sales/contracts';

import { readLiveFlows, runQueuedStarts, storedTrigger } from '../automations/engine.js';
import { readEmailTemplate } from '../email/settings-store.js';
import {
  customerEmailEnvironmentFromEnv,
  type CustomerEmailEnvironment,
} from '../email/senders.js';
import { findMissingDocuments } from '../leads/documents-check.js';
import { toLeadOrder } from '../leads/order.js';
import { planStageMove, todayInToronto } from '../leads/stage-move.js';
import { isClosingStage } from '../leads/types.js';
import {
  applyLeadUpdate,
  lockLead,
  type LockedLead,
  type UpdateLeadWorkOutcome,
} from '../leads/work-store.js';
import type { Scope, WriteScope } from '../tenant-scope.js';
import { sideEffectsDigest } from './card-safeguards.js';
import type { ArchiveLead } from './actions.js';

/**
 * The reads and the one write behind Ask AI's wider cards that the lead work
 * store does not already have: a lead edit's preview and confirmation (stage,
 * order details, form and custom values through `applyLeadUpdate`, the staff
 * edit's own path, with the site's catalogue) and the side effects a stage
 * move or an archive sets off (C3). Nothing here is reachable by the model:
 * the prepare tools only receive the card's words.
 */

/** The labels of the order details a stage move's card can carry, as the lead page names them. */
const ORDER_DETAIL_LABELS: Readonly<Record<AiOrderDetailField, string>> = {
  courier: 'Courier',
  trackingNumber: 'Tracking number',
  dispatchedAt: 'Dispatch date',
  activatedAt: 'Activation date',
  activationNumber: 'Activation number',
  activationAccount: 'Activation account',
};

const ORDER_FIELD_LABELS: Readonly<Record<string, string>> = {
  ...ORDER_DETAIL_LABELS,
  planId: 'Plan',
  quantity: 'Quantity',
  paymentStatus: 'Payment status',
  carrierCommission: 'Carrier commission',
};

/** JSON with sorted keys: a stored object comes back from JSONB in its own key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const objectOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};

/** The form payload a lead stores, or an empty one. */
function formPayload(payload: unknown): Record<string, unknown> {
  const form = leadFormSchema.safeParse(payload);
  return form.success ? objectOf(form.data.payload) : {};
}

/** The lead state a lead edit card is prepared against, in one place, so preview and confirm agree. */
interface LeadEditState {
  stage: string;
  status: string;
  payload: unknown;
  customValues: unknown;
  orderDetails: unknown;
}

/**
 * C4: the digest of everything a lead edit touches as it was when the card
 * was prepared: the stage and status (a move may submit a checkout), the whole
 * order, and the current value of each form and custom field the card names.
 */
export function leadEditVersion(state: LeadEditState, changes: AiLeadEditChanges): string {
  const form = formPayload(state.payload);
  const custom = objectOf(state.customValues);
  const pick = (from: Record<string, unknown>, keys: readonly string[]) =>
    Object.fromEntries(keys.map((key) => [key, from[key] ?? null]));
  return createHash('sha256')
    .update(
      canonical({
        stage: state.stage,
        status: state.status,
        order: objectOf(state.orderDetails),
        form: pick(form, Object.keys(changes.form ?? {})),
        custom: pick(custom, Object.keys(changes.customValues ?? {})),
      }),
    )
    .digest('hex');
}

/** A value as the person reads it on a card: an option's label, Yes/No, or the text. */
function shown(property: SiteProperty | undefined, value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  const option = property?.options?.find((entry) => entry.value === value);
  if (option) return option.label.slice(0, 1000);
  if (typeof value === 'string' || typeof value === 'number') return String(value).slice(0, 1000);
  return JSON.stringify(value).slice(0, 1000);
}

/** One step's effect in words; a step that does not read as one says only that the flow runs. */
function stepWords(
  step: FlowStep,
  templates: ReadonlyMap<string, string>,
  leadType: string,
): string[] {
  switch (step.kind) {
    case 'send_email':
      return [
        `sends the “${templates.get(step.template) ?? emailTemplateLabel(step.template)}” email to the customer`,
      ];
    case 'create_task':
      return ['creates a task'];
    case 'assign_lead':
      return ['assigns the lead'];
    case 'update_lead':
      return step.change.kind === 'stage'
        ? [`moves the lead to ${leadStageLabel(leadType, step.change.stage)}`]
        : ['changes a lead property'];
    case 'notify_staff':
      return ['emails staff'];
    case 'wait':
      return ['waits, then continues'];
    case 'if_else':
      return [
        ...step.then.flatMap((entry) => stepWords(entry, templates, leadType)),
        ...step.else.flatMap((entry) => stepWords(entry, templates, leadType)),
      ];
  }
}

function stepsOf(definition: unknown): FlowStep[] | undefined {
  const raw = objectOf(definition)['steps'];
  if (!Array.isArray(raw)) return undefined;
  const steps: FlowStep[] = [];
  for (const entry of raw) {
    const parsed = flowStepSchema.safeParse(entry);
    if (!parsed.success) return undefined;
    steps.push(parsed.data);
  }
  return steps;
}

function templatesOf(steps: readonly FlowStep[]): string[] {
  return steps.flatMap((step) =>
    step.kind === 'send_email'
      ? [step.template]
      : step.kind === 'if_else'
        ? [...templatesOf(step.then), ...templatesOf(step.else)]
        : [],
  );
}

/**
 * C3 + B3: what a stage move sets off besides the move, in words, from the
 * site's live flows as they are now: the submission of a checkout the
 * customer never finished, each flow that fires for the stage entered (and,
 * for a submission, the submission's flows first) with what its steps do, and
 * each flow whose clock the move starts. A flow with conditions is said to run
 * "when its conditions match": the card cannot know a condition's answer
 * before the move.
 */
export async function stageMoveEffects(
  tx: TenantTransaction,
  workspaceId: string,
  lead: { leadType: string; status: string },
  to: string,
): Promise<string[]> {
  const effects: string[] = [];
  const toLabel = leadStageLabel(lead.leadType, to);
  if (lead.status === 'incomplete') {
    if (isClosingStage(lead.leadType, to)) {
      return [
        'The customer’s unfinished checkout stays unsubmitted, and no automation runs for this move.',
      ];
    }
    effects.push(
      'Submits the customer’s unfinished checkout: the plan is frozen and the customer can no longer finish it online.',
    );
  }
  const flows = await readLiveFlows(tx, workspaceId);
  const names = new Map<string, string>();
  const runs: string[] = [];
  const later: string[] = [];
  for (const flow of flows) {
    const trigger = storedTrigger(flow.definition);
    if (!trigger) continue;
    const fires =
      (trigger.kind === 'stage_entered' &&
        trigger.leadType === lead.leadType &&
        trigger.stage === to) ||
      (lead.status === 'incomplete' &&
        trigger.kind === 'lead_submitted' &&
        trigger.leadTypes.includes(lead.leadType));
    const timer =
      trigger.kind === 'time_in_stage' &&
      trigger.leadType === lead.leadType &&
      trigger.stage === to;
    if (!fires && !timer) continue;
    const name = flow.name.slice(0, 80);
    if (timer) {
      later.push(`“${name}” runs later if the lead stays at ${toLabel}.`);
      continue;
    }
    const steps = stepsOf(flow.definition);
    for (const key of steps ? templatesOf(steps) : []) {
      if (names.has(key)) continue;
      const stored = isSiteTemplateKey(key)
        ? await readEmailTemplate(tx, workspaceId, key)
        : undefined;
      names.set(key, emailTemplateLabel(key, stored?.name ?? null).slice(0, 80));
    }
    const words = steps
      ? [...new Set(steps.flatMap((step) => stepWords(step, names, lead.leadType)))]
      : [];
    const when = trigger.when === null ? '' : ' (when its conditions match)';
    runs.push(
      `“${name}”${when} runs: ${words.length > 0 ? words.join(', ') : 'its steps'}.`.slice(0, 300),
    );
  }
  effects.push(...runs, ...later);
  if (runs.length === 0 && later.length === 0) effects.push('No automation runs for this move.');
  return effects.slice(0, 20);
}

/** What an archive or a restore sets off, in words (C3); the same every time. */
export function archiveEffects(archived: boolean): string[] {
  return archived
    ? [
        'Waiting automation runs and timers for this lead are cancelled. Restoring the lead does not bring them back.',
        'The lead leaves the inbox and can be restored from the archive.',
      ]
    : [
        'The lead returns to the inbox.',
        'Automation runs and timers cancelled when it was archived do not come back.',
      ];
}

/** What switching a flow off sets off, in words (C3). */
export function automationOffEffects(name: string): string[] {
  return [
    `Switches “${name.slice(0, 80)}” off: its waiting runs are cancelled and its timers voided.`,
    'No new runs start until someone switches it on again on the Automations page.',
  ];
}

export type AiLeadEditPreview =
  | {
      status: 'ready';
      context: AiLeadEditContext;
      sideEffects: string[];
      version: string;
    }
  | { status: 'not_found' }
  | { status: 'no_change' }
  | { status: 'invalid'; field: string }
  | { status: 'illegal_stage_move'; allowed: readonly string[] }
  | { status: 'documents'; missing: string[] };

export type AiLeadEditConfirmOutcome =
  | { status: 'saved'; recordId: string }
  | { status: 'not_found' | 'trashed' | 'conflict' }
  | { status: 'invalid'; field: string }
  | { status: 'refused'; refusal: Exclude<UpdateLeadWorkOutcome, { status: 'updated' }> };

class LeadEditRefused extends Error {
  constructor(readonly outcome: Exclude<UpdateLeadWorkOutcome, { status: 'updated' }>) {
    super('ai lead edit refused');
  }
}

export interface AiCardStore {
  previewLeadEdit(
    input: Scope & { leadId: string; changes: AiLeadEditChanges; catalog: PropertyCatalog },
  ): Promise<AiLeadEditPreview>;
  confirmLeadEdit(
    input: WriteScope & {
      leadId: string;
      changes: AiLeadEditChanges;
      catalog: PropertyCatalog;
      creationId: string;
      aiCardId?: string;
      version: string;
      /** The digest of the side effects the card showed, when it moves the stage. */
      sideEffects?: string;
    },
  ): Promise<AiLeadEditConfirmOutcome>;
  /** An archive card's lead as it is now, archived or not; undefined when restricted or gone. */
  archiveLead(input: Scope & { leadId: string }): Promise<ArchiveLead | undefined>;
  /** C3: what moving an active lead to `stage` sets off now; undefined when it is not available. */
  stageEffects(input: Scope & { leadId: string; stage: string }): Promise<string[] | undefined>;
  /** The active plans of the lead's type, as choices (names only, never prices). */
  planChoices(input: Scope & { leadType: string }): Promise<{ planId: string; name: string }[]>;
}

type CardDatabase = Pick<DatabaseClient, 'withTenantTx'>;

export class DatabaseAiCardStore implements AiCardStore {
  constructor(
    private readonly database: CardDatabase = { withTenantTx },
    private readonly emailEnvironment: CustomerEmailEnvironment = customerEmailEnvironmentFromEnv(),
  ) {}

  planChoices(input: Scope & { leadType: string }): Promise<{ planId: string; name: string }[]> {
    return this.database.withTenantTx(input, async (tx) => {
      await tx.execute(sql`set local statement_timeout = '5s'`);
      const rows = await tx.execute<{ id: string; name: string }>(sql`
        select p.id, p.name from app.plans p
        where p.workspace_id = ${input.workspaceId} and p.lead_type = ${input.leadType} and p.active
        order by p.position, p.name, p.id
        limit 50
      `);
      return rows.map((row) => ({ planId: row.id, name: row.name }));
    });
  }

  archiveLead(input: Scope & { leadId: string }): Promise<ArchiveLead | undefined> {
    return this.database.withTenantTx(input, async (tx) => {
      await tx.execute(sql`set local statement_timeout = '5s'`);
      const [row] = await tx.execute<{
        [key: string]: unknown;
        leadType: string;
        stage: string;
        reference: string | null;
        name: string | null;
        createdAt: Date | string;
        archived: boolean;
      }>(sql`
        select l.lead_type as "leadType", l.stage, l.external_ref as reference,
          l.full_name as name, l.created_at as "createdAt", l.deleted_at is not null as archived
        from app.leads l
        where l.workspace_id = ${input.workspaceId} and l.id = ${input.leadId}
          and l.customer_data_restricted_at is null
      `);
      if (!row) return undefined;
      return {
        leadId: input.leadId,
        leadType: row.leadType,
        stage: row.stage,
        reference: row.reference,
        name: row.name,
        createdAt: new Date(row.createdAt),
        archived: row.archived,
      };
    });
  }

  stageEffects(input: Scope & { leadId: string; stage: string }): Promise<string[] | undefined> {
    return this.database.withTenantTx(input, async (tx) => {
      await tx.execute(sql`set local statement_timeout = '5s'`);
      const [lead] = await tx.execute<{
        [key: string]: unknown;
        leadType: string;
        status: string;
      }>(sql`
        select l.lead_type as "leadType", l.status from app.leads l
        where l.workspace_id = ${input.workspaceId} and l.id = ${input.leadId}
          and l.deleted_at is null and l.customer_data_restricted_at is null
      `);
      if (!lead) return undefined;
      return stageMoveEffects(tx, input.workspaceId, lead, input.stage);
    });
  }

  previewLeadEdit(
    input: Scope & { leadId: string; changes: AiLeadEditChanges; catalog: PropertyCatalog },
  ): Promise<AiLeadEditPreview> {
    return this.database.withTenantTx(input, async (tx): Promise<AiLeadEditPreview> => {
      await tx.execute(sql`set local statement_timeout = '5s'`);
      const [lead] = await tx.execute<
        LeadEditState & { [key: string]: unknown; leadType: string; trashed: boolean }
      >(sql`
        select l.lead_type as "leadType", l.stage, l.status, l.payload,
          l.custom_values as "customValues", l.order_details as "orderDetails",
          l.deleted_at is not null as trashed
        from app.leads l
        where l.workspace_id = ${input.workspaceId} and l.id = ${input.leadId}
          and l.customer_data_restricted_at is null
      `);
      if (!lead || lead.trashed) return { status: 'not_found' };
      const { changes } = input;
      // C2: what the card changes must be a body the staff route itself accepts.
      if (!updateWorkspaceLeadRequestSchema.safeParse(changes).success)
        return { status: 'invalid', field: 'changes' };
      if (changes.order && !isOrderLeadType(lead.leadType))
        return { status: 'invalid', field: 'order' };
      const properties = input.catalog.forType(lead.leadType);
      const propertyOf = (storage: string, field: string) =>
        properties.find(
          (property) =>
            property.storage === storage && (property.storageKey ?? property.key) === field,
        );
      const current = toLeadOrder(lead.orderDetails);
      const rows: AiLeadEditContext['rows'] = [];
      const inputs: AiLeadEditContext['inputs'] = [];
      let needs: AiStageMoveNeed | undefined;
      let sideEffects: string[] = [];

      if (changes.stage !== undefined && changes.stage !== lead.stage) {
        if (!isLeadStage(lead.leadType, changes.stage))
          return { status: 'invalid', field: 'stage' };
        const move = planStageMove({
          leadType: lead.leadType,
          from: lead.stage,
          to: changes.stage,
          current,
          edit: changes.order,
          today: todayInToronto(new Date()),
        });
        if (!move.ok) {
          if (move.refusal.status === 'illegal_stage_move')
            return { status: 'illegal_stage_move', allowed: move.refusal.allowed };
          needs =
            move.refusal.status === 'dispatch_details_required'
              ? 'dispatch_details'
              : 'activation_details';
        }
        const gates = stageGates(lead.leadType, changes.stage);
        if (gates.includes('documents')) {
          const missing = await findMissingDocuments(tx, {
            workspaceId: input.workspaceId,
            leadId: input.leadId,
            required: current.plan?.requiredDocuments ?? [],
          });
          // Never an override: the documents are approved on the lead page first.
          if (missing.length > 0) return { status: 'documents', missing };
        }
        const detail = (field: AiOrderDetailField, kind: 'text' | 'date', required: boolean) => {
          const value = current[field];
          inputs.push({
            field,
            label: ORDER_DETAIL_LABELS[field],
            kind,
            required,
            current: value === null ? null : String(value).slice(0, 200),
          });
        };
        if (gates.includes('dispatch')) {
          detail('courier', 'text', true);
          detail('trackingNumber', 'text', false);
          detail('dispatchedAt', 'date', false);
        }
        if (gates.includes('activation')) {
          detail('activatedAt', 'date', false);
          detail('activationNumber', 'text', false);
          detail('activationAccount', 'text', false);
        }
        rows.push({
          key: 'stage',
          label: 'Stage',
          before: leadStageLabel(lead.leadType, lead.stage),
          after: leadStageLabel(lead.leadType, changes.stage),
        });
        sideEffects = await stageMoveEffects(tx, input.workspaceId, lead, changes.stage);
      }

      for (const [field, value] of Object.entries(changes.order ?? {})) {
        if (value === undefined) continue;
        const property = propertyOf('order', field);
        const label = (property?.label ?? ORDER_FIELD_LABELS[field] ?? field).slice(0, 160);
        if (field === 'planId') {
          let after: string | null = null;
          if (typeof value === 'string') {
            const [plan] = await tx.execute<{ name: string }>(sql`
              select p.name from app.plans p
              where p.workspace_id = ${input.workspaceId} and p.id = ${value}
                and p.lead_type = ${lead.leadType} and p.active
            `);
            if (!plan) return { status: 'invalid', field: 'plan' };
            after = plan.name.slice(0, 1000);
          }
          rows.push({ key: 'order.planId', label, before: current.plan?.name ?? null, after });
          sideEffects.push(
            after === null
              ? 'Clears the order’s plan and its frozen price.'
              : `Re-freezes the plan: the order takes “${after.slice(0, 80)}” at its current name and price.`,
          );
          continue;
        }
        const before: unknown = Object.fromEntries(Object.entries(current))[field];
        rows.push({
          key: `order.${field}`,
          label,
          before: shown(property, before),
          after: shown(property, value),
        });
      }
      const form = formPayload(lead.payload);
      for (const [key, value] of Object.entries(changes.form ?? {})) {
        const property = propertyOf('form', key);
        // Only a field the lead page lets staff edit; the store checks the value again.
        // A sensitive one is masked on the lead page, so it is never shown or edited here.
        if (!property?.editable || property.sensitive)
          return { status: 'invalid', field: `form.${key}` };
        rows.push({
          key: `form.${key}`,
          label: (property?.label ?? key).slice(0, 160),
          before: shown(property, form[key]),
          after: shown(property, value),
        });
      }
      const custom = objectOf(lead.customValues);
      for (const [key, value] of Object.entries(changes.customValues ?? {})) {
        const property = propertyOf('custom', key);
        // The site's catalogue decides the custom keys (a hidden one is not in `forType`);
        // a sensitive one is masked on the lead page, so it is never shown or edited here.
        if (!property || property.sensitive) return { status: 'invalid', field: `custom.${key}` };
        rows.push({
          key: `custom.${key}`,
          label: (property?.label ?? key).slice(0, 160),
          before: shown(property, custom[key]),
          after: shown(property, value),
        });
      }
      // An order detail typed on the card fills its input rather than adding a row twice.
      const unchanged = rows.filter((row) => row.key === 'stage' || row.before !== row.after);
      if (unchanged.length === 0 && needs === undefined) return { status: 'no_change' };
      return {
        status: 'ready',
        context: { rows: unchanged.slice(0, 40), inputs, ...(needs ? { needs } : {}) },
        sideEffects: sideEffects.slice(0, 20),
        version: leadEditVersion(lead, changes),
      };
    });
  }

  confirmLeadEdit(
    input: WriteScope & {
      leadId: string;
      changes: AiLeadEditChanges;
      catalog: PropertyCatalog;
      creationId: string;
      aiCardId?: string;
      version: string;
      sideEffects?: string;
    },
  ): Promise<AiLeadEditConfirmOutcome> {
    const queued: string[] = [];
    return this.database
      .withTenantTx(input, async (tx): Promise<AiLeadEditConfirmOutcome> => {
        const lead: LockedLead | undefined = await lockLead(tx, input.workspaceId, input.leadId);
        if (!lead) return { status: 'not_found' };
        // A retry (a lost response, a second tab) finds the receipt under the lead lock.
        const [receipt] = await tx
          .select({ id: auditEvents.id })
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.workspaceId, input.workspaceId),
              eq(auditEvents.id, input.creationId),
              eq(auditEvents.actorId, input.actorId),
              eq(auditEvents.entityId, input.leadId),
              eq(auditEvents.action, 'ai.lead_edited'),
            ),
          );
        if (receipt) return { status: 'saved', recordId: input.leadId };
        if (lead.trashed) return { status: 'trashed' };
        // C4: anything the card touches changed since it was prepared.
        if (leadEditVersion(lead, input.changes) !== input.version) return { status: 'conflict' };
        // C3: the move would now set off something the card did not show.
        const { stage } = input.changes;
        if (stage !== undefined && stage !== lead.stage) {
          const effects = await stageMoveEffects(tx, input.workspaceId, lead, stage);
          if (input.sideEffects === undefined || sideEffectsDigest(effects) !== input.sideEffects)
            return { status: 'conflict' };
        }
        // C2: the signed draft is parsed with the staff route's own request schema.
        const body = updateWorkspaceLeadRequestSchema.safeParse(input.changes);
        if (!body.success) return { status: 'invalid', field: 'changes' };
        if (body.data.documentsOverrideReason !== undefined || body.data.contact !== undefined)
          return { status: 'invalid', field: 'changes' };
        const outcome = await applyLeadUpdate(
          tx,
          { emailEnvironment: this.emailEnvironment, aiActionId: input.creationId, queued },
          {
            workspaceId: input.workspaceId,
            actorId: input.actorId,
            requestId: input.requestId,
            leadId: input.leadId,
            catalog: input.catalog,
            ...(body.data.stage === undefined ? {} : { stage: body.data.stage }),
            ...(body.data.order === undefined ? {} : { order: body.data.order }),
            ...(body.data.form === undefined ? {} : { form: body.data.form }),
            ...(body.data.customValues === undefined
              ? {}
              : { customValues: body.data.customValues }),
          },
        );
        // Throwing rolls back any partial work (a rescue's freeze included).
        if (outcome.status !== 'updated') throw new LeadEditRefused(outcome);
        await tx.insert(auditEvents).values({
          id: input.creationId,
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          actorLabel: 'staff actor',
          action: 'ai.lead_edited',
          entity: 'lead',
          entityId: input.leadId,
          requestId: input.requestId,
          // Which parts changed, never a value.
          after: {
            parts: Object.keys(input.changes).sort(),
            ...(input.aiCardId ? { aiCardId: input.aiCardId } : {}),
          },
        });
        return { status: 'saved', recordId: input.leadId };
      })
      .then(async (outcome) => {
        // ENG-5: the move's flows run once the confirmation has committed.
        if (outcome.status === 'saved' && queued.length > 0) {
          await runQueuedStarts(
            this.database,
            {
              workspaceId: input.workspaceId,
              actorId: input.actorId,
              requestId: input.requestId,
              environment: this.emailEnvironment,
              catalog: input.catalog,
            },
            queued,
          );
        }
        return outcome;
      })
      .catch((error: unknown): AiLeadEditConfirmOutcome => {
        if (error instanceof LeadEditRefused) return { status: 'refused', refusal: error.outcome };
        throw error;
      });
  }
}
