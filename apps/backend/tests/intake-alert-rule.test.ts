import type { OwnerAlert } from '@gt-sales/adapters';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { IntakeCheckResult } from '../src/intake-check/check.js';
import {
  decideIntakeAlert,
  INITIAL_INTAKE_ALERT_STATE,
  INTAKE_ALERT_REPEAT_MS,
  runIntakeCheckWithAlert,
  type IntakeAlertState,
} from '../src/intake-check/alert-rule.js';

const MINUTE = 60_000;
const failed: IntakeCheckResult = {
  status: 'failed',
  step: 'create',
  code: 'sqlstate_23503',
  durationMs: 12,
};
const ok: IntakeCheckResult = { status: 'ok', durationMs: 9 };

/** Threads the state through a series of runs and returns the alerts the rule asked for. */
function replay(
  runs: readonly [result: IntakeCheckResult, atMinute: number][],
  start: IntakeAlertState = INITIAL_INTAKE_ALERT_STATE,
): { alerts: (OwnerAlert | null)[]; state: IntakeAlertState } {
  let state = start;
  const alerts: (OwnerAlert | null)[] = [];
  for (const [result, atMinute] of runs) {
    const decision = decideIntakeAlert(state, result, atMinute * MINUTE);
    alerts.push(decision.alert);
    state = decision.next;
  }
  return { alerts, state };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('decideIntakeAlert', () => {
  test('alerts on the first failure, then at most hourly', () => {
    expect(INTAKE_ALERT_REPEAT_MS).toBe(60 * MINUTE);
    const { alerts, state } = replay([
      [failed, 0],
      [failed, 15],
      [failed, 30],
      [failed, 45],
      [failed, 60],
      [failed, 75],
    ]);
    expect(alerts.map((alert) => alert?.kind ?? null)).toEqual([
      'synthetic_check_failed',
      null,
      null,
      null,
      'synthetic_check_failed',
      null,
    ]);
    expect(alerts[0]).toEqual({
      kind: 'synthetic_check_failed',
      detail: 'create:sqlstate_23503',
      occurredAt: new Date(0).toISOString(),
    });
    expect(alerts[4]?.detail).toBe('create:sqlstate_23503');
    expect(state).toEqual({ failedRuns: 6, lastAlertAt: 60 * MINUTE });
  });

  test('sends one all-clear and resets', () => {
    const { alerts, state } = replay([
      [failed, 0],
      [failed, 15],
      [failed, 30],
      [failed, 45],
      [failed, 60],
      [ok, 75],
      [ok, 90],
    ]);
    expect(alerts[5]).toEqual({
      kind: 'synthetic_check_recovered',
      detail: 'failed_runs:5',
      occurredAt: new Date(75 * MINUTE).toISOString(),
    });
    expect(alerts[6]).toBeNull();
    expect(state).toEqual(INITIAL_INTAKE_ALERT_STATE);
  });

  test('an ok with no failure sends nothing', () => {
    const decision = decideIntakeAlert(INITIAL_INTAKE_ALERT_STATE, ok, 0);
    expect(decision).toEqual({ alert: null, next: INITIAL_INTAKE_ALERT_STATE });
    expect(INITIAL_INTAKE_ALERT_STATE).toEqual({ failedRuns: 0, lastAlertAt: null });
  });

  test('the failure detail names the step and the code', () => {
    const decision = decideIntakeAlert(
      INITIAL_INTAKE_ALERT_STATE,
      { status: 'failed', step: 'delete', code: 'delete_incomplete', durationMs: 3 },
      0,
    );
    expect(decision.alert?.detail).toBe('delete:delete_incomplete');
  });
});

describe('runIntakeCheckWithAlert', () => {
  function harness(results: IntakeCheckResult[]) {
    let state: IntakeAlertState = INITIAL_INTAKE_ALERT_STATE;
    let nowMs = 0;
    const send = vi.fn(async (_alert: OwnerAlert) => {});
    const runOnce = async (atMinute: number) => {
      nowMs = atMinute * MINUTE;
      const result = results.shift();
      if (!result) throw new Error('no more results');
      return runIntakeCheckWithAlert(
        async () => result,
        { send },
        () => state,
        (next) => {
          state = next;
        },
        () => nowMs,
      );
    };
    return { send, runOnce, state: () => state };
  }

  test('returns the result unchanged', async () => {
    const { runOnce } = harness([failed, ok]);
    expect(await runOnce(0)).toBe(failed);
    expect(await runOnce(15)).toBe(ok);
  });

  test('sends the decided alert and keeps the next state', async () => {
    const { send, runOnce, state } = harness([failed, failed, ok]);
    await runOnce(0);
    await runOnce(15);
    expect(send).toHaveBeenCalledTimes(1);
    expect(state()).toEqual({ failedRuns: 2, lastAlertAt: 0 });
    await runOnce(30);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toMatchObject({
      kind: 'synthetic_check_recovered',
      detail: 'failed_runs:2',
    });
    expect(state()).toEqual(INITIAL_INTAKE_ALERT_STATE);
  });

  test('a failed send changes nothing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { send, runOnce, state } = harness([failed, failed, ok, ok]);

    send.mockRejectedValueOnce(new Error('channel down'));
    await runOnce(0);
    expect(state()).toEqual(INITIAL_INTAKE_ALERT_STATE);
    expect(errors).toHaveBeenCalledTimes(1);
    const line = String(errors.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toEqual({
      event: 'intake_check_alert_failed',
      kind: 'synthetic_check_failed',
    });
    expect(line).not.toContain('channel down');

    // The next failing run alerts again, since nothing was recorded.
    await runOnce(15);
    expect(send).toHaveBeenCalledTimes(2);
    expect(state()).toEqual({ failedRuns: 1, lastAlertAt: 15 * MINUTE });

    // An all-clear whose send rejects is retried by the next ok.
    send.mockRejectedValueOnce(new Error('channel down'));
    await runOnce(30);
    expect(state()).toEqual({ failedRuns: 1, lastAlertAt: 15 * MINUTE });
    await runOnce(45);
    expect(send).toHaveBeenCalledTimes(4);
    expect(send.mock.calls[3]?.[0]).toMatchObject({ kind: 'synthetic_check_recovered' });
    expect(state()).toEqual(INITIAL_INTAKE_ALERT_STATE);
  });
});
