import { and, eq } from 'drizzle-orm';
import {
  auditEvents,
  leadActivities,
  leads,
  outboxJobs,
  type TenantTransaction,
} from '@gt-sales/db';
import {
  CUSTOMER_EMAIL_JOB_TYPE,
  isSiteTemplateKey,
  type AutomationKey,
  type CustomerEmailJobPayload,
  type LeadActivity,
} from '@gt-sales/contracts';

import { toLeadActivity } from '../leads/staff-queries.js';
import { keptMailText } from './kept-text.js';
import { loadReplyAddressing, type ReplyAddressing } from './reply-address.js';

let cachedReplies: { value: ReplyAddressing | undefined } | undefined;
/** Reply addressing from the environment, read once per process. */
function replies(): ReplyAddressing | undefined {
  cachedReplies ??= { value: loadReplyAddressing() };
  return cachedReplies.value;
}
/** Test helper: read the reply settings again on the next mail. */
export function resetReplyAddressingForTests(): void {
  cachedReplies = undefined;
}

/** The flow a mail is queued for: what the timeline and the audit name. */
export interface QueuedByAutomation {
  key: AutomationKey;
  name: string;
  version: number;
  runId: string;
}

/**
 * Queues a composed customer mail as one `lead_customer_email` outbox job, in
 * the caller's tenant transaction, and records it: for a lead, a
 * `customer_emailed` timeline entry and a `lead.customer_emailed` audit event
 * naming the template, its version and the flow that sent it (null when staff
 * did: the entry carries the flow's key and name, and a site-made template's
 * name; the audit `{ key, version, runId }`); for a staff test, an
 * `email.test_sent` audit event. The address lives
 * only in the job's payload; a lead's mail also keeps its subject and text on
 * the timeline entry (`keptMailText`), for the lead's Mail tab. A dedupe key already used
 * for the site queues nothing and records nothing (`queued: false`).
 */
export async function queueComposedEmail(
  tx: TenantTransaction,
  input: {
    workspaceId: string;
    actorId: string;
    requestId: string;
    /** The lead the mail is to; null for a staff test. */
    leadId: string | null;
    dedupeKey: string;
    payload: CustomerEmailJobPayload;
    /** The flow that sends it (its key, name, version and run); null when staff send it by hand. */
    automation: QueuedByAutomation | null;
    /** The template as staff read it; written on the entry for a site-made (`tpl_`) template. */
    templateName?: string;
    aiActionId?: string;
    /** The AI card that confirmed it, a version of `aiActionId`'s draft. */
    aiCardId?: string;
  },
): Promise<{ queued: boolean; jobId: string | null; activity: LeadActivity | null }> {
  if ((input.payload.leadId ?? null) !== input.leadId) {
    throw new Error('the composed mail is for a different lead');
  }
  // A mail to a lead answers to the lead's own reply address, so the
  // customer's reply comes back to its conversation (reply-address.ts).
  const replyTo =
    input.leadId === null ? undefined : replies()?.addressFor(input.workspaceId, input.leadId);
  const payload: CustomerEmailJobPayload = replyTo
    ? { ...input.payload, sender: { ...input.payload.sender, replyToAddress: replyTo } }
    : input.payload;

  const [job] = await tx
    .insert(outboxJobs)
    .values({
      workspaceId: input.workspaceId,
      jobType: CUSTOMER_EMAIL_JOB_TYPE,
      dedupeKey: input.dedupeKey,
      payload,
    })
    .onConflictDoNothing({
      target: [outboxJobs.workspaceId, outboxJobs.jobType, outboxJobs.dedupeKey],
    })
    .returning({ id: outboxJobs.id });
  if (!job) return { queued: false, jobId: null, activity: null };

  const actorLabel = input.automation ? 'automation' : 'staff actor';
  if (input.leadId === null) {
    await tx.insert(auditEvents).values({
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      actorLabel,
      action: 'email.test_sent',
      entity: 'outbox_job',
      entityId: job.id,
      requestId: input.requestId,
      after: {
        template: payload.template,
        templateVersion: payload.templateVersion,
        jobId: job.id,
      },
    });
    return { queued: true, jobId: job.id, activity: null };
  }

  const kept = keptMailText(payload.rendered);
  const [entry] = await tx
    .insert(leadActivities)
    .values({
      workspaceId: input.workspaceId,
      leadId: input.leadId,
      actorId: input.actorId,
      kind: 'system',
      // What was written, for the lead's Mail tab. It sits in `body` with the
      // notes, so erasing the customer's data removes it the same way.
      body: kept.body,
      data: {
        event: 'customer_emailed',
        jobId: job.id,
        ...(kept.cut ? { textCut: true } : {}),
        ...(input.aiActionId && !input.automation ? { viaAi: true } : {}),
        template: payload.template,
        templateVersion: payload.templateVersion,
        ...(input.automation
          ? { automation: input.automation.key, automationName: input.automation.name }
          : {}),
        ...(isSiteTemplateKey(payload.template) && input.templateName
          ? { templateName: input.templateName }
          : {}),
      },
    })
    .returning({
      id: leadActivities.id,
      actorId: leadActivities.actorId,
      kind: leadActivities.kind,
      body: leadActivities.body,
      data: leadActivities.data,
      createdAt: leadActivities.createdAt,
    });
  if (!entry) throw new Error('activity insert did not return a row');
  if (input.automation === null) {
    // Writing to the customer by hand is work on the lead: it moves up the inbox.
    await tx
      .update(leads)
      .set({ updatedAt: new Date() })
      .where(and(eq(leads.workspaceId, input.workspaceId), eq(leads.id, input.leadId)));
  }
  await tx.insert(auditEvents).values({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    actorLabel,
    action: 'lead.customer_emailed',
    entity: 'lead',
    entityId: input.leadId,
    requestId: input.requestId,
    after: {
      template: payload.template,
      templateVersion: payload.templateVersion,
      jobId: job.id,
      ...(input.aiActionId ? { aiActionId: input.aiActionId } : {}),
      ...(input.aiCardId ? { aiCardId: input.aiCardId } : {}),
      automation: input.automation
        ? {
            key: input.automation.key,
            version: input.automation.version,
            runId: input.automation.runId,
          }
        : null,
    },
  });
  return {
    queued: true,
    jobId: job.id,
    // Just queued: the outbox has not picked it up yet.
    activity: toLeadActivity({
      ...entry,
      createdAt: entry.createdAt.toISOString(),
      mailStatus: 'queued',
    }),
  };
}
