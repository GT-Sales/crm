import { sql } from 'drizzle-orm';
import type { EmailAdapter } from '@gt-sales/adapters';
import {
  outboxJobs,
  withTenantTx,
  type DatabaseClient,
  type TenantTransaction,
} from '@gt-sales/db';
import {
  STAFF_NOTIFICATION_JOB_TYPE,
  staffNotificationJobPayloadSchema,
  type FlowStep,
} from '@gt-sales/contracts';
import {
  JobHandlerError,
  type EmailDeliveryRecorder,
  type EmailEligibilityChecker,
  type JobHandler,
  type JobHandlerResult,
} from '@gt-sales/jobs';
import { z } from 'zod';

import { customerEmailEnvironmentFromEnv } from '../email/senders.js';
import type { StepContext, StepResult } from './actions.js';
import { detailOf } from './records.js';

/**
 * The "notify staff" step and its mail (spec §5, O3, R9). The step queues one
 * `staff_notification_email` job per recipient (the lead's assignee when the
 * step asks, and the members it names), carrying the flow, the site and the
 * lead's link but no address and no customer detail (P8); the handler reads
 * the member's sign-in address (`memberships.notification_email`) when it
 * sends, and skips a member who left or never signed in since. The mail comes
 * from the deployment's own sender (`RESEND_FROM_*`), never a site's.
 */

export interface StaffNotificationEnvironment {
  /** The deployment can send staff mail: a provider that can send, its sender and the hash secret. */
  ready: boolean;
  /** The admin's origin, for the link to the lead. */
  adminOrigin: string;
  sender: { fromName: string; fromAddress: string } | null;
  contactHash(address: string): string;
}

const DEFAULT_ADMIN_ORIGIN = 'http://localhost:3000';

/**
 * Ready only with `EMAIL_PROVIDER=resend` and its key and `RESEND_FROM_NAME`
 * / `RESEND_FROM_EMAIL`, or the fake outside production; and the contact
 * hash secret, as every mail needs. `adminOrigin` is `ADMIN_ORIGIN`.
 */
export function staffNotificationEnvironmentFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): StaffNotificationEnvironment {
  const customer = customerEmailEnvironmentFromEnv(env);
  const fromName = env.RESEND_FROM_NAME?.trim();
  const fromAddress = env.RESEND_FROM_EMAIL?.trim();
  const sender = fromName && fromAddress ? { fromName, fromAddress } : null;
  const providerReady =
    env.EMAIL_PROVIDER === 'resend'
      ? Boolean(env.RESEND_API_KEY) && sender !== null
      : env.EMAIL_PROVIDER === 'fake' && env.NODE_ENV !== 'production';
  return {
    ready: providerReady && customer.providerReady,
    adminOrigin: (env.ADMIN_ORIGIN?.trim() || DEFAULT_ADMIN_ORIGIN).replace(/\/+$/, ''),
    sender,
    contactHash: (address) => customer.contactHash(address),
  };
}

/** A member as the step and the mail need them: still active, and the address they signed in with. */
export interface StaffMember {
  active: boolean;
  notificationEmail: string | null;
}

export interface StaffNotificationMembers {
  readMember(input: {
    workspaceId: string;
    actorId: string;
    memberId: string;
  }): Promise<StaffMember | undefined>;
}

const memberRowSchema = z.object({
  status: z.string(),
  notificationEmail: z.string().nullable(),
});

const memberSql = (workspaceId: string, memberId: string) => sql`
  select m.status, m.notification_email as "notificationEmail"
  from app.memberships m
  where m.workspace_id = ${workspaceId} and m.user_id = ${memberId}
    and m.membership_type = 'staff'
  order by (m.status = 'active') desc
  limit 1
`;

function toMember(row: unknown): StaffMember | undefined {
  const parsed = memberRowSchema.safeParse(row);
  if (!parsed.success) return undefined;
  return {
    active: parsed.data.status === 'active',
    notificationEmail: parsed.data.notificationEmail,
  };
}

const NOTE_LINE = /\r?\n/g;

const siteRowSchema = z.object({ slug: z.string().min(1), name: z.string().min(1) });

/**
 * The site's slug and name, for the mail's subject and the lead's link.
 * `app_runtime` has no grant on `app.workspaces`: the one door to them is
 * `app.list_staff_workspaces()`, which lists the sites of the transaction's
 * actor. When the write's actor is no member (a website credential, the
 * scheduler), it is read as one of the site's members (the flow's
 * activator, else a recipient) inside a savepoint that sets `app.actor_id`
 * for that one read and puts it back; the read writes nothing and returns
 * only this site's own row. A follow-up migration should give the runtime a
 * `SECURITY DEFINER` read of the current site instead (Batch 2 report).
 */
async function siteIdentity(
  tx: TenantTransaction,
  workspaceId: string,
  members: readonly string[],
): Promise<{ slug: string; name: string } | undefined> {
  const read = async (reader: TenantTransaction) => {
    const rows = await reader.execute(sql`
      select workspace_slug as slug, workspace_name as name
      from app.list_staff_workspaces() where workspace_id = ${workspaceId}
    `);
    const parsed = siteRowSchema.safeParse(rows[0]);
    return parsed.success ? parsed.data : undefined;
  };
  const own = await read(tx);
  if (own) return own;
  const [current] = await tx.execute<{ actorId: string }>(
    sql`select pg_catalog.current_setting('app.actor_id', true) as "actorId"`,
  );
  const actorId = current?.actorId ?? '';
  for (const member of new Set(members)) {
    const found = await tx.transaction(async (savepoint) => {
      await savepoint.execute(sql`select pg_catalog.set_config('app.actor_id', ${member}, true)`);
      const row = await read(savepoint);
      await savepoint.execute(sql`select pg_catalog.set_config('app.actor_id', ${actorId}, true)`);
      return row;
    });
    if (found) return found;
  }
  return undefined;
}

/**
 * Queues the step's mails. Not ready → `no_staff_sender`; each recipient who
 * is not an active member (`member_unavailable`) or has no address
 * (`member_has_no_address`) is named in `detail` as `<reason>:<actor id>`;
 * done when at least one job was queued, else skipped with the first reason.
 */
export async function notifyStaffStep(
  ctx: StepContext,
  step: Extract<FlowStep, { kind: 'notify_staff' }>,
): Promise<StepResult> {
  const { tx, fire, run, lead } = ctx;
  const environment = fire.staffNotifications ?? staffNotificationEnvironmentFromEnv();
  if (!environment.ready) return { outcome: 'skipped', reason: 'no_staff_sender' };

  const recipients = [
    ...(step.toAssignee && lead.assignedActorId !== null ? [lead.assignedActorId] : []),
    ...step.actorIds,
  ].filter((actorId, index, all) => all.indexOf(actorId) === index);
  if (recipients.length === 0) return { outcome: 'skipped', reason: 'member_unavailable' };

  const site = await siteIdentity(tx, fire.workspaceId, [
    fire.actorId,
    ...(run.flow.activatedBy ? [run.flow.activatedBy] : []),
    ...recipients,
  ]);
  if (!site) return { outcome: 'skipped', reason: 'member_unavailable' };

  const problems: Array<{
    reason: 'member_unavailable' | 'member_has_no_address';
    actorId: string;
  }> = [];
  let queued = 0;
  let duplicate = false;
  for (const actorId of recipients) {
    const [row] = await tx.execute(memberSql(fire.workspaceId, actorId));
    const member = toMember(row);
    if (!member?.active) {
      problems.push({ reason: 'member_unavailable', actorId });
      continue;
    }
    if (!member.notificationEmail) {
      problems.push({ reason: 'member_has_no_address', actorId });
      continue;
    }
    const payload = staffNotificationJobPayloadSchema.parse({
      actorId,
      flowKey: run.flow.key,
      flowName: run.flow.name.slice(0, 80),
      siteName: site.name.slice(0, 100),
      leadId: run.leadId,
      leadPath: `/w/${site.slug}/leads/${run.leadId}`,
      note: step.note.replace(NOTE_LINE, ' ').trim(),
    });
    const [job] = await tx
      .insert(outboxJobs)
      .values({
        workspaceId: fire.workspaceId,
        jobType: STAFF_NOTIFICATION_JOB_TYPE,
        dedupeKey: `${run.leadId}:${run.flow.key}:${run.occurrence}:${step.id}:${actorId}`,
        payload,
      })
      .onConflictDoNothing({
        target: [outboxJobs.workspaceId, outboxJobs.jobType, outboxJobs.dedupeKey],
      })
      .returning({ id: outboxJobs.id });
    if (job) queued += 1;
    else duplicate = true;
  }

  const detail =
    problems.length > 0
      ? { detail: detailOf(problems.map((problem) => `${problem.reason}:${problem.actorId}`)) }
      : {};
  if (queued > 0) return { outcome: 'done', ...detail };
  if (duplicate) return { outcome: 'skipped', reason: 'already_sent', ...detail };
  return { outcome: 'skipped', reason: problems[0]?.reason ?? 'member_unavailable', ...detail };
}

const escapeHtml = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** The members' addresses as stored, read in the job's own tenant transaction. */
function databaseMembers(database: Pick<DatabaseClient, 'withTenantTx'>): StaffNotificationMembers {
  return {
    readMember: (input) =>
      database.withTenantTx(
        { workspaceId: input.workspaceId, actorId: input.actorId },
        async (tx) => {
          const [row] = await tx.execute(memberSql(input.workspaceId, input.memberId));
          return toMember(row);
        },
      ),
  };
}

/**
 * The `staff_notification_email` handler: the payload, the member as they
 * are now (gone or without an address: completed `skipped:<reason>`), the
 * suppression check on the address's keyed hash, then the mail (subject
 * `<site>: <flow>`, a line naming the flow with the lead's link, the note on
 * its own line), its delivery record and its send. Never logs the address.
 */
export function createStaffNotificationHandler(options: {
  email: EmailAdapter;
  eligibility: EmailEligibilityChecker;
  delivery?: EmailDeliveryRecorder;
  environment: StaffNotificationEnvironment;
  database?: Pick<DatabaseClient, 'withTenantTx'>;
  /** Tests only: the member read without a database. */
  members?: StaffNotificationMembers;
}): JobHandler {
  const members = options.members ?? databaseMembers(options.database ?? { withTenantTx });
  const skip = (reason: string): JobHandlerResult => ({
    status: 'completed',
    providerId: `skipped:${reason}`,
  });
  return async (job) => {
    if (job.payloadVersion !== 1) throw new JobHandlerError('unsupported_payload_version', false);
    const parsed = staffNotificationJobPayloadSchema.safeParse(job.payload);
    const actor = z.uuid().safeParse(job.actorId);
    if (!parsed.success || !actor.success) throw new JobHandlerError('invalid_job_payload', false);
    const payload = parsed.data;
    const { environment } = options;
    if (!environment.ready) return skip('no_staff_sender');

    const member = await members.readMember({
      workspaceId: job.workspaceId,
      actorId: actor.data,
      memberId: payload.actorId,
    });
    if (!member?.active) return skip('member_unavailable');
    const toAddress = member.notificationEmail;
    if (!toAddress) return skip('member_has_no_address');

    const contactHash = environment.contactHash(toAddress);
    const check = await options.eligibility.checkTransactional({
      workspaceId: job.workspaceId,
      actorId: actor.data,
      contactHash,
    });
    if (!check.eligible) return skip('suppressed');

    const link = `${environment.adminOrigin}${payload.leadPath}`;
    const lines = [
      `The automation "${payload.flowName}" asks you to look at a lead: ${link}`,
      ...(payload.note ? [payload.note] : []),
    ];
    const rendered = {
      subject: `${payload.siteName}: ${payload.flowName}`,
      text: lines.join('\n'),
      html: lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('\n'),
    };
    await options.delivery?.prepare({
      workspaceId: job.workspaceId,
      actorId: actor.data,
      messageId: job.messageId,
      contactHash,
      template: 'staff_notification',
      messageClass: 'transactional',
    });
    const result = await options.email.send({
      workspaceId: job.workspaceId,
      messageId: job.messageId,
      template: 'staff_notification',
      toAddress,
      ...(environment.sender ? { sender: environment.sender } : {}),
      rendered,
    });
    await options.delivery?.recordResult({
      workspaceId: job.workspaceId,
      actorId: actor.data,
      messageId: job.messageId,
      result,
    });
    return result.status === 'delivered'
      ? { status: 'completed', providerId: result.providerId }
      : { status: 'uncertain', errorCode: 'provider_uncertain' };
  };
}
