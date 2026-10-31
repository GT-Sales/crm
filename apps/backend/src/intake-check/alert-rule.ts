import type { OwnerAlert, OwnerAlertChannel } from '@gt-sales/adapters';

import type { IntakeCheckResult } from './check.js';

/**
 * When the owner hears about the intake check (spec §4 "Alerts"): on the
 * first failure, then again only once the last alert is an hour old while it
 * keeps failing, and once, as an all-clear, on the first `ok` after a failure.
 * The state lives in memory on the one scheduler replica, so a restart during
 * an outage may repeat one failure alert. Only scheduled runs come here; the
 * manual route neither alerts nor touches the state (R6).
 */

export const INTAKE_ALERT_REPEAT_MS = 60 * 60_000;

export interface IntakeAlertState {
  /** Failed runs since the last `ok` whose all-clear was sent. */
  readonly failedRuns: number;
  /** When the last failure alert was sent, in epoch ms. */
  readonly lastAlertAt: number | null;
}

export const INITIAL_INTAKE_ALERT_STATE: IntakeAlertState = { failedRuns: 0, lastAlertAt: null };

/** `next` is the state to keep once `alert` (if any) has been sent. */
export function decideIntakeAlert(
  state: IntakeAlertState,
  result: IntakeCheckResult,
  nowMs: number,
): { alert: OwnerAlert | null; next: IntakeAlertState } {
  const occurredAt = new Date(nowMs).toISOString();
  if (result.status === 'failed') {
    const failedRuns = state.failedRuns + 1;
    const due = state.lastAlertAt === null || nowMs - state.lastAlertAt >= INTAKE_ALERT_REPEAT_MS;
    if (!due) return { alert: null, next: { failedRuns, lastAlertAt: state.lastAlertAt } };
    return {
      alert: {
        kind: 'synthetic_check_failed',
        detail: `${result.step}:${result.code}`,
        occurredAt,
      },
      next: { failedRuns, lastAlertAt: nowMs },
    };
  }
  if (state.failedRuns === 0) return { alert: null, next: state };
  return {
    alert: {
      kind: 'synthetic_check_recovered',
      detail: `failed_runs:${state.failedRuns}`,
      occurredAt,
    },
    next: INITIAL_INTAKE_ALERT_STATE,
  };
}

/** Runs, decides, sends; applies `next` only when there was nothing to send or the send succeeded. */
export async function runIntakeCheckWithAlert(
  run: () => Promise<IntakeCheckResult>,
  alerts: OwnerAlertChannel,
  getState: () => IntakeAlertState,
  setState: (state: IntakeAlertState) => void,
  now: () => number = Date.now,
): Promise<IntakeCheckResult> {
  const result = await run();
  const { alert, next } = decideIntakeAlert(getState(), result, now());
  if (alert === null) {
    setState(next);
    return result;
  }
  try {
    await alerts.send(alert);
    setState(next);
  } catch {
    // Unchanged state: the next run decides again and retries the send.
    console.error(JSON.stringify({ event: 'intake_check_alert_failed', kind: alert.kind }));
  }
  return result;
}
