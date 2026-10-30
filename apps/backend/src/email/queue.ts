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
  type AutomationKey,
  type CustomerEmailJobPayload,
  type LeadActivity,
} from '@gt-sales/contracts';

import { toLeadActivity } from '../leads/staff-queries.js';

/**
 * Queues a composed customer mail as one `lead_customer_email` outbox job, in
 * the caller's tenant transaction, and records it: for a lead, a
 * `customer_emailed` timeline entry and a `lead.customer_emailed` audit event
 * naming the template, its version and the rule that sent it (null when staff
 * did); for a staff test, an `email.test_sent` audit event. The address and
 * the mail's words live only in the job's payload. A dedupe key already used
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
    /** The rule that sends it; null when staff send it by hand. */
    automation: AutomationKey | null;
  },
): Promise<{ queued: boolean; jobId: string | null; activity: LeadActivity | null }> {
  const { payload } = input;
  if ((payload.leadId ?? null) !== input.leadId) {
    throw new Error('the composed mail is for a different lead');
  }

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

  const [entry] = await tx
    .insert(leadActivities)
    .values({
      workspaceId: input.workspaceId,
      leadId: input.leadId,
      actorId: input.actorId,
      kind: 'system',
      data: {
        event: 'customer_emailed',
        template: payload.template,
        templateVersion: payload.templateVersion,
        ...(input.automation ? { automation: input.automation } : {}),
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
      automation: input.automation,
    },
  });
  return {
    queued: true,
    jobId: job.id,
    activity: toLeadActivity({ ...entry, createdAt: entry.createdAt.toISOString() }),
  };
}
