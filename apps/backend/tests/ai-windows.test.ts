import { describe, expect, it } from 'vitest';

import {
  businessDayLabel,
  resolvePeriod,
  resolveTaskDueWindow,
  zonedTimeToInstant,
} from '../src/ai/windows.js';

const TORONTO = 'America/Toronto';

describe('resolvePeriod', () => {
  it('resolves today to the Toronto business day, not the UTC day', () => {
    // 01:30 UTC on 2 November is still 1 November in Toronto (EDT→EST night).
    const now = new Date('2026-11-02T01:30:00.000Z');
    const window = resolvePeriod('today', now);
    expect(window.start.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(window.label).toContain('2026-11-01');
    expect(window.timezone).toBe(TORONTO);
  });

  it('handles the 25-hour day when daylight saving ends', () => {
    const now = new Date('2026-11-02T03:30:00.000Z');
    const window = resolvePeriod('today', now);
    const hours = (window.end.getTime() - window.start.getTime()) / 3_600_000;
    expect(hours).toBe(25);
  });

  it('handles the 23-hour day when daylight saving starts', () => {
    const now = new Date('2026-03-08T16:00:00.000Z');
    const window = resolvePeriod('today', now);
    expect(window.start.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect((window.end.getTime() - window.start.getTime()) / 3_600_000).toBe(23);
  });

  it('uses rolling windows for 7/30/90 days, ending now', () => {
    const now = new Date('2026-11-02T12:00:00.000Z');
    for (const [period, days] of [
      ['last_7_days', 7],
      ['last_30_days', 30],
      ['last_90_days', 90],
    ] as const) {
      const window = resolvePeriod(period, now);
      expect(window.end.toISOString()).toBe(now.toISOString());
      expect(window.start.toISOString()).toBe(
        new Date(now.getTime() - days * 24 * 3_600_000).toISOString(),
      );
    }
  });

  it('resolves all time from the epoch without inventing a start date', () => {
    const window = resolvePeriod('all_time', new Date('2026-11-02T12:00:00.000Z'));
    expect(window.start.getTime()).toBe(0);
    expect(window.label).toBe('all time');
  });
});

describe('resolveTaskDueWindow', () => {
  // 2026-11-02 01:30 UTC is 2026-11-01 21:30 in Toronto.
  const now = new Date('2026-11-02T01:30:00.000Z');

  it('measures "due today or earlier" against the next UTC midnight of the Toronto day', () => {
    const window = resolveTaskDueWindow('due_today_or_earlier', now);
    expect(window.before?.toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(window.from).toBeUndefined();
    expect(window.label).toContain('2026-11-01');
  });

  it('keeps overdue strictly before today and due-today inside the day', () => {
    const overdue = resolveTaskDueWindow('overdue', now);
    expect(overdue.before?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    const dueToday = resolveTaskDueWindow('due_today', now);
    expect(dueToday.from?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(dueToday.before?.toISOString()).toBe('2026-11-02T00:00:00.000Z');
  });

  it('leaves any due date unfiltered', () => {
    const window = resolveTaskDueWindow('any', now);
    expect(window.from).toBeUndefined();
    expect(window.before).toBeUndefined();
  });
});

describe('zonedTimeToInstant', () => {
  it('round-trips a midnight through the timezone', () => {
    expect(zonedTimeToInstant(2026, 11, 2, TORONTO).toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(businessDayLabel(new Date('2026-11-02T04:59:59.999Z'))).toBe('2026-11-01');
    expect(businessDayLabel(new Date('2026-11-02T05:00:00.000Z'))).toBe('2026-11-02');
  });
});
