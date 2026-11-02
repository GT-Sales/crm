import type { AiPeriod } from '@gt-sales/contracts';

/**
 * Date windows for the assistant's read tools.
 *
 * Two different questions share this module:
 *
 * - "How many leads were received …?" is an instant range over `created_at`.
 *   `today` means the business day in Toronto (with real DST handling), and
 *   7/30/90 days are the same rolling windows the source report uses, so the
 *   assistant's totals agree with the pages staff already trust.
 * - "Which follow-ups are due today?" is a calendar-day question. A task keeps
 *   a calendar day stored at noon UTC (`docs`: `dueCutoff` in
 *   `leads/staff-queries.ts`), so its day is read as the UTC date of `due_at`
 *   and compared with the Toronto day label — never by converting the stored
 *   timestamp into another timezone, which could move it a day.
 */

export const AI_BUSINESS_TIME_ZONE = 'America/Toronto';

export interface ResolvedWindow {
  readonly period: AiPeriod;
  /** Inclusive start instant. */
  readonly start: Date;
  /** Exclusive end instant. */
  readonly end: Date;
  readonly timezone: string;
  /** A short, disambiguated label for source cards and tool output. */
  readonly label: string;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const existing = formatters.get(timeZone);
  if (existing) return existing;
  const created = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  formatters.set(timeZone, created);
  return created;
}

/** The wall-clock fields of one instant in a timezone. */
export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    return found ? Number(found.value) : 0;
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

/** The timezone's offset east of UTC at one instant, in milliseconds. */
function offsetMs(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  const whole = Math.floor(instant.getTime() / 1000) * 1000;
  return asUtc - whole;
}

/**
 * The instant of a local wall-clock time. Two passes settle the offset on the
 * far side of a DST change; a local time that does not exist resolves to the
 * next instant that does, exactly as `Date`-backed scheduling does elsewhere.
 */
export function zonedTimeToInstant(
  year: number,
  month: number,
  day: number,
  timeZone: string,
  hour = 0,
  minute = 0,
): Date {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let instant = target - offsetMs(new Date(target), timeZone);
  instant = target - offsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

/** The business day label (`YYYY-MM-DD`) an instant falls in. */
export function businessDayLabel(instant: Date, timeZone = AI_BUSINESS_TIME_ZONE): string {
  const parts = zonedParts(instant, timeZone);
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  return `${parts.year}-${month}-${day}`;
}

/** The `[start, end)` instants of one business day in Toronto. */
export function businessDayBounds(
  instant: Date,
  timeZone = AI_BUSINESS_TIME_ZONE,
): { start: Date; end: Date; label: string } {
  const parts = zonedParts(instant, timeZone);
  const start = zonedTimeToInstant(parts.year, parts.month, parts.day, timeZone);
  const nextDay = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  const end = zonedTimeToInstant(
    nextDay.getUTCFullYear(),
    nextDay.getUTCMonth() + 1,
    nextDay.getUTCDate(),
    timeZone,
  );
  return { start, end, label: businessDayLabel(instant, timeZone) };
}

const ROLLING_DAYS: Partial<Record<AiPeriod, number>> = {
  last_7_days: 7,
  last_30_days: 30,
  last_90_days: 90,
};

/** The default period when a question names none; always disclosed in the answer. */
export const AI_DEFAULT_PERIOD: AiPeriod = 'last_30_days';

/** Resolves a period into an inclusive start and an exclusive end. */
export function resolvePeriod(
  period: AiPeriod,
  now: Date,
  timeZone = AI_BUSINESS_TIME_ZONE,
): ResolvedWindow {
  if (period === 'today') {
    const day = businessDayBounds(now, timeZone);
    return {
      period,
      start: day.start,
      end: day.end,
      timezone: timeZone,
      label: `today (${day.label}, ${timeZone})`,
    };
  }
  if (period === 'all_time') {
    return {
      period,
      start: new Date(0),
      end: now,
      timezone: timeZone,
      label: 'all time',
    };
  }
  const days = ROLLING_DAYS[period] ?? 30;
  return {
    period,
    start: new Date(now.getTime() - days * 24 * 60 * 60 * 1000),
    end: now,
    timezone: timeZone,
    label: `the last ${days} days`,
  };
}

export type TaskDueFilter = 'any' | 'overdue' | 'due_today' | 'due_today_or_earlier';

export interface TaskDueWindow {
  /** Inclusive lower bound, when the filter has one. */
  readonly from?: Date;
  /** Exclusive upper bound. */
  readonly before?: Date;
  readonly label: string;
}

/**
 * A task's due day compared with the business day label: the cutoff is the
 * next UTC midnight after that label, the same rule `dueCutoff` uses.
 */
export function resolveTaskDueWindow(
  filter: TaskDueFilter,
  now: Date,
  timeZone = AI_BUSINESS_TIME_ZONE,
): TaskDueWindow {
  const label = businessDayLabel(now, timeZone);
  const [yearText = '1970', monthText = '1', dayText = '1'] = label.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const todayStart = new Date(Date.UTC(year, month - 1, day));
  const tomorrowStart = new Date(Date.UTC(year, month - 1, day + 1));
  switch (filter) {
    case 'overdue':
      return { before: todayStart, label: `overdue as of ${label} (${timeZone})` };
    case 'due_today':
      return { from: todayStart, before: tomorrowStart, label: `due on ${label} (${timeZone})` };
    case 'due_today_or_earlier':
      return { before: tomorrowStart, label: `due on or before ${label} (${timeZone})` };
    case 'any':
      return { label: 'any due date' };
  }
}
