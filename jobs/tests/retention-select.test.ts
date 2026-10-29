import { describe, expect, it } from 'vitest';

import {
  defaultRetentionPolicy,
  selectRetainedRunIds,
  type RetentionCandidate,
} from '../src/retention/select.js';

function daysAgo(n: number): Date {
  const d = new Date('2026-09-14T02:00:00.000Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

describe('selectRetainedRunIds', () => {
  it('retains the most recent 30 distinct days', () => {
    const candidates: RetentionCandidate[] = Array.from({ length: 40 }, (_, i) => ({
      runId: `run-${i}`,
      capturedAt: daysAgo(i),
    }));
    const retained = selectRetainedRunIds(candidates, { dailyPoints: 30, monthlyPoints: 0 });
    expect(retained.size).toBe(30);
    expect(retained.has('run-0')).toBe(true);
    expect(retained.has('run-29')).toBe(true);
    expect(retained.has('run-30')).toBe(false);
  });

  it('keeps only the latest run when several exist on the same calendar day', () => {
    const sameDay = new Date('2026-09-14T01:00:00.000Z');
    const laterSameDay = new Date('2026-09-14T20:00:00.000Z');
    const candidates: RetentionCandidate[] = [
      { runId: 'morning', capturedAt: sameDay },
      { runId: 'evening', capturedAt: laterSameDay },
    ];
    const retained = selectRetainedRunIds(candidates, { dailyPoints: 30, monthlyPoints: 0 });
    expect(retained).toEqual(new Set(['evening']));
  });

  it('adds up to 12 monthly points beyond the daily window', () => {
    const candidates: RetentionCandidate[] = Array.from({ length: 400 }, (_, i) => ({
      runId: `run-${i}`,
      capturedAt: daysAgo(i),
    }));
    const retained = selectRetainedRunIds(candidates, { dailyPoints: 30, monthlyPoints: 12 });
    // 30 daily + up to 12 additional distinct months (some months overlap the
    // daily window, so the total is <= 42 and > 30).
    expect(retained.size).toBeGreaterThan(30);
    expect(retained.size).toBeLessThanOrEqual(42);
  });

  it('retains nothing when there are no candidates', () => {
    expect(selectRetainedRunIds([]).size).toBe(0);
  });

  it('defaults to 30 daily and 12 monthly points', () => {
    expect(defaultRetentionPolicy).toEqual({ dailyPoints: 30, monthlyPoints: 12 });
    const candidates: RetentionCandidate[] = Array.from({ length: 400 }, (_, i) => ({
      runId: `run-${i}`,
      capturedAt: daysAgo(i),
    }));
    expect(selectRetainedRunIds(candidates)).toEqual(
      selectRetainedRunIds(candidates, { dailyPoints: 30, monthlyPoints: 12 }),
    );
  });

  it('a monthly point is the latest run of each of the most recent months', () => {
    // 2026-09-14 back 400 days: the daily window covers 16 Aug to 14 Sep, so
    // the monthly points are the newest run of Sep 2026 back to Oct 2025.
    const candidates: RetentionCandidate[] = Array.from({ length: 400 }, (_, i) => ({
      runId: daysAgo(i).toISOString().slice(0, 10),
      capturedAt: daysAgo(i),
    }));
    const retained = selectRetainedRunIds(candidates, { dailyPoints: 30, monthlyPoints: 12 });
    const monthly = [...retained].filter((runId) => runId < '2026-08-16').sort();
    expect(monthly).toEqual([
      '2025-10-31',
      '2025-11-30',
      '2025-12-31',
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
      '2026-06-30',
      '2026-07-31',
    ]);
    expect(retained.size).toBe(40);
  });

  it('honours a smaller policy', () => {
    const candidates: RetentionCandidate[] = Array.from({ length: 100 }, (_, i) => ({
      runId: `run-${i}`,
      capturedAt: daysAgo(i),
    }));
    const retained = selectRetainedRunIds(candidates, { dailyPoints: 3, monthlyPoints: 1 });
    expect(retained).toEqual(new Set(['run-0', 'run-1', 'run-2']));
  });
});
