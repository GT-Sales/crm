/**
 * Pure "failed job queue growth" detector (REQ 40, IMPLEMENTATION_PLAN §10:
 * "Alerts route to the owner ... for: failed-job queue growth"). Kept
 * side-effect-free and timer-free so it is trivially unit-testable; the
 * scheduler wiring owns the actual mutable state and the alert send.
 */

export interface QueueHealthState {
  /** Epoch ms of the first tick that observed a non-zero failed/uncertain count, or undefined if healthy. */
  strugglingSinceMs: number | undefined;
  /** Whether the last observation already triggered an alert, so a repeat tick doesn't re-alert every 60s. */
  alerted: boolean;
  /**
   * Lowest failed+uncertain total seen since the last alert. Failed and
   * uncertain jobs stay until staff resolve them, so a backlog larger than
   * this means a new failure arrived while an older one was still open.
   */
  alertedBacklog: number;
}

export const INITIAL_QUEUE_HEALTH_STATE: QueueHealthState = {
  strugglingSinceMs: undefined,
  alerted: false,
  alertedBacklog: 0,
};

export const QUEUE_STUCK_THRESHOLD_MS = 10 * 60_000;

export interface QueueHealthObservation {
  failed: number;
  uncertain: number;
}

export interface QueueHealthOutcome {
  nextState: QueueHealthState;
  /**
   * True when the threshold is first crossed, and again whenever the backlog
   * grows past what was already alerted (a new failure during the episode).
   */
  shouldAlert: boolean;
}

/**
 * Observations count persisted failed/uncertain jobs across the scheduler's
 * authorized workspaces, not failures newly recorded by one run. This only
 * fires once that backlog has persisted continuously for
 * {@link QUEUE_STUCK_THRESHOLD_MS}, and resets the moment a tick reports a
 * clean queue again.
 */
export function trackQueueHealth(
  state: QueueHealthState,
  observation: QueueHealthObservation,
  nowMs: number,
): QueueHealthOutcome {
  const struggling = observation.failed > 0 || observation.uncertain > 0;
  if (!struggling) {
    return { nextState: INITIAL_QUEUE_HEALTH_STATE, shouldAlert: false };
  }
  const strugglingSinceMs = state.strugglingSinceMs ?? nowMs;
  const durationMs = nowMs - strugglingSinceMs;
  if (durationMs < QUEUE_STUCK_THRESHOLD_MS) {
    return {
      nextState: { strugglingSinceMs, alerted: false, alertedBacklog: 0 },
      shouldAlert: false,
    };
  }
  const backlog = observation.failed + observation.uncertain;
  const shouldAlert = !state.alerted || backlog > state.alertedBacklog;
  return {
    nextState: {
      strugglingSinceMs,
      alerted: true,
      alertedBacklog: shouldAlert ? backlog : Math.min(state.alertedBacklog, backlog),
    },
    shouldAlert,
  };
}
