import {
  auditEvents,
  outboxJobAlerts,
  outboxJobs,
  withTenantTx,
  type DatabaseClient,
  type TenantTransaction,
} from '@gt-sales/db';
import { TRACKING_CODE_JOB_TYPE } from '@gt-sales/contracts';
import type { ClaimedJob, JobOutcome, OutboxStore } from '@gt-sales/jobs';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';

interface ClaimedRow {
  [key: string]: unknown;
  id: string;
  workspaceId: string;
  jobType: string;
  messageId: string;
  payloadVersion: number;
  payload: unknown;
  attempts: number;
  leaseOwnerId: string;
}

export interface AdminJob {
  id: string;
  jobType: string;
  status: 'pending' | 'processing' | 'failed' | 'uncertain';
  attempts: number;
  availableAt: Date;
  leaseExpiresAt: Date | null;
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Jobs returned per Jobs page load; `total` reports how many are active (REL-20). */
export const ACTIVE_JOB_LIST_LIMIT = 500;

export interface JobAdminStore {
  listActive(workspaceId: string, actorId: string): Promise<{ jobs: AdminJob[]; total: number }>;
  retry(input: {
    workspaceId: string;
    actorId: string;
    jobId: string;
    requestId: string;
  }): Promise<'retried' | 'not_found' | 'not_failed'>;
  resolveUncertain(input: {
    workspaceId: string;
    actorId: string;
    jobId: string;
    requestId: string;
    delivered: boolean;
  }): Promise<'completed' | 'failed' | 'not_found' | 'not_uncertain'>;
}

function adminJobStatus(value: string): AdminJob['status'] {
  switch (value) {
    case 'pending':
    case 'processing':
    case 'failed':
    case 'uncertain':
      return value;
    default:
      throw new Error('Unexpected active outbox status.');
  }
}

/**
 * A job's payload once it ends (completed, failed or uncertain): a tracking
 * code mail keeps only its challenge id, never the address or the sealed code;
 * every other job keeps its payload.
 */
function endedPayload(): SQL {
  return sql`case when ${outboxJobs.jobType} = ${TRACKING_CODE_JOB_TYPE} then jsonb_build_object('challengeId', ${outboxJobs.payload}->>'challengeId') else ${outboxJobs.payload} end`;
}

async function alertTerminalJobs(
  tx: TenantTransaction,
  workspaceId: string,
  maxAttempts: number,
  now: Date,
): Promise<void> {
  const exhausted = await tx
    .update(outboxJobs)
    .set({
      status: 'failed',
      lastErrorCode: 'max_attempts_exhausted',
      payload: endedPayload(),
      leaseOwnerId: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(outboxJobs.workspaceId, workspaceId),
        sql`${outboxJobs.attempts} >= ${maxAttempts}`,
        // A `Date` interpolated straight into a raw fragment reaches the driver
        // unencoded, so timestamps are passed as ISO strings here.
        sql`(${outboxJobs.status} = 'pending' or (${outboxJobs.status} = 'processing' and ${outboxJobs.leaseExpiresAt} <= ${now.toISOString()}))`,
      ),
    )
    .returning({ id: outboxJobs.id });
  if (exhausted.length > 0) {
    await tx.insert(outboxJobAlerts).values(
      exhausted.map(({ id }) => ({
        workspaceId,
        jobId: id,
        alertCode: 'max_attempts_exhausted',
      })),
    );
  }
}

export class DatabaseOutboxStore implements OutboxStore, JobAdminStore {
  constructor(private readonly database: Pick<DatabaseClient, 'withTenantTx'> = { withTenantTx }) {}

  async queueHealth(input: {
    authorizedWorkspaceIds: readonly string[];
    actorId: string;
  }): Promise<{ failed: number; uncertain: number }> {
    const counts = { failed: 0, uncertain: 0 };
    for (const workspaceId of new Set(input.authorizedWorkspaceIds)) {
      const rows = await this.database.withTenantTx({ workspaceId, actorId: input.actorId }, (tx) =>
        tx
          .select({
            failed: sql<number>`count(*) filter (where ${outboxJobs.status} = 'failed')::int`,
            uncertain: sql<number>`count(*) filter (where ${outboxJobs.status} = 'uncertain')::int`,
          })
          .from(outboxJobs)
          .where(
            and(
              eq(outboxJobs.workspaceId, workspaceId),
              inArray(outboxJobs.status, ['failed', 'uncertain']),
            ),
          ),
      );
      counts.failed += rows[0]?.failed ?? 0;
      counts.uncertain += rows[0]?.uncertain ?? 0;
    }
    return counts;
  }

  async claim(input: {
    workspaceId: string;
    actorId: string;
    leaseOwnerId: string;
    limit: number;
    leaseExpiresAt: Date;
    now: Date;
    maxAttempts: number;
  }): Promise<ClaimedJob[]> {
    return this.database.withTenantTx(
      { workspaceId: input.workspaceId, actorId: input.actorId },
      async (tx) => {
        await alertTerminalJobs(tx, input.workspaceId, input.maxAttempts, input.now);
        const rows = await tx.execute<ClaimedRow>(sql`
          with claimable as (
            select id
            from app.outbox_jobs
            where workspace_id = ${input.workspaceId}
              and attempts < ${input.maxAttempts}
              and (
                (status = 'pending' and available_at <= ${input.now.toISOString()})
                or (status = 'processing' and lease_expires_at <= ${input.now.toISOString()})
              )
            order by available_at asc, created_at asc
            for update skip locked
            limit ${input.limit}
          )
          update app.outbox_jobs as jobs
          set status = 'processing',
              attempts = jobs.attempts + 1,
              locked_at = ${input.now.toISOString()},
              last_attempt_at = ${input.now.toISOString()},
              lease_owner_id = ${input.leaseOwnerId},
              lease_expires_at = ${input.leaseExpiresAt.toISOString()},
              updated_at = ${input.now.toISOString()}
          from claimable
          where jobs.id = claimable.id
            and jobs.workspace_id = ${input.workspaceId}
          returning jobs.id,
                    jobs.workspace_id as "workspaceId",
                    jobs.job_type as "jobType",
                    jobs.message_id as "messageId",
                    jobs.payload_version as "payloadVersion",
                    jobs.payload,
                    jobs.attempts,
                    jobs.lease_owner_id as "leaseOwnerId"
        `);
        return [...rows];
      },
    );
  }

  async recordOutcome(input: {
    workspaceId: string;
    actorId: string;
    jobId: string;
    leaseOwnerId: string;
    outcome: JobOutcome;
    now: Date;
  }): Promise<'recorded' | 'lease_lost'> {
    return this.database.withTenantTx(
      { workspaceId: input.workspaceId, actorId: input.actorId },
      async (tx) => {
        const common = {
          leaseOwnerId: null,
          leaseExpiresAt: null,
          updatedAt: input.now,
        };
        const update =
          input.outcome.status === 'completed'
            ? {
                ...common,
                status: 'completed',
                completedAt: input.now,
                lastErrorCode: null,
                providerId: input.outcome.providerId,
                outcome: input.outcome.detail ?? {},
              }
            : input.outcome.status === 'retry'
              ? {
                  ...common,
                  status: 'pending',
                  availableAt: input.outcome.availableAt,
                  lastErrorCode: input.outcome.errorCode,
                  ...(input.outcome.preserveAttempt
                    ? { attempts: sql`greatest(0, ${outboxJobs.attempts} - 1)` }
                    : {}),
                }
              : input.outcome.status === 'uncertain'
                ? {
                    ...common,
                    status: 'uncertain',
                    uncertainAt: input.now,
                    lastErrorCode: input.outcome.errorCode,
                  }
                : {
                    ...common,
                    status: 'failed',
                    lastErrorCode: input.outcome.errorCode,
                  };
        // A tracking code's address and sealed code are needed only until the job ends.
        const terminal = input.outcome.status !== 'retry';
        const updated = await tx
          .update(outboxJobs)
          .set({
            ...update,
            ...(terminal
              ? {
                  payload: endedPayload(),
                }
              : {}),
          })
          .where(
            and(
              eq(outboxJobs.workspaceId, input.workspaceId),
              eq(outboxJobs.id, input.jobId),
              eq(outboxJobs.status, 'processing'),
              eq(outboxJobs.leaseOwnerId, input.leaseOwnerId),
            ),
          )
          .returning({ id: outboxJobs.id });
        if (updated.length === 0) return 'lease_lost';
        if (input.outcome.status === 'failed' || input.outcome.status === 'uncertain') {
          await tx.insert(outboxJobAlerts).values({
            workspaceId: input.workspaceId,
            jobId: input.jobId,
            alertCode: input.outcome.errorCode,
          });
        }
        return 'recorded';
      },
    );
  }

  async listActive(
    workspaceId: string,
    actorId: string,
  ): Promise<{ jobs: AdminJob[]; total: number }> {
    return this.database.withTenantTx({ workspaceId, actorId }, async (tx) => {
      const active = and(
        eq(outboxJobs.workspaceId, workspaceId),
        inArray(outboxJobs.status, ['pending', 'processing', 'failed', 'uncertain']),
      );
      // REL-20: a provider outage can leave hundreds of rows, so the page gets
      // the most recently changed ones and a total instead of all of them.
      const rows = await tx
        .select({
          id: outboxJobs.id,
          jobType: outboxJobs.jobType,
          status: outboxJobs.status,
          attempts: outboxJobs.attempts,
          availableAt: outboxJobs.availableAt,
          leaseExpiresAt: outboxJobs.leaseExpiresAt,
          lastErrorCode: outboxJobs.lastErrorCode,
          createdAt: outboxJobs.createdAt,
          updatedAt: outboxJobs.updatedAt,
        })
        .from(outboxJobs)
        .where(active)
        .orderBy(desc(outboxJobs.updatedAt), desc(outboxJobs.id))
        .limit(ACTIVE_JOB_LIST_LIMIT);
      const [count] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(outboxJobs)
        .where(active);
      return {
        jobs: rows.map((row) => ({ ...row, status: adminJobStatus(row.status) })),
        total: count?.total ?? rows.length,
      };
    });
  }

  /**
   * REL-20: an `uncertain` job may or may not have reached the provider, so it
   * is never retried automatically. Once staff have checked the provider's own
   * log they record the answer: delivered closes the job as completed; not
   * delivered marks it failed, which offers the normal Retry. Either way its
   * open alerts are resolved and the provider evidence is kept.
   */
  async resolveUncertain(input: {
    workspaceId: string;
    actorId: string;
    jobId: string;
    requestId: string;
    delivered: boolean;
  }): Promise<'completed' | 'failed' | 'not_found' | 'not_uncertain'> {
    return this.database.withTenantTx(
      { workspaceId: input.workspaceId, actorId: input.actorId },
      async (tx) => {
        const now = new Date();
        const status = input.delivered ? 'completed' : 'failed';
        const updated = await tx
          .update(outboxJobs)
          .set({
            status,
            completedAt: input.delivered ? now : null,
            lastErrorCode: input.delivered
              ? 'staff_confirmed_delivered'
              : 'staff_confirmed_not_delivered',
            updatedAt: now,
          })
          .where(
            and(
              eq(outboxJobs.workspaceId, input.workspaceId),
              eq(outboxJobs.id, input.jobId),
              eq(outboxJobs.status, 'uncertain'),
            ),
          )
          .returning({ id: outboxJobs.id });
        if (updated.length === 0) {
          const existing = await tx
            .select({ id: outboxJobs.id })
            .from(outboxJobs)
            .where(
              and(eq(outboxJobs.workspaceId, input.workspaceId), eq(outboxJobs.id, input.jobId)),
            )
            .limit(1);
          return existing[0] ? 'not_uncertain' : 'not_found';
        }
        await tx
          .update(outboxJobAlerts)
          .set({ resolvedAt: now })
          .where(
            and(
              eq(outboxJobAlerts.workspaceId, input.workspaceId),
              eq(outboxJobAlerts.jobId, input.jobId),
              sql`${outboxJobAlerts.resolvedAt} is null`,
            ),
          );
        await tx.insert(auditEvents).values({
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          actorLabel: 'staff',
          action: 'outbox_job.uncertain_resolved',
          entity: 'outbox_job',
          entityId: input.jobId,
          before: { status: 'uncertain' },
          after: { status, delivered: input.delivered },
          requestId: input.requestId,
        });
        return status;
      },
    );
  }

  async retry(input: {
    workspaceId: string;
    actorId: string;
    jobId: string;
    requestId: string;
  }): Promise<'retried' | 'not_found' | 'not_failed'> {
    return this.database.withTenantTx(
      { workspaceId: input.workspaceId, actorId: input.actorId },
      async (tx) => {
        const existing = await tx
          .select({ status: outboxJobs.status })
          .from(outboxJobs)
          .where(and(eq(outboxJobs.workspaceId, input.workspaceId), eq(outboxJobs.id, input.jobId)))
          .limit(1);
        if (!existing[0]) return 'not_found';
        if (existing[0].status !== 'failed') return 'not_failed';
        const now = new Date();
        await tx
          .update(outboxJobs)
          .set({
            status: 'pending',
            attempts: 0,
            availableAt: now,
            lockedAt: null,
            leaseOwnerId: null,
            leaseExpiresAt: null,
            completedAt: null,
            uncertainAt: null,
            lastErrorCode: null,
            // The previous attempt's provider evidence (`providerId`/`outcome`)
            // is deliberately preserved: an operator requeue must not erase what
            // the provider already reported, which incident review and any
            // follow-up reconciliation rely on. Only the attempt state is reset.
            updatedAt: now,
          })
          .where(
            and(eq(outboxJobs.workspaceId, input.workspaceId), eq(outboxJobs.id, input.jobId)),
          );
        await tx
          .update(outboxJobAlerts)
          .set({ resolvedAt: now })
          .where(
            and(
              eq(outboxJobAlerts.workspaceId, input.workspaceId),
              eq(outboxJobAlerts.jobId, input.jobId),
              sql`${outboxJobAlerts.resolvedAt} is null`,
            ),
          );
        await tx.insert(auditEvents).values({
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          actorLabel: 'staff',
          action: 'outbox_job.retry',
          entity: 'outbox_job',
          entityId: input.jobId,
          before: { status: 'failed' },
          after: { status: 'pending', attempts: 0 },
          requestId: input.requestId,
        });
        return 'retried';
      },
    );
  }
}
