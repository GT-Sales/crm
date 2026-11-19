'use client';

import * as React from 'react';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';

import { cn } from '../lib/utils';

/**
 * A one-month calendar for picking a calendar day. Days are plain
 * `YYYY-MM-DD` strings and all the arithmetic is done in UTC, so the grid
 * never shifts with the viewer's time zone; `today` comes from the caller
 * (the app decides what "today" is). It is a keyboard-operable grid: one day
 * is in the tab order (arrow keys move by a day or a week, Home and End to the
 * week's ends, PageUp and PageDown by a month, with Shift by a year), Enter or
 * Space picks.
 */

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const DAY_MS = 86_400_000;

function toDate(day: string): Date {
  const [y = 1970, m = 1, d = 1] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fromDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function shiftDays(day: string, days: number): string {
  return fromDate(new Date(toDate(day).getTime() + days * DAY_MS));
}

/** The same day-of-month `months` later, held to the end of a shorter month. */
function shiftMonths(day: string, months: number): string {
  const date = toDate(day);
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), last));
  return fromDate(target);
}

export interface CalendarProps {
  /** The picked day, `YYYY-MM-DD`; empty for none. */
  value?: string;
  /** The caller's today, `YYYY-MM-DD`: marked, and where an empty calendar opens. */
  today: string;
  onSelect(day: string): void;
  className?: string;
}

function Calendar({ value, today, onSelect, className }: CalendarProps) {
  const [cursor, setCursor] = React.useState(value || today);
  const wantsFocus = React.useRef(false);
  const gridRef = React.useRef<HTMLTableElement>(null);
  const titleId = React.useId();

  React.useEffect(() => {
    if (!wantsFocus.current) return;
    wantsFocus.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>('button[tabindex="0"]')?.focus();
  }, [cursor]);

  function move(next: string) {
    wantsFocus.current = true;
    setCursor(next);
  }

  const shown = toDate(cursor);
  const year = shown.getUTCFullYear();
  const month = shown.getUTCMonth();
  const first = new Date(Date.UTC(year, month, 1));
  const length = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const offset = first.getUTCDay();
  const weeks = Math.ceil((offset + length) / 7);

  function onKeyDown(event: React.KeyboardEvent<HTMLTableElement>) {
    const step: Record<string, string> = {
      ArrowLeft: shiftDays(cursor, -1),
      ArrowRight: shiftDays(cursor, 1),
      ArrowUp: shiftDays(cursor, -7),
      ArrowDown: shiftDays(cursor, 7),
      Home: shiftDays(cursor, -toDate(cursor).getUTCDay()),
      End: shiftDays(cursor, 6 - toDate(cursor).getUTCDay()),
      PageUp: shiftMonths(cursor, event.shiftKey ? -12 : -1),
      PageDown: shiftMonths(cursor, event.shiftKey ? 12 : 1),
    };
    const next = step[event.key];
    if (!next) return;
    event.preventDefault();
    move(next);
  }

  return (
    <div data-slot="calendar" className={cn('w-[17rem] max-w-full select-none', className)}>
      <div className="mb-2 flex items-center justify-between gap-1">
        <button
          type="button"
          aria-label="Previous month"
          onClick={() => setCursor(shiftMonths(cursor, -1))}
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <ChevronLeftIcon className="size-4" aria-hidden="true" />
        </button>
        <div id={titleId} aria-live="polite" className="text-sm font-medium">
          {MONTHS[month]} {year}
        </div>
        <button
          type="button"
          aria-label="Next month"
          onClick={() => setCursor(shiftMonths(cursor, 1))}
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <ChevronRightIcon className="size-4" aria-hidden="true" />
        </button>
      </div>
      <table
        ref={gridRef}
        role="grid"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        className="w-full border-collapse"
      >
        <thead>
          <tr>
            {WEEKDAYS.map((name) => (
              <th
                key={name}
                scope="col"
                abbr={name}
                className="pb-1 text-center text-[11px] font-medium text-muted-foreground"
              >
                {name.slice(0, 2)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: weeks }, (_, week) => (
            <tr key={week}>
              {Array.from({ length: 7 }, (_, weekday) => {
                const number = week * 7 + weekday - offset + 1;
                if (number < 1 || number > length) return <td key={weekday} />;
                const day = fromDate(new Date(Date.UTC(year, month, number)));
                const selected = day === value;
                return (
                  <td key={weekday} role="gridcell" aria-selected={selected} className="p-0.5">
                    <button
                      type="button"
                      tabIndex={day === cursor ? 0 : -1}
                      aria-label={`${WEEKDAYS[weekday]}, ${MONTHS[month]} ${number}, ${year}`}
                      aria-current={day === today ? 'date' : undefined}
                      onClick={() => onSelect(day)}
                      className={cn(
                        'inline-flex size-9 w-full items-center justify-center rounded-md text-sm tabular-nums outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                        selected
                          ? 'bg-primary font-medium text-primary-foreground hover:bg-primary/90'
                          : 'hover:bg-accent hover:text-accent-foreground',
                        day === today && !selected && 'font-semibold text-primary',
                        day < today && !selected && 'text-muted-foreground',
                      )}
                    >
                      {number}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export { Calendar };
