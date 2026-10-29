/**
 * Which restore points to keep: the newest run of each of the last
 * `dailyPoints` calendar days plus the newest run of each of the last
 * `monthlyPoints` calendar months (UTC), 30 and 12 by default. Pure and free
 * of I/O so the policy can be tested exhaustively on its own.
 */

export interface RetentionCandidate {
  runId: string;
  capturedAt: Date;
}

export interface RetentionPolicy {
  dailyPoints: number;
  monthlyPoints: number;
}

export const defaultRetentionPolicy: RetentionPolicy = { dailyPoints: 30, monthlyPoints: 12 };

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/** Returns the run ids that must be retained under the policy. */
export function selectRetainedRunIds(
  candidates: readonly RetentionCandidate[],
  policy: RetentionPolicy = defaultRetentionPolicy,
): Set<string> {
  const sorted = [...candidates].sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime());
  const retained = new Set<string>();

  const seenDays = new Set<string>();
  for (const candidate of sorted) {
    if (seenDays.size >= policy.dailyPoints) break;
    const key = dayKey(candidate.capturedAt);
    if (seenDays.has(key)) continue;
    seenDays.add(key);
    retained.add(candidate.runId);
  }

  const seenMonths = new Set<string>();
  for (const candidate of sorted) {
    if (seenMonths.size >= policy.monthlyPoints) break;
    const key = monthKey(candidate.capturedAt);
    if (seenMonths.has(key)) continue;
    seenMonths.add(key);
    retained.add(candidate.runId);
  }

  return retained;
}
