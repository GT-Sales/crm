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

/** A picked calendar day as the stored due time. */
export function dueAtFromDay(day: string): string {
  return `${day}T12:00:00.000Z`;
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

/** `Due today`, `Due tomorrow`, `Due yesterday`, `Due Mon, Nov 3`. */
export function dueSentence(iso: string, now: Date = new Date()): string {
  const label = dueLabel(iso, now);
  return ['Today', 'Tomorrow', 'Yesterday'].includes(label)
    ? `Due ${label.toLowerCase()}`
    : `Due ${label}`;
}
