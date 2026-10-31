import { and, eq, sql } from 'drizzle-orm';
import { automationRuns, automationStepRuns, type TenantTransaction } from '@gt-sales/db';
import type { AutomationReason, AutomationStepOutcome, FlowStepKind } from '@gt-sales/contracts';

/**
 * The records a flow's run writes (spec §4): one row per step outcome
 * (`app.automation_step_runs`, append-only), the run's end, and the
 * cancellation of a run waiting at a wait step. Every `detail` holds keys,
 * ids or fill-in names only, never a value (README rule 8). Waits and timers
 * are claimed `FOR UPDATE SKIP LOCKED` (ruling P7), so a switch or a resume
 * never waits on a row the scheduler holds.
 */

const DETAIL_MAX = 200;

/** A step row that would break the table's meaning; thrown before any SQL. */
export class StepRunShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StepRunShapeError';
  }
}

export interface StepRunRecord {
  runId: string;
  stepId: string;
  stepKind: FlowStepKind;
  outcome: AutomationStepOutcome;
  branch?: 'yes' | 'no';
  reason?: AutomationReason;
  detail?: string;
  jobId?: string;
  taskId?: string;
}

function shapeProblem(record: StepRunRecord): string | undefined {
  if (record.outcome === 'done' && record.stepKind === 'send_email' && !record.jobId) {
    return 'a sent email step names its job';
  }
  if (record.outcome === 'done' && record.stepKind === 'create_task' && !record.taskId) {
    return 'a done task step names its task';
  }
  if (record.branch !== undefined && record.stepKind !== 'if_else') {
    return 'only an if/else takes a branch';
  }
  if (record.detail !== undefined && record.detail.length > DETAIL_MAX) {
    return `a step detail is ${DETAIL_MAX} characters at most`;
  }
  return undefined;
}

/** Records one step's outcome; throws `StepRunShapeError` for a row that does not fit, before any SQL. */
export async function insertStepRun(
  tx: TenantTransaction,
  workspaceId: string,
  record: StepRunRecord,
): Promise<void> {
  const problem = shapeProblem(record);
  if (problem) throw new StepRunShapeError(problem);
  await tx.insert(automationStepRuns).values({
    workspaceId,
    runId: record.runId,
    stepId: record.stepId,
    stepKind: record.stepKind,
    outcome: record.outcome,
    branch: record.branch ?? null,
    reason: record.reason ?? null,
    detail: record.detail ?? null,
    jobId: record.jobId ?? null,
    taskId: record.taskId ?? null,
  });
}

/** Ends a run: its status, why, and when (`finished_at`, `updated_at`). */
export async function finishRun(
  tx: TenantTransaction,
  workspaceId: string,
  runId: string,
  end: {
    status: 'completed' | 'skipped' | 'failed' | 'cancelled';
    reason?: AutomationReason;
    detail?: string;
  },
): Promise<void> {
  const now = new Date();
  await tx
    .update(automationRuns)
    .set({
      status: end.status,
      reason: end.reason ?? null,
      detail: end.detail === undefined ? null : detailOf([end.detail]),
      finishedAt: now,
      updatedAt: now,
    })
    .where(and(eq(automationRuns.workspaceId, workspaceId), eq(automationRuns.id, runId)));
}

/**
 * Cancels the claimed pending waits: each wait `cancelled`, its run
 * `cancelled` with `reason` and `finished_at`, and one `cancelled` step row
 * for the wait step (ruling P25). `claim` is the SQL that picks the waits'
 * ids; it must lock them `FOR UPDATE SKIP LOCKED`. Returns the waits cancelled.
 */
async function cancelClaimedWaits(
  tx: TenantTransaction,
  workspaceId: string,
  claim: ReturnType<typeof sql>,
  end: { reason: AutomationReason; detail: string | null },
): Promise<number> {
  const rows = await tx.execute<{ cancelled: number }>(sql`
    with claimed as (${claim}),
    waits as (
      update app.automation_waits w
      set status = 'cancelled', updated_at = now()
      from claimed c
      where w.id = c.id
      returning w.run_id, w.step_id
    ),
    runs as (
      update app.automation_runs r
      set status = 'cancelled', reason = ${end.reason}, detail = ${end.detail},
        finished_at = now(), updated_at = now()
      from waits
      where r.workspace_id = ${workspaceId} and r.id = waits.run_id and r.status = 'waiting'
      returning r.id
    ),
    steps as (
      insert into app.automation_step_runs
        (workspace_id, run_id, step_id, step_kind, outcome, reason, detail)
      select ${workspaceId}, waits.run_id, waits.step_id, 'wait', 'cancelled', ${end.reason},
        ${end.detail}
      from waits
      returning 1
    )
    select (select count(*) from waits)::int as cancelled,
      (select count(*) from runs)::int as runs,
      (select count(*) from steps)::int as steps
  `);
  return rows[0]?.cancelled ?? 0;
}

/**
 * Cancels a run waiting at a wait step (P25): false when its wait is not
 * pending or another transaction holds it (`SKIP LOCKED`), so nothing changed.
 */
export async function cancelWaitingRun(
  tx: TenantTransaction,
  workspaceId: string,
  input: { runId: string; reason: AutomationReason; detail?: string },
): Promise<boolean> {
  const cancelled = await cancelClaimedWaits(
    tx,
    workspaceId,
    sql`
      select id from app.automation_waits
      where workspace_id = ${workspaceId} and run_id = ${input.runId} and status = 'pending'
      for update skip locked
    `,
    { reason: input.reason, detail: input.detail === undefined ? null : detailOf([input.detail]) },
  );
  return cancelled > 0;
}

/**
 * What switching a flow off (or archiving it) does to its work in flight
 * (spec ruling R2, R3): every pending wait is cancelled with its run, every
 * pending timer becomes `void`. A wait or timer another transaction holds
 * (a tick resuming it) is skipped (P7); the tick re-checks the flow itself.
 */
export async function cancelFlowWork(
  tx: TenantTransaction,
  workspaceId: string,
  automationId: string,
  reason: 'flow_switched_off',
): Promise<{ cancelledRuns: number; voidedTimers: number }> {
  const cancelledRuns = await cancelClaimedWaits(
    tx,
    workspaceId,
    sql`
      select id from app.automation_waits
      where workspace_id = ${workspaceId} and automation_id = ${automationId}
        and status = 'pending'
      for update skip locked
    `,
    { reason, detail: null },
  );
  const timers = await tx.execute<{ voided: number }>(sql`
    with claimed as (
      select id from app.automation_timers
      where workspace_id = ${workspaceId} and automation_id = ${automationId}
        and status = 'pending'
      for update skip locked
    ),
    voided as (
      update app.automation_timers t
      set status = 'void', updated_at = now()
      from claimed c
      where t.id = c.id
      returning t.id
    )
    select count(*)::int as voided from voided
  `);
  return { cancelledRuns, voidedTimers: timers[0]?.voided ?? 0 };
}

/** Keys, ids and fill-in names only, joined by `,` and cut to 200 characters. */
export function detailOf(parts: readonly string[]): string {
  return parts.join(',').slice(0, DETAIL_MAX);
}
