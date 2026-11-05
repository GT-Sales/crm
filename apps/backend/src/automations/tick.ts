import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import type { OwnerAlertChannel } from '@gt-sales/adapters';
import { withActorTx, withTenantTx, type DatabaseClient } from '@gt-sales/db';

import type { CustomerEmailEnvironment } from '../email/senders.js';
import { sanitizeLogIdentifier } from '../http/logger.js';
import type { SchedulerRunInput } from '../scheduler.js';
import {
  errorCode,
  fireTimer,
  resumeRun,
  type FireFlowsContext,
  type ItemHooks,
} from './engine.js';
import { AUTOMATION_OVERDUE_AFTER_MS, AUTOMATION_TICK_INTERVAL_MS } from './schedule.js';
import type { StaffNotificationEnvironment } from './staff-notification.js';

/**
 * The scheduler's fifth task, `automations` (spec §5): every five minutes,
 * for each site the outbox identity may work, the due waits (resumed on their
 * own version) and the due timers (fired on the version active now), oldest
 * first. Each item is its own tenant transaction that claims its row
 * `FOR UPDATE SKIP LOCKED`, so two ticks, a second replica or a retried
 * transaction run each item once; an item that throws is rolled back and left
 * for the next tick (P17). Logs counts, ids and codes only.
 *
 * ENG-9: a pass takes at most {@link AUTOMATION_TICK_BATCH} items a site, at
 * least half of them timers when timers are due, so a burst of waits cannot
 * starve time triggers. Sites take passes in turn until none is left with a
 * full pass or the tick's wall-clock budget, below the interval, is spent.
 * What is still due then is logged and the owner alerted once.
 *
 * ENG-4: the scheduler only works the sites its machine entry lists. After
 * the passes, one cross-site read names every site with work overdue by two
 * ticks; one the entry does not list is logged and the owner alerted once, so
 * a new site's waits and timers never sit pending unseen.
 */

export { AUTOMATION_TICK_INTERVAL_MS, AUTOMATION_OVERDUE_AFTER_MS };
export const AUTOMATION_TICK_BATCH = 200;
/** How long one tick may keep draining, leaving room before the next. */
export const AUTOMATION_TICK_BUDGET_MS = 4 * 60_000;

export interface AutomationTickResult {
  resumed: number;
  cancelled: number;
  failed: number;
  fired: number;
  voided: number;
  deferred: number;
}

/** Sites already alerted for, so a condition alerts once until it clears. */
export interface AutomationAlertState {
  readonly backlog: Set<string>;
  readonly unscheduled: Set<string>;
}

export const initialAutomationAlertState = (): AutomationAlertState => ({
  backlog: new Set(),
  unscheduled: new Set(),
});

export interface AutomationTickDependencies {
  database?: Pick<DatabaseClient, 'withTenantTx' | 'withActorTx'>;
  environment: CustomerEmailEnvironment;
  staffNotifications?: StaffNotificationEnvironment;
  now?: () => Date;
  /** Owner alerts for a backlog or an unscheduled site; absent, they are logged only. */
  alerts?: OwnerAlertChannel;
  alertState?: AutomationAlertState;
  /** Test seams only. */
  hooks?: Pick<ItemHooks, 'afterClaim' | 'insideResume'>;
  batch?: number;
  budgetMs?: number;
  elapsed?: () => number;
}

const empty = (): AutomationTickResult => ({
  resumed: 0,
  cancelled: 0,
  failed: 0,
  fired: 0,
  voided: 0,
  deferred: 0,
});

function add(into: AutomationTickResult, from: AutomationTickResult): void {
  into.resumed += from.resumed;
  into.cancelled += from.cancelled;
  into.failed += from.failed;
  into.fired += from.fired;
  into.voided += from.voided;
  into.deferred += from.deferred;
}

function logItemFailure(kind: 'wait' | 'timer', id: string, error: unknown): void {
  console.warn(
    JSON.stringify({
      event: 'automation_tick_item_failed',
      kind,
      id: sanitizeLogIdentifier(id) ?? 'unknown',
      code: errorCode(error),
    }),
  );
}

/** One alert per condition per site, best effort, never failing the tick. */
async function alertOnce(
  dependencies: AutomationTickDependencies,
  seen: Set<string> | undefined,
  workspaceId: string,
  kind: 'automation_backlog' | 'automation_site_unscheduled',
  detail: string,
): Promise<void> {
  if (seen?.has(workspaceId)) return;
  seen?.add(workspaceId);
  await dependencies.alerts
    ?.send({ kind, detail, occurredAt: new Date().toISOString() })
    .catch(() => {
      // Best effort: the log line is the record.
    });
}

/** A site's pass: which ids to run now, and whether more may be due. */
function splitPass(
  waits: readonly string[],
  timers: readonly string[],
  batch: number,
): { waits: string[]; timers: string[]; full: boolean } {
  // Timers keep at least half the pass when they are due; waits get the rest.
  const waitRoom = Math.max(Math.ceil(batch / 2), batch - timers.length);
  const takenWaits = waits.slice(0, Math.min(waits.length, waitRoom));
  const takenTimers = timers.slice(0, batch - takenWaits.length);
  return {
    waits: takenWaits,
    timers: takenTimers,
    full: takenWaits.length + takenTimers.length >= batch,
  };
}

/** One tick over every authorised site; returns the counts summed. */
export async function runAutomationTick(
  dependencies: AutomationTickDependencies,
  input: SchedulerRunInput,
): Promise<AutomationTickResult> {
  const database = dependencies.database ?? { withTenantTx, withActorTx };
  const batch = dependencies.batch ?? AUTOMATION_TICK_BATCH;
  const budgetMs = dependencies.budgetMs ?? AUTOMATION_TICK_BUDGET_MS;
  const elapsedClock = dependencies.elapsed ?? (() => performance.now());
  const startedAt = elapsedClock();
  const totals = empty();
  const sites = [...new Set(input.authorizedWorkspaceIds)];
  const counts = new Map(sites.map((id) => [id, empty()]));
  // Items already tried this tick: one that failed stays due, and must wait
  // for the next tick rather than spin inside this one.
  const tried = new Map(sites.map((id) => [id, new Set<string>()]));
  let draining = new Set(sites);
  let first = true;

  const pass = async (workspaceId: string): Promise<boolean> => {
    const now = dependencies.now?.() ?? new Date();
    const scope = { workspaceId, actorId: input.actorId };
    const siteCounts = counts.get(workspaceId) ?? empty();
    const attempted = tried.get(workspaceId) ?? new Set<string>();
    const skip = [...attempted];
    const due = await database.withTenantTx(scope, async (tx) => {
      const waits = await tx.execute<{ id: string }>(sql`
        select id from app.automation_waits
        where workspace_id = ${workspaceId} and status = 'pending'
          and resume_at <= ${now.toISOString()}::timestamptz
          and not (id = any(${`{${skip.join(',')}}`}::uuid[]))
        order by resume_at, id
        limit ${batch}
      `);
      const timers = await tx.execute<{ id: string }>(sql`
        select id from app.automation_timers
        where workspace_id = ${workspaceId} and status = 'pending'
          and due_at <= ${now.toISOString()}::timestamptz
          and not (id = any(${`{${skip.join(',')}}`}::uuid[]))
        order by due_at, id
        limit ${batch}
      `);
      return splitPass(
        waits.map((row) => row.id),
        timers.map((row) => row.id),
        batch,
      );
    });

    const context = (): FireFlowsContext => ({
      workspaceId,
      actorId: input.actorId,
      requestId: randomUUID(),
      environment: dependencies.environment,
      now: () => now,
      ...(dependencies.staffNotifications
        ? { staffNotifications: dependencies.staffNotifications }
        : {}),
    });

    for (const id of due.waits) {
      attempted.add(id);
      try {
        const outcome = await database.withTenantTx(scope, (tx) =>
          resumeRun(tx, context(), id, now, {
            ...dependencies.hooks,
            onFailure: (error) => logItemFailure('wait', id, error),
          }),
        );
        if (outcome === 'resumed') siteCounts.resumed += 1;
        else if (outcome === 'cancelled') siteCounts.cancelled += 1;
        else if (outcome === 'failed') siteCounts.failed += 1;
      } catch (error) {
        siteCounts.failed += 1;
        logItemFailure('wait', id, error);
      }
    }
    for (const id of due.timers) {
      attempted.add(id);
      try {
        const outcome = await database.withTenantTx(scope, (tx) =>
          fireTimer(tx, context(), id, now, dependencies.hooks),
        );
        if (outcome === 'fired') siteCounts.fired += 1;
        else if (outcome === 'void') siteCounts.voided += 1;
        else if (outcome === 'deferred') siteCounts.deferred += 1;
      } catch (error) {
        siteCounts.failed += 1;
        logItemFailure('timer', id, error);
      }
    }
    return due.full;
  };

  // Every listed site gets its first pass; further passes only while the
  // budget lasts, taking turns so one busy site cannot starve the others.
  while (draining.size > 0) {
    const next = new Set<string>();
    for (const workspaceId of sites) {
      if (!draining.has(workspaceId)) continue;
      if (!first && elapsedClock() - startedAt >= budgetMs) {
        next.add(workspaceId);
        continue;
      }
      if (await pass(workspaceId)) next.add(workspaceId);
    }
    if (!first && elapsedClock() - startedAt >= budgetMs) {
      draining = next;
      break;
    }
    draining = next;
    first = false;
  }

  for (const workspaceId of sites) {
    const siteCounts = counts.get(workspaceId) ?? empty();
    console.info(
      JSON.stringify({
        event: 'automation_tick',
        workspaceId: sanitizeLogIdentifier(workspaceId) ?? 'unknown',
        ...siteCounts,
      }),
    );
    add(totals, siteCounts);
  }

  // ENG-9: a site still holding a full pass when the budget ran out.
  for (const workspaceId of sites) {
    if (!draining.has(workspaceId)) {
      dependencies.alertState?.backlog.delete(workspaceId);
      continue;
    }
    const now = dependencies.now?.() ?? new Date();
    const [remaining] = await database.withTenantTx({ workspaceId, actorId: input.actorId }, (tx) =>
      tx.execute<{ waits: number; timers: number }>(sql`
          select
            (select count(*)::int from app.automation_waits
              where workspace_id = ${workspaceId} and status = 'pending'
                and resume_at <= ${now.toISOString()}::timestamptz) as waits,
            (select count(*)::int from app.automation_timers
              where workspace_id = ${workspaceId} and status = 'pending'
                and due_at <= ${now.toISOString()}::timestamptz) as timers
        `),
    );
    const waits = remaining?.waits ?? 0;
    const timers = remaining?.timers ?? 0;
    console.warn(
      JSON.stringify({
        event: 'automation_tick_backlog',
        workspaceId: sanitizeLogIdentifier(workspaceId) ?? 'unknown',
        waits,
        timers,
      }),
    );
    await alertOnce(
      dependencies,
      dependencies.alertState?.backlog,
      workspaceId,
      'automation_backlog',
      `site:${workspaceId},waits:${waits},timers:${timers}`,
    );
  }

  // ENG-4: overdue work on a site this scheduler does not list.
  const before = new Date(
    (dependencies.now?.() ?? new Date()).getTime() - AUTOMATION_OVERDUE_AFTER_MS,
  );
  let overdue: readonly { workspaceId: string; waits: number; timers: number }[];
  try {
    overdue = await database.withActorTx(input.actorId, (tx) =>
      tx.execute<{ workspaceId: string; waits: number; timers: number }>(sql`
        select workspace_id as "workspaceId", waits, timers
        from app.automation_overdue_sites(${before.toISOString()}::timestamptz)
      `),
    );
  } catch (error) {
    // The check never costs the tick its work; it is reported and retried next tick.
    console.warn(
      JSON.stringify({ event: 'automation_overdue_check_failed', code: errorCode(error) }),
    );
    return totals;
  }
  const listed = new Set(sites);
  const unscheduled = new Set<string>();
  for (const row of overdue) {
    if (listed.has(row.workspaceId)) continue;
    unscheduled.add(row.workspaceId);
    console.warn(
      JSON.stringify({
        event: 'automation_site_unscheduled',
        workspaceId: sanitizeLogIdentifier(row.workspaceId) ?? 'unknown',
        waits: row.waits,
        timers: row.timers,
      }),
    );
    await alertOnce(
      dependencies,
      dependencies.alertState?.unscheduled,
      row.workspaceId,
      'automation_site_unscheduled',
      `site:${row.workspaceId},waits:${row.waits},timers:${row.timers}`,
    );
  }
  for (const workspaceId of dependencies.alertState?.unscheduled ?? []) {
    if (!unscheduled.has(workspaceId)) dependencies.alertState?.unscheduled.delete(workspaceId);
  }
  return totals;
}
