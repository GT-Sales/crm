import { createHash } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import {
  auditEvents,
  withTenantTx,
  type DatabaseClient,
  type TenantTransaction,
} from '@gt-sales/db';
import {
  aiLeadEditChangesSchema,
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

/**
 * One step's effect in words, in the present ("sends …") or after "may"
 * ("send …"). A branch is not one of them: `flowRunSentence` reads its steps
 * as ones that may run.
 */
function stepWords(
  step: Exclude<FlowStep, { kind: 'if_else' }>,
  templates: ReadonlyMap<string, string>,
  leadType: string,
  form: 'present' | 'base',
): string {
  const verb = (present: string, base: string) => (form === 'present' ? present : base);
  switch (step.kind) {
    case 'send_email':
      return `${verb('sends', 'send')} the “${templates.get(step.template) ?? emailTemplateLabel(step.template)}” email to the customer`;
    case 'create_task':
      return `${verb('creates', 'create')} a task`;
    case 'assign_lead':
      return `${verb('assigns', 'assign')} the lead`;
    case 'update_lead':
      return step.change.kind === 'stage'
        ? `${verb('moves', 'move')} the lead to ${leadStageLabel(leadType, step.change.stage)}`
        : `${verb('changes', 'change')} a lead property`;
    case 'notify_staff':
      return `${verb('emails', 'email')} staff`;
    case 'wait':
      return `${verb('waits, then continues', 'wait, then continue')}`;
  }
}

/** A flow's steps split into those that always run and those inside a branch, which may. */
function flowStepsByCertainty(steps: readonly FlowStep[]): {
  always: Exclude<FlowStep, { kind: 'if_else' }>[];
  maybe: Exclude<FlowStep, { kind: 'if_else' }>[];
} {
  const always: Exclude<FlowStep, { kind: 'if_else' }>[] = [];
  const maybe: Exclude<FlowStep, { kind: 'if_else' }>[] = [];
  const branchSteps = (entries: readonly FlowStep[]): void => {
    for (const entry of entries) {
      if (entry.kind === 'if_else') {
        branchSteps(entry.then);
        branchSteps(entry.else);
      } else maybe.push(entry);
    }
  };
  for (const step of steps) {
    if (step.kind === 'if_else') {
      branchSteps(step.then);
      branchSteps(step.else);
    } else always.push(step);
  }
  return { always, maybe };
}

/**
 * C3, T3: what one flow does when the move sets it off, in one sentence. The
 * steps that always run read as definite ("sends …"); a branch's steps read
 * as ones that may run, depending on its conditions, since the card cannot
 * know a condition's answer before the move. A flow whose trigger has
 * conditions says it runs only when they match.
 */
export function flowRunSentence(input: {
  name: string;
  conditional: boolean;
  steps: readonly FlowStep[] | undefined;
  templates: ReadonlyMap<string, string>;
  leadType: string;
}): string {
  const name = input.name.slice(0, 80);
  const when = input.conditional ? ' (when its conditions match)' : '';
  const { always, maybe } = flowStepsByCertainty(input.steps ?? []);
  const words = (
    steps: readonly Exclude<FlowStep, { kind: 'if_else' }>[],
    form: 'present' | 'base',
  ) => [...new Set(steps.map((step) => stepWords(step, input.templates, input.leadType, form)))];
  const definite = words(always, 'present');
  const possible = words(maybe, 'base');
  const sentence =
    definite.length === 0 && possible.length === 0
      ? `“${name}”${when} runs: its steps.`
      : definite.length === 0
        ? `“${name}”${when} runs and may, depending on its conditions: ${possible.join(', ')}.`
        : possible.length === 0
          ? `“${name}”${when} runs: ${definite.join(', ')}.`
          : `“${name}”${when} runs: ${definite.join(', ')}; and may, depending on its conditions: ${possible.join(', ')}.`;
  return sentence.slice(0, 300);
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
    runs.push(
      flowRunSentence({
        name,
        conditional: trigger.when !== null,
        steps,
        templates: names,
        leadType: lead.leadType,
      }),
    );
  }
  effects.push(...runs, ...later);
  if (runs.length === 0 && later.length === 0) effects.push('No automation runs for this move.');
  return effects.slice(0, 20);
}

/** An active plan's name for the lead's type, or undefined when there is none by that id. */
async function activePlanName(
  tx: TenantTransaction,
  workspaceId: string,
  leadType: string,
  planId: string,
): Promise<string | undefined> {
  const [plan] = await tx.execute<{ name: string }>(sql`
    select p.name from app.plans p
    where p.workspace_id = ${workspaceId} and p.id = ${planId}
      and p.lead_type = ${leadType} and p.active
  `);
  return plan?.name;
}

/**
 * C3 + B3: everything a lead edit sets off besides its own changes, in words:
 * a stage move's effects (`stageMoveEffects`), then a plan change's re-freeze.
 * The one function the card's preview and its confirmation both call (R1),
 * so the digest signed at prepare is the one recomputed at Confirm. Undefined
 * when the card's plan is no longer an active plan of the lead's type.
 */
export async function leadEditEffects(
  tx: TenantTransaction,
  workspaceId: string,
  lead: { leadType: string; status: string; stage: string },
  changes: AiLeadEditChanges,
): Promise<string[] | undefined> {
  const effects: string[] = [];
  if (changes.stage !== undefined && changes.stage !== lead.stage)
    effects.push(...(await stageMoveEffects(tx, workspaceId, lead, changes.stage)));
  const planId = changes.order?.planId;
  if (planId === null) effects.push('Clears the order’s plan and its frozen price.');
  else if (planId !== undefined) {
    const name = await activePlanName(tx, workspaceId, lead.leadType, planId);
    if (name === undefined) return undefined;
    effects.push(
      `Re-freezes the plan: the order takes “${name.slice(0, 80)}” at its current name and price.`,
    );
  }
  return effects.slice(0, 20);
}

const DAY_LABEL = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** A calendar day as the card shows it ("20 Nov 2026"), "(today)" when it is today in Toronto. */
function dayShown(value: unknown, today: string): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return shown(undefined, value);
  const label = DAY_LABEL.format(new Date(`${value}T12:00:00Z`));
  return value === today ? `${label} (today)` : label;
}

/** The dispatch and activation details each gate's move carries on the card, in card order. */
const GATE_INPUTS: Readonly<
  Record<
    'dispatch' | 'activation',
    readonly { field: AiOrderDetailField; kind: 'text' | 'date'; required: boolean }[]
  >
> = {
  dispatch: [
    { field: 'courier', kind: 'text', required: true },
    { field: 'trackingNumber', kind: 'text', required: false },
    { field: 'dispatchedAt', kind: 'date', required: false },
  ],
  activation: [
    { field: 'activatedAt', kind: 'date', required: false },
    { field: 'activationNumber', kind: 'text', required: false },
    { field: 'activationAccount', kind: 'text', required: false },
  ],
};

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
      /**
       * The changes the card signs: the ones asked for, with the date a gate
       * defaults to today written in (T2), so Confirm saves the day the card
       * showed even after midnight.
       */
      changes: AiLeadEditChanges;
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
      const today = todayInToronto(new Date());
      const rows: AiLeadEditContext['rows'] = [];
      const inputs: AiLeadEditContext['inputs'] = [];
      /** Rows the card keeps although nothing changes: a detail the move requires. */
      const required = new Set<string>();
      let needs: AiStageMoveNeed | undefined;
      // What Confirm will save: the order edit as asked, with a gate's default date written in.
      let signed: AiLeadEditChanges = changes;

      if (changes.stage !== undefined && changes.stage !== lead.stage) {
        if (!isLeadStage(lead.leadType, changes.stage))
          return { status: 'invalid', field: 'stage' };
        const move = planStageMove({
          leadType: lead.leadType,
          from: lead.stage,
          to: changes.stage,
          current,
          edit: changes.order,
          today,
        });
        if (!move.ok) {
          if (move.refusal.status === 'illegal_stage_move')
            return { status: 'illegal_stage_move', allowed: move.refusal.allowed };
          needs =
            move.refusal.status === 'dispatch_details_required'
              ? 'dispatch_details'
              : 'activation_details';
        } else if (move.order !== undefined && move.order !== changes.order) {
          // T2: the date the move defaults to is the card's, signed and shown as that day.
          const withDefaults = aiLeadEditChangesSchema.safeParse({ ...changes, order: move.order });
          if (withDefaults.success) signed = withDefaults.data;
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
        for (const gate of ['dispatch', 'activation'] as const) {
          if (!gates.includes(gate)) continue;
          for (const { field, kind, required: needed } of GATE_INPUTS[gate]) {
            const value = current[field];
            inputs.push({
              field,
              label: ORDER_DETAIL_LABELS[field],
              kind,
              required: needed,
              current: value === null ? null : String(value).slice(0, 200),
            });
            if (needed) required.add(`order.${field}`);
          }
        }
        rows.push({
          key: 'stage',
          label: 'Stage',
          before: leadStageLabel(lead.leadType, lead.stage),
          after: leadStageLabel(lead.leadType, changes.stage),
        });
      }
      const sideEffects = await leadEditEffects(tx, input.workspaceId, lead, signed);
      if (sideEffects === undefined) return { status: 'invalid', field: 'plan' };

      const currentOrder: Record<string, unknown> = Object.fromEntries(Object.entries(current));
      const orderRow = (field: string, value: unknown) => {
        const property = propertyOf('order', field);
        const label = (property?.label ?? ORDER_FIELD_LABELS[field] ?? field).slice(0, 160);
        const date =
          field === 'dispatchedAt' || field === 'activatedAt' || property?.kind === 'date';
        const show = (entry: unknown) => (date ? dayShown(entry, today) : shown(property, entry));
        return {
          key: `order.${field}`,
          label,
          before: show(currentOrder[field]),
          after: show(value),
        };
      };
      for (const [field, value] of Object.entries(signed.order ?? {})) {
        if (value === undefined) continue;
        if (field === 'planId') {
          const label = (propertyOf('order', field)?.label ?? 'Plan').slice(0, 160);
          const after =
            typeof value === 'string'
              ? ((await activePlanName(tx, input.workspaceId, lead.leadType, value)) ?? null)
              : null;
          if (typeof value === 'string' && after === null)
            return { status: 'invalid', field: 'plan' };
          rows.push({
            key: 'order.planId',
            label,
            before: current.plan?.name ?? null,
            after: after?.slice(0, 1000) ?? null,
          });
          continue;
        }
        rows.push(orderRow(field, value));
      }
      // A detail the move requires and the card does not change is still shown, as it will be.
      for (const key of required) {
        const field = key.slice('order.'.length);
        if (!rows.some((row) => row.key === key)) rows.push(orderRow(field, currentOrder[field]));
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
      // T2: a row is on the card only when it changes, or when the move requires it.
      const shownRows = rows.filter(
        (row) => row.key === 'stage' || required.has(row.key) || row.before !== row.after,
      );
      if (shownRows.length === 0 && needs === undefined) return { status: 'no_change' };
      return {
        status: 'ready',
        context: { rows: shownRows.slice(0, 40), inputs, ...(needs ? { needs } : {}) },
        sideEffects,
        version: leadEditVersion(lead, signed),
        changes: signed,
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
        // C3: the edit would now set off something the card did not show,
        // computed by the very function the card's preview used (R1).
        const effects = await leadEditEffects(tx, input.workspaceId, lead, input.changes);
        if (effects === undefined) return { status: 'conflict' };
        if (
          (effects.length > 0 || input.sideEffects !== undefined) &&
          (input.sideEffects === undefined || sideEffectsDigest(effects) !== input.sideEffects)
        )
          return { status: 'conflict' };
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
