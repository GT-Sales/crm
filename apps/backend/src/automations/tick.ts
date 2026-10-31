import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { withTenantTx, type DatabaseClient } from '@gt-sales/db';

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
import type { StaffNotificationEnvironment } from './staff-notification.js';

/**
 * The scheduler's fifth task, `automations` (spec §5): every five minutes,
 * for each site the outbox identity may work, the due waits (resumed on their
 * own version) and then the due timers (fired on the version active now),
 * oldest first, at most 200 items a site (P18). Each item is its own tenant
 * transaction that claims its row `FOR UPDATE SKIP LOCKED`, so two ticks, a
 * second replica or a retried transaction run each item once; an item that
 * throws is rolled back and left for the next tick (P17). Logs counts, ids
 * and codes only.
 */

export const AUTOMATION_TICK_INTERVAL_MS = 5 * 60_000;
export const AUTOMATION_TICK_BATCH = 200;

export interface AutomationTickResult {
  resumed: number;
  cancelled: number;
  failed: number;
  fired: number;
  voided: number;
  deferred: number;
}

export interface AutomationTickDependencies {
  database?: Pick<DatabaseClient, 'withTenantTx'>;
  environment: CustomerEmailEnvironment;
  staffNotifications?: StaffNotificationEnvironment;
  now?: () => Date;
  /** Test seams only. */
  hooks?: Pick<ItemHooks, 'afterClaim' | 'insideResume'>;
}

const empty = (): AutomationTickResult => ({
  resumed: 0,
  cancelled: 0,
  failed: 0,
  fired: 0,
  voided: 0,
  deferred: 0,
});

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

/** One tick over every authorised site; returns the counts summed. */
export async function runAutomationTick(
  dependencies: AutomationTickDependencies,
  input: SchedulerRunInput,
): Promise<AutomationTickResult> {
  const database = dependencies.database ?? { withTenantTx };
  const totals = empty();
  for (const workspaceId of new Set(input.authorizedWorkspaceIds)) {
    const now = dependencies.now?.() ?? new Date();
    const scope = { workspaceId, actorId: input.actorId };
    const counts = empty();
    const due = await database.withTenantTx(scope, async (tx) => {
      const waits = await tx.execute<{ id: string }>(sql`
        select id from app.automation_waits
        where workspace_id = ${workspaceId} and status = 'pending' and resume_at <= ${now.toISOString()}::timestamptz
        order by resume_at, id
        limit ${AUTOMATION_TICK_BATCH}
      `);
      const room = AUTOMATION_TICK_BATCH - waits.length;
      const timers =
        room > 0
          ? await tx.execute<{ id: string }>(sql`
              select id from app.automation_timers
              where workspace_id = ${workspaceId} and status = 'pending' and due_at <= ${now.toISOString()}::timestamptz
              order by due_at, id
              limit ${room}
            `)
          : [];
      return { waits: waits.map((row) => row.id), timers: timers.map((row) => row.id) };
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
      try {
        const outcome = await database.withTenantTx(scope, (tx) =>
          resumeRun(tx, context(), id, now, {
            ...dependencies.hooks,
            onFailure: (error) => logItemFailure('wait', id, error),
          }),
        );
        if (outcome === 'resumed') counts.resumed += 1;
        else if (outcome === 'cancelled') counts.cancelled += 1;
        else if (outcome === 'failed') counts.failed += 1;
      } catch (error) {
        counts.failed += 1;
        logItemFailure('wait', id, error);
      }
    }
    for (const id of due.timers) {
      try {
        const outcome = await database.withTenantTx(scope, (tx) =>
          fireTimer(tx, context(), id, now, dependencies.hooks),
        );
        if (outcome === 'fired') counts.fired += 1;
        else if (outcome === 'void') counts.voided += 1;
        else if (outcome === 'deferred') counts.deferred += 1;
      } catch (error) {
        counts.failed += 1;
        logItemFailure('timer', id, error);
      }
    }

    console.info(
      JSON.stringify({
        event: 'automation_tick',
        workspaceId: sanitizeLogIdentifier(workspaceId) ?? 'unknown',
        ...counts,
      }),
    );
    totals.resumed += counts.resumed;
    totals.cancelled += counts.cancelled;
    totals.failed += counts.failed;
    totals.fired += counts.fired;
    totals.voided += counts.voided;
    totals.deferred += counts.deferred;
  }
  return totals;
}
