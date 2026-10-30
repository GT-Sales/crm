import { describe, expect, it } from 'vitest';

import { torontoDay } from './dates';

describe('torontoDay', () => {
  it('is the calendar day in Toronto, which is still the day before just after midnight UTC', () => {
    // 23:30 in Toronto (EDT, UTC−4) on 30 October.
    expect(torontoDay(new Date('2026-10-31T03:30:00.000Z'))).toBe('2026-10-30');
    // 23:30 in Toronto (EST, UTC−5) on 30 November.
    expect(torontoDay(new Date('2026-12-01T04:30:00.000Z'))).toBe('2026-11-30');
  });

  it('turns to the next day at midnight in Toronto', () => {
    expect(torontoDay(new Date('2026-10-31T04:00:00.000Z'))).toBe('2026-10-31');
    expect(torontoDay(new Date('2027-01-01T05:00:00.000Z'))).toBe('2027-01-01');
  });
});
