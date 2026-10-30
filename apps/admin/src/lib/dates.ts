/**
 * Dates as staff read them. Task due dates are calendar days stored as noon
 * UTC (the same day from UTC−11 to UTC+11, which covers Canada and the team
 * abroad), so a due date's day is read from its UTC date and never shifts
 * with the viewer's time zone.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** `just now`, `5m ago`, `3h ago`, `2d ago`, then the date. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const elapsed = now - Date.parse(iso);
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d ago`;
  const date = new Date(iso);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** The full local date and time, for a tooltip. */
export function dateTimeLabel(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** `YYYY-MM-DD` of a stored due date. */
export function dueDay(iso: string): string {
  return iso.slice(0, 10);
}

/** Today as `YYYY-MM-DD` in the viewer's own calendar. */
export function todayDay(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

const TORONTO_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Toronto',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Today as `YYYY-MM-DD` in America/Toronto, whatever the viewer's own zone:
 * the day an order's dispatch or activation is dated by default, as the
 * backend dates it.
 */
export function torontoDay(now: Date = new Date()): string {
  const parts = TORONTO_PARTS.formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** A picked calendar day as the stored due time. */
export function dueAtFromDay(day: string): string {
  return `${day}T12:00:00.000Z`;
}

/** Whole days from today (the viewer's calendar) to `day`; negative once it has passed. */
export function daysFromToday(day: string, now: Date = new Date()): number {
  return Math.round(
    (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${todayDay(now)}T00:00:00Z`)) / DAY,
  );
}

export type DueTone = 'overdue' | 'today' | 'upcoming';

export function dueTone(iso: string, now: Date = new Date()): DueTone {
  const day = dueDay(iso);
  const today = todayDay(now);
  if (day < today) return 'overdue';
  if (day === today) return 'today';
  return 'upcoming';
}

/** `Today`, `Tomorrow`, `Yesterday`, or `Mon, Nov 3`. */
export function dueLabel(iso: string, now: Date = new Date()): string {
  const day = dueDay(iso);
  const today = todayDay(now);
  const offset = Math.round(
    (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY,
  );
  if (offset === 0) return 'Today';
  if (offset === 1) return 'Tomorrow';
  if (offset === -1) return 'Yesterday';
  return new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * A follow-up's state as Get Canada Sim's admin says it: `Due today`,
 * `Overdue by 3 days`, `Due tomorrow`, `In 5 days`.
 */
export function followUpLabel(iso: string, now: Date = new Date()): string {
  const days = daysFromToday(dueDay(iso), now);
  if (days === 0) return 'Due today';
  if (days < 0) return `Overdue by ${-days} day${days === -1 ? '' : 's'}`;
  if (days === 1) return 'Due tomorrow';
  return `In ${days} days`;
}

export type CountdownTone = 'today' | 'soon' | 'upcoming';

/**
 * How long until a counted-down day (a SIM order's arrival), as Get Canada
 * Sim's admin says it: `Today`, `1 day left`, `6 days left`; a week or less
 * is `soon`, when an unshipped SIM starts to matter. Nothing once the day has
 * passed, or for a value that is not a calendar day: the date alone is then
 * what staff need.
 */
export function countdown(
  day: string,
  now: Date = new Date(),
): { label: string; tone: CountdownTone } | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const days = daysFromToday(day, now);
  if (Number.isNaN(days) || days < 0) return undefined;
  if (days === 0) return { label: 'Today', tone: 'today' };
  if (days === 1) return { label: '1 day left', tone: 'soon' };
  return { label: `${days} days left`, tone: days <= 7 ? 'soon' : 'upcoming' };
}

/** A calendar day as staff read it: `Nov 2`, with the year when it is not this year's. */
export function dayLabel(day: string, now: Date = new Date()): string {
  const date = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(day.slice(0, 4) === String(now.getFullYear()) ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  });
}

/** `Due today`, `Due tomorrow`, `Due yesterday`, `Due Mon, Nov 3`. */
export function dueSentence(iso: string, now: Date = new Date()): string {
  const label = dueLabel(iso, now);
  return ['Today', 'Tomorrow', 'Yesterday'].includes(label)
    ? `Due ${label.toLowerCase()}`
    : `Due ${label}`;
}
