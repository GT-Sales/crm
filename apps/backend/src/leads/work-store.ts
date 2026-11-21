import { createHash } from 'node:crypto';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import {
  outboxJobs,
  auditEvents,
  leadActivities,
  leads,
  leadTasks,
  withTenantTx,
  type DatabaseClient,
} from '@gt-sales/db';
import {
  customerEmailJobPayloadSchema,
  codePropertyCatalog,
  emailTemplateLabel,
  allowedStageMoves,
  leadStageLabel,
  type AiActionDraft,
  leadTypeEntry,
  type EmailFillInName,
  type LeadActivity,
  type LeadAssigneeFilter,
  type LeadDetail,
  type LeadPropertyFilter,
  type LeadTaskStatus,
  type PropertyCatalog,
  type TaskAssigneeFilter,
  type TaskStatusFilter,
} from '@gt-sales/contracts';
import { runQueuedStarts } from '../automations/engine.js';
import { automationLeadOf } from '../automations/run.js';
import { renderPlainCustomerEmail } from '../email/layout.js';
import { composeCustomerEmail } from '../email/compose.js';
import { queueComposedEmail } from '../email/queue.js';
import {
  resolveSiteSender,
  customerEmailEnvironmentFromEnv,
  type CustomerEmailEnvironment,
} from '../email/senders.js';
import { findMissingDocuments } from './documents-check.js';
import { toLeadOrder } from './order.js';
import { planStageMove, todayInToronto } from './stage-move.js';
import { isClosingStage } from './types.js';
import {
  DatabasePlainTaskSchemaProbe,
  isNotNullViolation,
  type PlainTaskSchemaProbe,
} from './task-schema.js';
import {
  iso,
  selectLeadBoard,
  selectLeadDetail,
  selectLeadStats,
  selectLeadSummary,
  selectLeadWithWork,
  selectWorkspaceTasks,
  toLeadActivity,
  type ActivityRow,
  type LeadFilters,
} from './staff-queries.js';
import type { Scope, WriteScope } from '../tenant-scope.js';
import { cancelLeadWork } from '../automations/records.js';
import {
  type AiLeadUpdateConfirmOutcome,
  type AiLeadUpdateDraft,
  type AiLeadUpdatePreview,
  AiLeadUpdateRefused,
  type AiMailChange,
  type AiTaskUpdateConfirmOutcome,
  type AiTaskUpdatePreview,
  type AiTemplateEmailPreview,
  type ArchiveLeadOutcome,
  type CreatePlainTaskInput,
  type CreateTaskInput,
  type CustomerEmailOutcome,
  type LeadWorkStore,
  type NoteOutcome,
  type PlainTaskOutcome,
  type QueueCustomerEmailInput,
  type TaskOutcome,
  type UpdateLeadWorkInput,
  type UpdateLeadWorkOutcome,
  type UpdateTaskInput,
} from './work-types.js';
import {
  ACTIVITY_RETURNING,
  TASK_VERSION,
  applyLeadUpdate,
  applyTaskUpdate,
  insertLeadTask,
  insertedActivities,
  insertedActivity,
  isActiveMember,
  isLeadTaskStatus,
  lockLead,
  lockTask,
  newestFirst,
  requireDetail,
  requireTask,
} from './work-writes.js';

/**
 * Staff working a lead: the lead page's reads and every write a staff member
 * makes (stage, assignee, contact corrections, order details, notes, tasks,
 * archive). Each write runs in one tenant transaction that locks the lead,
 * records what changed on the append-only timeline, and writes an audit
 * event. Neither the
 * timeline nor the audit trail stores contact values or note text a second
 * time: an edit records the field names, a note's audit event its id.
 */

export type { Scope, WriteScope };

/** A rendered mail's digest: subject, text and HTML, as the outbox would send them. */
export function renderedMailDigest(rendered: {
  subject: string;
  text: string;
  html: string;
}): string {
  return createHash('sha256')
    .update(JSON.stringify([rendered.subject, rendered.text, rendered.html]))
    .digest('hex');
}

// `isClosingStage` lives with the lead-type registry, which the lead store reads too.
export { isClosingStage };

/**
 * A lead field's value as an AI card carries it (ACT-5): a digest, so the
 * bearer token never holds the customer's name or phone, and confirmation
 * can still tell whether the value changed since the card was prepared.
 */
export function aiLeadValueDigest(value: string | null | undefined): string {
  return createHash('sha256')
    .update(JSON.stringify(value ?? null))
    .digest('hex');
}

type LeadDatabase = Pick<DatabaseClient, 'withTenantTx'>;

const defaultLeadDatabase: LeadDatabase = { withTenantTx };

export class DatabaseLeadWorkStore implements LeadWorkStore {
  constructor(
    private readonly database: LeadDatabase = defaultLeadDatabase,
    /** What customer mail needs from the deployment: the provider and the hash secret. */
    private readonly emailEnvironment: CustomerEmailEnvironment = customerEmailEnvironmentFromEnv(),
    /** Whether the database takes plain tasks (migration 0038); asked, then cached. */
    private readonly plainTaskSchema: PlainTaskSchemaProbe = new DatabasePlainTaskSchemaProbe(),
  ) {}

  summary(input: Scope & { dueBy?: string }) {
    return this.database.withTenantTx(input, (tx) => selectLeadSummary(tx, input.dueBy));
  }

  stats(input: Scope & { leadType: string; days?: number }) {
    const lost = leadTypeEntry(input.leadType)?.outcomes?.lost.stages ?? [];
    return this.database.withTenantTx(input, (tx) =>
      selectLeadStats(tx, { leadType: input.leadType, days: input.days, lost }),
    );
  }

  board(
    input: Scope & {
      leadType: string;
      assignee?: LeadAssigneeFilter;
      search?: string;
      where?: readonly LeadPropertyFilter[];
      catalog: PropertyCatalog;
    },
    perStage: number,
  ) {
    const filters: LeadFilters & { leadType: string } = {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      leadType: input.leadType,
      assignee: input.assignee,
      search: input.search,
      where: input.where,
      catalog: input.catalog,
    };
    return this.database.withTenantTx(input, (tx) => selectLeadBoard(tx, filters, perStage));
  }

  getLead(input: Scope & { leadId: string; includeWork: boolean; catalog: PropertyCatalog }) {
    return this.database.withTenantTx(input, async (tx) => {
      if (input.includeWork) {
        return selectLeadWithWork(tx, input.workspaceId, input.leadId, input.catalog);
      }
      const detail = await selectLeadDetail(tx, input.workspaceId, input.leadId, input.catalog);
      if (!detail) return undefined;
      // Custom values and the order travel with contact visibility, as the form does.
      const { customValues: _customValues, order: _order, ...rest } = detail;
      const lead: LeadDetail = rest;
      return {
        lead,
        activities: [],
        tasks: [],
        related: [],
        identities: [],
        documents: [],
        changeRequest: null,
      };
    });
  }

  async updateLead(input: UpdateLeadWorkInput): Promise<UpdateLeadWorkOutcome> {
    const queued: string[] = [];
    const outcome = await this.database.withTenantTx(input, (tx) =>
      applyLeadUpdate(tx, { emailEnvironment: this.emailEnvironment, queued }, input),
    );
    return this.afterQueuedFlows(input, outcome, queued);
  }

  /**
   * ENG-5: the flows a committed move started run now, each in its own
   * transaction, and the response carries what they wrote and the lead as
   * they left it. A flow that fails here is retried by the scheduler.
   */
  private async afterQueuedFlows(
    input: WriteScope & { leadId: string; catalog: PropertyCatalog },
    outcome: UpdateLeadWorkOutcome,
    queued: readonly string[],
  ): Promise<UpdateLeadWorkOutcome> {
    if (outcome.status !== 'updated' || queued.length === 0) return outcome;
    const ran = await runQueuedStarts(
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
    const lead = await this.database.withTenantTx(input, (tx) =>
      requireDetail(tx, input.workspaceId, input.leadId, input.catalog),
    );
    const emailSkipped = [...(outcome.emailSkipped ?? []), ...ran.skipped].slice(0, 200);
    return {
      ...outcome,
      lead,
      activities: newestFirst([...outcome.activities, ...ran.activities]),
      ...(emailSkipped.length > 0 ? { emailSkipped } : {}),
    };
  }

  markOpened(
    input: WriteScope & { leadId: string },
  ): Promise<{ status: 'opened'; activity: LeadActivity | null } | { status: 'not_found' }> {
    return this.database.withTenantTx(input, async (tx) => {
      // Locked, so two people opening the lead at once write one entry.
      const lead = await lockLead(tx, input.workspaceId, input.leadId);
      if (!lead) return { status: 'not_found' };
      // Opening is not work on the lead: `updated_at` (the inbox's order) stays.
      const inserted = await tx.execute<ActivityRow>(sql`
        insert into app.lead_activities (workspace_id, lead_id, actor_id, kind, data)
        select ${input.workspaceId}::uuid, ${input.leadId}::uuid, ${input.actorId}::uuid,
               'system', '{"event":"opened"}'::jsonb
        where not exists (
          select 1 from app.lead_activities opened
          where opened.workspace_id = ${input.workspaceId}
            and opened.lead_id = ${input.leadId}
            and opened.kind = 'system'
            and opened.data ->> 'event' = 'opened'
        )
        returning id, actor_id as "actorId", kind, body, data, ${iso('created_at')} as "createdAt"
      `);
      const [row] = inserted;
      return { status: 'opened', activity: row ? toLeadActivity(row) : null };
    });
  }

  setArchived(
    input: WriteScope & {
      leadId: string;
      archived: boolean;
      creationId?: string;
      aiCardId?: string;
    },
  ): Promise<ArchiveLeadOutcome> {
    return this.database.withTenantTx(input, async (tx): Promise<ArchiveLeadOutcome> => {
      const lead = await lockLead(tx, input.workspaceId, input.leadId);
      if (!lead) return { status: 'not_found' };
      if (input.creationId !== undefined) {
        const [receipt] = await tx.execute<{ id: string }>(sql`
          select a.id from app.audit_events a
          where a.workspace_id = ${input.workspaceId}
            and a.entity_id = ${input.leadId}
            and a.actor_id = ${input.actorId}
            and a.action in ('lead.trashed', 'lead.restored')
            and a.after ->> 'aiActionId' = ${input.creationId}
          limit 1
        `);
        if (receipt)
          return {
            status: 'unchanged',
            lead: await requireDetail(tx, input.workspaceId, input.leadId),
            activity: null,
            replayed: true,
          };
      }
      if (lead.trashed === input.archived) {
        return {
          status: 'unchanged',
          lead: await requireDetail(tx, input.workspaceId, input.leadId),
          activity: null,
        };
      }

      // Archiving is a visibility change, not work on the lead, so
      // `updated_at` (the inbox's order) is left alone and a restored lead
      // returns to its old place. Stored names stay `trashed`/`restored`.
      await tx
        .update(leads)
        .set({ deletedAt: input.archived ? new Date() : null })
        .where(and(eq(leads.workspaceId, input.workspaceId), eq(leads.id, input.leadId)));
      // Its flows' waits and timers end with it; a restore does not revive them.
      if (input.archived) await cancelLeadWork(tx, input.workspaceId, input.leadId);
      const [entry] = await tx
        .insert(leadActivities)
        .values({
          workspaceId: input.workspaceId,
          leadId: input.leadId,
          actorId: input.actorId,
          kind: 'system',
          data: {
            event: input.archived ? 'trashed' : 'restored',
            ...(input.creationId === undefined ? {} : { viaAi: true }),
          },
        })
        .returning(ACTIVITY_RETURNING);
      if (!entry) throw new Error('activity insert did not return a row');
      await tx.insert(auditEvents).values({
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        actorLabel: 'staff actor',
        action: input.archived ? 'lead.trashed' : 'lead.restored',
        entity: 'lead',
        entityId: input.leadId,
        requestId: input.requestId,
        before: { trashed: lead.trashed },
        after: {
          trashed: input.archived,
          ...(input.creationId === undefined ? {} : { aiActionId: input.creationId }),
          ...(input.aiCardId === undefined ? {} : { aiCardId: input.aiCardId }),
        },
      });

      const [activity] = insertedActivities([entry]);
      return {
        status: 'changed',
        lead: await requireDetail(tx, input.workspaceId, input.leadId),
        activity: activity ?? null,
      };
    });
  }

  previewAiLeadUpdate(
    input: Scope & { leadId: string; field: AiLeadUpdateDraft['field'] },
  ): Promise<AiLeadUpdatePreview | undefined> {
    return this.database.withTenantTx(input, async (tx) => {
      await tx.execute(sql`set local statement_timeout = '5s'`);
      const [row] = await tx
        .select({
          stage: leads.stage,
          leadType: leads.leadType,
          assignedActorId: leads.assignedActorId,
          fullName: leads.fullName,
          phone: leads.phone,
          orderDetails: leads.orderDetails,
          version: sql<string>`updated_at::text`,
        })
        .from(leads)
        .where(
          and(
            eq(leads.workspaceId, input.workspaceId),
            eq(leads.id, input.leadId),
            sql`${leads.deletedAt} is null`,
            sql`${leads.customerDataRestrictedAt} is null`,
          ),
        );
      if (!row) return undefined;
      const before = row[input.field];
      const choices: AiLeadUpdatePreview['choices'] = [];
      if (input.field === 'stage') {
        // Each move is planned exactly as a confirmation would plan it (no
        // order edit, no override), so a gate the assistant cannot satisfy is
        // named before a card is made rather than refused after Confirm.
        const current = toLeadOrder(row.orderDetails);
        const today = todayInToronto(new Date());
        let missing: string[] | undefined;
        for (const value of allowedStageMoves(row.leadType, row.stage)) {
          const choice: AiLeadUpdatePreview['choices'][number] = {
            value,
            label: leadStageLabel(row.leadType, value),
          };
          const move = planStageMove({
            leadType: row.leadType,
            from: row.stage,
            to: value,
            current,
            edit: undefined,
            today,
          });
          if (!move.ok) {
            if (move.refusal.status === 'dispatch_details_required')
              choice.needs = 'dispatch_details';
            else if (move.refusal.status === 'activation_details_required')
              choice.needs = 'activation_details';
          } else if (move.gates.includes('documents')) {
            missing ??= await findMissingDocuments(tx, {
              workspaceId: input.workspaceId,
              leadId: input.leadId,
              required: current.plan?.requiredDocuments ?? [],
            });
            if (missing.length > 0) {
              choice.needs = 'documents';
              choice.missingDocuments = [...missing];
            }
          }
          choices.push(choice);
        }
      }
      return {
        version: row.version,
        before,
        beforeLabel:
          input.field === 'stage'
            ? leadStageLabel(row.leadType, row.stage)
            : (before ?? 'Unassigned / not recorded'),
        choices,
      };
    });
  }

  confirmAiLeadUpdate(
    input: WriteScope & {
      draft: AiLeadUpdateDraft;
      creationId: string;
      before: string;
      aiCardId?: string;
      catalog?: PropertyCatalog;
    },
  ): Promise<AiLeadUpdateConfirmOutcome> {
    const queued: string[] = [];
    const { catalog = codePropertyCatalog, ...scope } = input;
    return this.database
      .withTenantTx(input, async (tx): Promise<AiLeadUpdateConfirmOutcome> => {
        const lead = await lockLead(tx, input.workspaceId, input.draft.leadId);
        if (!lead) return { status: 'not_found' };
        if (lead.trashed) return { status: 'trashed' };
        const [receipt] = await tx
          .select({ id: auditEvents.id })
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.workspaceId, input.workspaceId),
              eq(auditEvents.id, input.creationId),
              eq(auditEvents.actorId, input.actorId),
              eq(auditEvents.entityId, input.draft.leadId),
              eq(auditEvents.action, 'ai.lead_updated'),
            ),
          );
        if (receipt) return { status: 'saved', recordId: input.draft.leadId };
        // ACT-3: only a change to the field itself makes the card stale; a
        // note, a task or another card on the lead does not.
        const [row] = await tx
          .select({
            stage: leads.stage,
            assignedActorId: leads.assignedActorId,
            fullName: leads.fullName,
            phone: leads.phone,
          })
          .from(leads)
          .where(and(eq(leads.workspaceId, input.workspaceId), eq(leads.id, input.draft.leadId)));
        if (!row || aiLeadValueDigest(row[input.draft.field]) !== input.before)
          return { status: 'conflict' };
        const { field, value } = input.draft;
        if (field === 'assignedActorId' && value !== null && !z.uuid().safeParse(value).success)
          return { status: 'invalid' };
        if (
          (field !== 'assignedActorId' && value === null) ||
          (field === 'phone' && (value?.length ?? 0) > 40)
        )
          return { status: 'invalid' };
        const outcome = await applyLeadUpdate(
          tx,
          { emailEnvironment: this.emailEnvironment, aiActionId: input.creationId, queued },
          {
            ...scope,
            leadId: input.draft.leadId,
            catalog,
            ...(field === 'stage' && value !== null ? { stage: value } : {}),
            ...(field === 'assignedActorId' ? { assignedActorId: value } : {}),
            ...(field === 'fullName' && value !== null ? { contact: { fullName: value } } : {}),
            ...(field === 'phone' && value !== null ? { contact: { phone: value } } : {}),
          },
        );
        // Throwing rolls back any partial work (a rescue's freeze included);
        // the refusal itself is returned below, not swallowed.
        if (outcome.status !== 'updated') throw new AiLeadUpdateRefused(outcome);
        await tx.insert(auditEvents).values({
          id: input.creationId,
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          actorLabel: 'staff actor',
          action: 'ai.lead_updated',
          entity: 'lead',
          entityId: input.draft.leadId,
          requestId: input.requestId,
          after: { field, ...(input.aiCardId ? { aiCardId: input.aiCardId } : {}) },
        });
        return { status: 'saved', recordId: input.draft.leadId };
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
              catalog,
            },
            queued,
          );
        }
        return outcome;
      })
      .catch((error: unknown): AiLeadUpdateConfirmOutcome => {
        if (error instanceof AiLeadUpdateRefused)
          return { status: 'refused', refusal: error.outcome };
        throw error;
      });
  }

  aiCardOf(input: Scope & { rootId: string }): Promise<string | null> {
    return this.database.withTenantTx(input, async (tx) => {
      const [row] = await tx.execute<{ card: string | null }>(sql`
        select after ->> 'aiCardId' as card from app.audit_events
        where workspace_id = ${input.workspaceId}
          and action in ('ai.lead_updated', 'ai.task_updated', 'ai.lead_edited', 'lead.note_added', 'lead.task_created', 'lead.customer_emailed', 'lead.trashed', 'lead.restored', 'automation.toggled')
          and (id::text = ${input.rootId} or after ->> 'aiActionId' = ${input.rootId})
        order by created_at
        limit 1
      `);
      return row?.card ?? null;
    });
  }

  previewAiEmail(
    input: WriteScope & { leadId: string },
  ): Promise<{ toAddress: string; fromAddress: string } | undefined> {
    return this.database.withTenantTx(input, async (tx) => {
      if (!this.emailEnvironment.providerReady) return undefined;
      await tx.execute(sql`set local statement_timeout = '5s'`);
      const [lead] = await tx
        .select({ email: leads.email })
        .from(leads)
        .where(
          and(
            eq(leads.workspaceId, input.workspaceId),
            eq(leads.id, input.leadId),
            sql`${leads.deletedAt} is null`,
            sql`${leads.customerDataRestrictedAt} is null`,
          ),
        );
      const site = await resolveSiteSender(tx, input.workspaceId);
      const toAddress = customerEmailJobPayloadSchema.shape.toAddress.safeParse(
        lead?.email?.trim(),
      );
      return site && toAddress.success
        ? { toAddress: toAddress.data, fromAddress: site.sender.fromAddress }
        : undefined;
    });
  }

  queueAiEmail(
    input: WriteScope & {
      leadId: string;
      creationId: string;
      aiCardId?: string;
      draft: Extract<AiActionDraft, { kind: 'email' }>;
      emailContext: { toAddress: string; fromAddress: string };
    },
  ): Promise<
    | { status: 'queued'; recordId: string }
    | { status: 'not_found' | 'trashed' | 'no_sender' | 'missing' }
    | { status: 'changed'; reason: AiMailChange }
  > {
    return this.database.withTenantTx(input, async (tx) => {
      const lead = await lockLead(tx, input.workspaceId, input.leadId);
      if (!lead) return { status: 'not_found' };
      if (lead.trashed) return { status: 'trashed' };
      const dedupeKey = `ai_email:${input.creationId}`;
      const [existing] = await tx
        .select({ id: outboxJobs.id })
        .from(outboxJobs)
        .where(
          and(
            eq(outboxJobs.workspaceId, input.workspaceId),
            eq(outboxJobs.jobType, 'lead_customer_email'),
            eq(outboxJobs.dedupeKey, dedupeKey),
          ),
        );
      if (existing) return { status: 'queued', recordId: existing.id };
      if (!this.emailEnvironment.providerReady) return { status: 'no_sender' };
      const site = await resolveSiteSender(tx, input.workspaceId);
      if (!site) return { status: 'no_sender' };
      if (
        !lead.email ||
        !customerEmailJobPayloadSchema.shape.toAddress.safeParse(lead.email.trim()).success
      )
        return { status: 'missing' };
      if (lead.email.trim() !== input.emailContext.toAddress)
        return { status: 'changed', reason: 'recipient_changed' };
      if (site.sender.fromAddress !== input.emailContext.fromAddress)
        return { status: 'changed', reason: 'sender_changed' };
      const payload = customerEmailJobPayloadSchema.parse({
        leadId: input.leadId,
        // A per-message custom-template transport label; never read as a saved template.
        template: `tpl_${input.creationId.replace(/-/g, '').slice(0, 16)}`,
        templateVersion: 0,
        toAddress: lead.email.trim(),
        contactHash: this.emailEnvironment.contactHash(lead.email.trim()),
        sender: site.sender,
        rendered: renderPlainCustomerEmail({
          subject: input.draft.subject,
          body: input.draft.body,
          branding: site.branding,
          siteUrl: site.siteUrl,
        }),
      });
      const queued = await queueComposedEmail(tx, {
        ...input,
        dedupeKey,
        payload,
        automation: null,
        templateName: 'AI email',
        aiActionId: input.creationId,
        ...(input.aiCardId ? { aiCardId: input.aiCardId } : {}),
      });
      if (!queued.jobId) throw new Error('AI email queue did not return a job');
      return { status: 'queued', recordId: queued.jobId };
    });
  }

  /** A message staff wrote in the lead's Mail tab: plain text, to the lead's own address. */
  queueWrittenEmail(
    input: WriteScope & { leadId: string; subject: string; body: string },
  ): Promise<CustomerEmailOutcome> {
    return this.database.withTenantTx(input, async (tx): Promise<CustomerEmailOutcome> => {
      const lead = await lockLead(tx, input.workspaceId, input.leadId);
      if (!lead) return { status: 'not_found' };
      if (lead.trashed) return { status: 'trashed' };
      if (!this.emailEnvironment.providerReady) return { status: 'no_sender' };
      const site = await resolveSiteSender(tx, input.workspaceId);
      if (!site) return { status: 'no_sender' };
      const toAddress = customerEmailJobPayloadSchema.shape.toAddress.safeParse(lead.email?.trim());
      if (!toAddress.success) return { status: 'missing', missing: ['customer email'] };
      const payload = customerEmailJobPayloadSchema.parse({
        leadId: input.leadId,
        // A per-message custom-template transport label; never read as a saved template.
        template: `tpl_${input.requestId.replace(/-/g, '').slice(0, 16)}`,
        templateVersion: 0,
        toAddress: toAddress.data,
        contactHash: this.emailEnvironment.contactHash(toAddress.data),
        sender: site.sender,
        rendered: renderPlainCustomerEmail({
          subject: input.subject,
          body: input.body,
          branding: site.branding,
          siteUrl: site.siteUrl,
        }),
      });
      const queued = await queueComposedEmail(tx, {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        requestId: input.requestId,
        leadId: input.leadId,
        // One mail per request: sending again is a second, deliberate mail.
        dedupeKey: `${input.leadId}:${input.requestId}`,
        payload,
        automation: null,
        templateName: 'Written message',
      });
      if (!queued.activity) throw new Error('this request already queued its mail');
      return { status: 'queued', activity: queued.activity };
    });
  }

  queueCustomerEmail(input: QueueCustomerEmailInput): Promise<CustomerEmailOutcome> {
    return this.database.withTenantTx(input, async (tx): Promise<CustomerEmailOutcome> => {
      const lead = await lockLead(tx, input.workspaceId, input.leadId);
      if (!lead) return { status: 'not_found' };
      if (lead.trashed) return { status: 'trashed' };
      const composed = await composeCustomerEmail(tx, this.emailEnvironment, {
        workspaceId: input.workspaceId,
        template: input.template,
        recipient: { kind: 'lead', lead: automationLeadOf(lead) },
      });
      if (composed.kind === 'skipped') {
        if (composed.reason === 'no_sender') return { status: 'no_sender' };
        if (composed.reason === 'no_customer_email') {
          return { status: 'missing', missing: ['customer email'] };
        }
        return { status: 'missing', missing: composed.missing ?? [] };
      }

      // Sent by the outbox, after this commits; the address lives only in
      // the job, and the mail's words also on its timeline entry (Mail tab).
      const queued = await queueComposedEmail(tx, {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        requestId: input.requestId,
        leadId: input.leadId,
        // One mail per request: sending again is a second, deliberate mail.
        dedupeKey: `${input.leadId}:${input.requestId}`,
        payload: composed.payload,
        automation: null,
      });
      // Request ids are the server's own, fresh per request: a hit is a bug.
      if (!queued.activity) throw new Error('this request already queued its mail');
      return { status: 'queued', activity: queued.activity };
    });
  }

  previewAiTemplateEmail(input: QueueCustomerEmailInput): Promise<AiTemplateEmailPreview> {
    return this.database.withTenantTx(input, async (tx): Promise<AiTemplateEmailPreview> => {
      await tx.execute(sql`set local statement_timeout = '5s'`);
      const lead = await lockLead(tx, input.workspaceId, input.leadId);
      if (!lead || lead.trashed) return { status: 'unavailable' };
      const composed = await composeCustomerEmail(tx, this.emailEnvironment, {
        workspaceId: input.workspaceId,
        template: input.template,
        recipient: { kind: 'lead', lead: automationLeadOf(lead) },
      });
      if (composed.kind === 'skipped') {
        if (composed.reason === 'no_customer_email')
          return { status: 'missing', missing: ['customer email'] };
        if (composed.reason === 'missing_fill_in')
          return { status: 'missing', missing: composed.missing ?? [] };
        return { status: 'unavailable' };
      }
      const { payload } = composed;
      return {
        status: 'ready',
        templateName: emailTemplateLabel(payload.template).slice(0, 80),
        version: payload.templateVersion,
        subject: payload.rendered.subject,
        text: payload.rendered.text,
        toAddress: payload.toAddress,
        fromAddress: payload.sender.fromAddress,
        renderedDigest: renderedMailDigest(payload.rendered),
      };
    });
  }

  queueAiTemplateEmail(
    input: QueueCustomerEmailInput & {
      creationId: string;
      aiCardId?: string;
      version: number;
      renderedDigest: string;
      emailContext: { toAddress: string; fromAddress: string };
    },
  ): Promise<
    | { status: 'queued'; recordId: string }
    | { status: 'not_found' | 'trashed' | 'no_sender' }
    | { status: 'changed'; reason: AiMailChange }
    | { status: 'missing'; missing: Array<EmailFillInName | 'customer email'> }
  > {
    return this.database.withTenantTx(input, async (tx) => {
      const lead = await lockLead(tx, input.workspaceId, input.leadId);
      if (!lead) return { status: 'not_found' as const };
      if (lead.trashed) return { status: 'trashed' as const };
      // C5: its own key on the card's root id, never the request's.
      const dedupeKey = `ai_template_email:${input.creationId}`;
      const [existing] = await tx
        .select({ id: outboxJobs.id })
        .from(outboxJobs)
        .where(
          and(
            eq(outboxJobs.workspaceId, input.workspaceId),
            eq(outboxJobs.jobType, 'lead_customer_email'),
            eq(outboxJobs.dedupeKey, dedupeKey),
          ),
        );
      if (existing) return { status: 'queued' as const, recordId: existing.id };
      const composed = await composeCustomerEmail(tx, this.emailEnvironment, {
        workspaceId: input.workspaceId,
        template: input.template,
        recipient: { kind: 'lead', lead: automationLeadOf(lead) },
      });
      if (composed.kind === 'skipped') {
        if (composed.reason === 'no_sender') return { status: 'no_sender' as const };
        if (composed.reason === 'no_customer_email')
          return { status: 'missing' as const, missing: ['customer email' as const] };
        if (composed.reason === 'missing_fill_in')
          return { status: 'missing' as const, missing: composed.missing ?? [] };
        return { status: 'changed' as const, reason: 'template_changed' as const };
      }
      const { payload } = composed;
      // T7: each cause its own reason, so the card says what changed.
      if (payload.toAddress !== input.emailContext.toAddress)
        return { status: 'changed' as const, reason: 'recipient_changed' as const };
      if (payload.sender.fromAddress !== input.emailContext.fromAddress)
        return { status: 'changed' as const, reason: 'sender_changed' as const };
      if (payload.templateVersion !== input.version)
        return { status: 'changed' as const, reason: 'template_changed' as const };
      if (renderedMailDigest(payload.rendered) !== input.renderedDigest)
        return { status: 'changed' as const, reason: 'text_changed' as const };
      const queued = await queueComposedEmail(tx, {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        requestId: input.requestId,
        leadId: input.leadId,
        dedupeKey,
        payload,
        automation: null,
        aiActionId: input.creationId,
        ...(input.aiCardId ? { aiCardId: input.aiCardId } : {}),
      });
      if (!queued.jobId) throw new Error('AI template email queue did not return a job');
      return { status: 'queued' as const, recordId: queued.jobId };
    });
  }

  addNote(
    input: WriteScope & { leadId: string; body: string; creationId?: string; aiCardId?: string },
  ): Promise<NoteOutcome> {
    return this.database.withTenantTx(input, async (tx) => {
      const lead = await lockLead(tx, input.workspaceId, input.leadId);
      if (!lead) return { status: 'not_found' };
      if (lead.trashed) return { status: 'trashed' };

      if (input.creationId) {
        const [existing] = await tx
          .select(ACTIVITY_RETURNING)
          .from(leadActivities)
          .where(
            and(
              eq(leadActivities.workspaceId, input.workspaceId),
              eq(leadActivities.leadId, input.leadId),
              eq(leadActivities.actorId, input.actorId),
              eq(leadActivities.kind, 'note'),
              eq(leadActivities.id, input.creationId),
            ),
          );
        if (existing) return { status: 'created', activity: insertedActivity(existing) };
      }
      const [entry] = await tx
        .insert(leadActivities)
        .values({
          ...(input.creationId === undefined ? {} : { id: input.creationId }),
          workspaceId: input.workspaceId,
          leadId: input.leadId,
          actorId: input.actorId,
          kind: 'note',
          body: input.body,
          ...(input.creationId ? { data: { viaAi: true } } : {}),
        })
        .returning(ACTIVITY_RETURNING);
      if (!entry) throw new Error('activity insert did not return a row');
      // A note is work on the lead: it moves up the inbox.
      await tx
        .update(leads)
        .set({ updatedAt: new Date() })
        .where(and(eq(leads.workspaceId, input.workspaceId), eq(leads.id, input.leadId)));
      await tx.insert(auditEvents).values({
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        actorLabel: 'staff actor',
        action: 'lead.note_added',
        entity: 'lead',
        entityId: input.leadId,
        requestId: input.requestId,
        after: {
          activityId: entry.id,
          ...(input.creationId === undefined ? {} : { aiActionId: input.creationId }),
          ...(input.aiCardId === undefined ? {} : { aiCardId: input.aiCardId }),
        },
      });

      const [activity] = insertedActivities([entry]);
      if (!activity) throw new Error('note insert did not return its entry');
      return { status: 'created', activity };
    });
  }

  createTask(input: CreateTaskInput): Promise<TaskOutcome> {
    return this.database.withTenantTx(input, async (tx) => {
      const lead = await lockLead(tx, input.workspaceId, input.leadId);
      if (!lead) return { status: 'not_found' };
      if (lead.trashed) return { status: 'trashed' };
      if (input.creationId) {
        const [existing] = await tx
          .select({ id: leadTasks.id })
          .from(leadTasks)
          .where(
            and(
              eq(leadTasks.workspaceId, input.workspaceId),
              eq(leadTasks.leadId, input.leadId),
              eq(leadTasks.createdBy, input.actorId),
              eq(leadTasks.id, input.creationId),
            ),
          );
        if (existing)
          return { status: 'saved', task: await requireTask(tx, input.workspaceId, existing.id) };
      }
      const assignee = input.assignedActorId ?? null;
      if (assignee !== null && !(await isActiveMember(tx, input.workspaceId, assignee))) {
        return { status: 'assignee_not_found' };
      }

      const { taskId } = await insertLeadTask(tx, {
        ...(input.creationId === undefined ? {} : { creationId: input.creationId }),
        ...(input.aiCardId === undefined ? {} : { aiCardId: input.aiCardId }),
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        requestId: input.requestId,
        leadId: input.leadId,
        title: input.title,
        dueAt: input.dueAt ?? null,
        assignedActorId: assignee,
      });
      return { status: 'saved', task: await requireTask(tx, input.workspaceId, taskId) };
    });
  }

  createPlainTask(input: CreatePlainTaskInput): Promise<PlainTaskOutcome> {
    return this.database
      .withTenantTx(input, async (tx): Promise<PlainTaskOutcome> => {
        if (!(await this.plainTaskSchema.ready(tx))) return { status: 'unavailable' };
        if (input.creationId) {
          // No lead to lock: one confirmation at a time per signed card, so a
          // concurrent retry finds the task the first one made.
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`plain_task:${input.creationId}`}, 0))`,
          );
          const [existing] = await tx.execute<{ id: string }>(sql`
            select k.id from app.lead_tasks k
            where k.workspace_id = ${input.workspaceId} and k.id = ${input.creationId}
              and k.created_by = ${input.actorId} and k.lead_id is null
          `);
          if (existing)
            return { status: 'saved', task: await requireTask(tx, input.workspaceId, existing.id) };
        }
        const assignee = input.assignedActorId ?? null;
        if (assignee !== null && !(await isActiveMember(tx, input.workspaceId, assignee))) {
          return { status: 'assignee_not_found' };
        }
        const { taskId } = await insertLeadTask(tx, {
          ...(input.creationId === undefined ? {} : { creationId: input.creationId }),
          ...(input.aiCardId === undefined ? {} : { aiCardId: input.aiCardId }),
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          requestId: input.requestId,
          leadId: null,
          title: input.title,
          dueAt: input.dueAt ?? null,
          assignedActorId: assignee,
        });
        return { status: 'saved', task: await requireTask(tx, input.workspaceId, taskId) };
      })
      .catch((error: unknown): PlainTaskOutcome => {
        // A probe answer cached moments before the column was checked would
        // otherwise be a 500: the database itself says it is not ready.
        if (isNotNullViolation(error)) return { status: 'unavailable' };
        throw error;
      });
  }

  plainTasksReady(input: Scope): Promise<boolean> {
    if (this.plainTaskSchema.knownReady?.() === true) return Promise.resolve(true);
    return this.database.withTenantTx(input, (tx) => this.plainTaskSchema.ready(tx));
  }

  updateTask(input: UpdateTaskInput): Promise<TaskOutcome> {
    return this.database.withTenantTx(input, async (tx) => {
      const current = await lockTask(tx, input.workspaceId, input.taskId);
      if (!current) return { status: 'not_found' };
      if (current.trashed) return { status: 'trashed' };
      return applyTaskUpdate(tx, input, current);
    });
  }

  previewAiTaskUpdate(input: Scope & { taskId: string }): Promise<AiTaskUpdatePreview | undefined> {
    return this.database.withTenantTx(input, async (tx) => {
      await tx.execute(sql`set local statement_timeout = '5s'`);
      const [row] = await tx.execute<{
        [key: string]: unknown;
        version: string;
        title: string;
        status: string;
        leadId: string | null;
        dueDate: string | null;
        assignedActorId: string | null;
      }>(sql`
        select ${TASK_VERSION} as version, k.title, k.status, k.lead_id as "leadId",
          to_char(k.due_at at time zone 'UTC', 'YYYY-MM-DD') as "dueDate",
          k.assigned_actor_id as "assignedActorId"
        from app.lead_tasks k
        left join app.leads l on l.workspace_id = k.workspace_id and l.id = k.lead_id
        where k.workspace_id = ${input.workspaceId}
          and k.id = ${input.taskId}
          and (k.lead_id is null or (l.deleted_at is null and l.customer_data_restricted_at is null))
      `);
      if (!row || !isLeadTaskStatus(row.status)) return undefined;
      return {
        version: row.version,
        title: row.title,
        status: row.status,
        leadId: row.leadId,
        dueDate: row.dueDate,
        assignedActorId: row.assignedActorId,
      };
    });
  }

  confirmAiTaskUpdate(
    input: WriteScope & {
      taskId: string;
      status?: LeadTaskStatus;
      title?: string;
      dueAt?: string | null;
      assignedActorId?: string | null;
      version: string;
      before: LeadTaskStatus;
      creationId: string;
      aiCardId?: string;
    },
  ): Promise<AiTaskUpdateConfirmOutcome> {
    return this.database.withTenantTx(input, async (tx): Promise<AiTaskUpdateConfirmOutcome> => {
      const current = await lockTask(tx, input.workspaceId, input.taskId);
      if (!current) return { status: 'not_found' };
      // A retry (a lost response, a second tab) finds the receipt under the task lock.
      const [receipt] = await tx
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, input.workspaceId),
            eq(auditEvents.id, input.creationId),
            eq(auditEvents.actorId, input.actorId),
            eq(auditEvents.entityId, input.taskId),
            eq(auditEvents.action, 'ai.task_updated'),
          ),
        );
      if (receipt) return { status: 'saved', recordId: input.taskId };
      if (current.trashed) return { status: 'trashed' };
      // Any change to the task since the card was prepared makes the card stale:
      // its update time, or its status alone, which the nightly Get Canada Sim
      // sync changes on imported tasks without touching the update time.
      if (current.version !== input.version || current.status !== input.before)
        return { status: 'conflict' };
      const outcome = await applyTaskUpdate(
        tx,
        {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          requestId: input.requestId,
          taskId: input.taskId,
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
          ...(input.assignedActorId === undefined
            ? {}
            : { assignedActorId: input.assignedActorId }),
          aiActionId: input.creationId,
        },
        current,
      );
      // The one refusal a locked task can give: the assignee is not an active member.
      if (outcome.status === 'assignee_not_found') return { status: 'assignee_not_found' };
      if (outcome.status !== 'saved') throw new Error('a locked task refused a change');
      // The move's receipt, keyed by the draft's root id: a retry returns it.
      await tx.insert(auditEvents).values({
        id: input.creationId,
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        actorLabel: 'staff actor',
        action: 'ai.task_updated',
        entity: 'lead_task',
        entityId: input.taskId,
        requestId: input.requestId,
        before: { status: current.status },
        after: {
          status: input.status ?? current.status,
          ...(input.aiCardId ? { aiCardId: input.aiCardId } : {}),
        },
      });
      return { status: 'saved', recordId: input.taskId };
    });
  }

  listTasks(
    input: Scope & {
      assignee: TaskAssigneeFilter;
      status: TaskStatusFilter;
      dueBy?: string;
      completedSince?: string;
      includePlain?: boolean;
    },
    page: number,
    pageSize: number,
  ) {
    return this.database.withTenantTx(input, (tx) =>
      selectWorkspaceTasks(
        tx,
        {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          assignee: input.assignee,
          status: input.status,
          dueBy: input.dueBy,
          completedSince: input.completedSince,
          includePlain: input.includePlain === true,
        },
        page,
        pageSize,
      ),
    );
  }
}
