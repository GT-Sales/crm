'use client';

import { useState, type KeyboardEvent } from 'react';
import type { LeadStatsResponse } from '@gt-sales/contracts';
import { cn } from '@gt-sales/ui';

/**
 * The dashboard's two pictures: leads received per day, and the partners
 * they came through. One series each, so one hue (validated against the
 * admin's dark card surface) and no legend: the card title names it.
 */
const SERIES = '#3987e5';

const DAY = 24 * 60 * 60 * 1000;

/** `2026-11-02` → `Nov 2`, read in UTC (the counts are UTC days). */
function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-CA', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function utcDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * Every day of the window with its count, the empty ones as zero: the last
 * `days` days up to today, or with no window, from the first day anything
 * arrived.
 */
export function fillDays(
  daily: LeadStatsResponse['daily'],
  days: number | null,
  today: string,
): { day: string; total: number }[] {
  const end = Date.parse(`${today}T00:00:00Z`);
  const first = daily[0]?.day;
  const start =
    days !== null ? end - (days - 1) * DAY : first ? Date.parse(`${first}T00:00:00Z`) : end;
  const counts = new Map(daily.map((entry) => [entry.day, entry.total]));
  const filled: { day: string; total: number }[] = [];
  for (let time = start; time <= end; time += DAY) {
    const day = utcDay(time);
    filled.push({ day, total: counts.get(day) ?? 0 });
  }
  return filled;
}

/** The days the axis names: the first, the middle and the last, each once. */
export function axisDays(series: readonly { day: string }[]): string[] {
  const picks = [0, Math.floor((series.length - 1) / 2), series.length - 1];
  return [...new Set(picks.flatMap((index) => (series[index] ? [series[index].day] : [])))];
}

/** The axis top: the peak rounded up to a clean number (5, 10, 20, 50…). */
export function niceCeiling(peak: number): number {
  if (peak <= 5) return 5;
  const magnitude = 10 ** Math.floor(Math.log10(peak));
  for (const step of [1, 2, 5, 10]) {
    if (peak <= step * magnitude) return step * magnitude;
  }
  return 10 * magnitude;
}

/**
 * Columns per day from one baseline, 4px rounded caps, at most 24px wide with
 * a 2px gap; the peak labelled on its cap. Hover, or focus and the arrow
 * keys, reads any day; the same numbers sit in a table for screen readers.
 */
export function VolumeChart({
  daily,
  days,
  today,
  caption,
}: {
  daily: LeadStatsResponse['daily'];
  days: number | null;
  today: string;
  caption: string;
}) {
  const series = fillDays(daily, days, today);
  const [active, setActive] = useState<number>();
  const peak = Math.max(0, ...series.map((entry) => entry.total));
  const top = niceCeiling(peak);
  const peakIndex = peak > 0 ? series.findIndex((entry) => entry.total === peak) : -1;
  const shown = active === undefined ? undefined : series[active];

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const from = active ?? series.length - 1;
    const next = event.key === 'ArrowLeft' ? from - 1 : from + 1;
    setActive(Math.min(series.length - 1, Math.max(0, next)));
  }

  if (series.length === 0) return null;
  return (
    <figure className="flex flex-col gap-2">
      <div className="flex gap-2">
        <div
          className="flex w-6 flex-col justify-between text-right text-[11px] text-muted-foreground tabular-nums"
          aria-hidden="true"
        >
          <span>{top}</span>
          <span>0</span>
        </div>
        <div
          role="img"
          aria-label={`${caption}: ${peak} at most on one day. Arrow keys read each day.`}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onFocus={() => setActive((current) => current ?? series.length - 1)}
          onBlur={() => setActive(undefined)}
          onPointerLeave={() => setActive(undefined)}
          className="relative flex h-40 flex-1 items-end gap-[2px] border-b border-[#383835] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
        >
          {series.map((entry, index) => (
            <div
              key={entry.day}
              className="relative flex h-full min-w-0 flex-1 items-end justify-center"
              onPointerEnter={() => setActive(index)}
            >
              {index === peakIndex && active === undefined ? (
                <span
                  className="absolute pb-1 text-[11px] text-muted-foreground tabular-nums"
                  style={{ bottom: `${(entry.total / top) * 100}%` }}
                >
                  {entry.total}
                </span>
              ) : null}
              <div
                className="w-full max-w-6 rounded-t-[4px] transition-opacity"
                style={{
                  height: entry.total === 0 ? 0 : `max(2px, ${(entry.total / top) * 100}%)`,
                  backgroundColor: SERIES,
                  opacity: active === undefined || active === index ? 1 : 0.55,
                }}
              />
            </div>
          ))}
          {shown ? (
            <div
              role="status"
              className="pointer-events-none absolute top-0 rounded-md border bg-popover px-2 py-1 text-xs whitespace-nowrap shadow-sm"
              style={{
                left: `${((active ?? 0) / Math.max(1, series.length - 1)) * 100}%`,
                transform: `translateX(-${((active ?? 0) / Math.max(1, series.length - 1)) * 100}%)`,
              }}
            >
              <span className="font-semibold tabular-nums">{shown.total}</span>{' '}
              <span className="text-muted-foreground">on {dayLabel(shown.day)}</span>
            </div>
          ) : null}
        </div>
      </div>
      <div
        className={cn(
          'ml-8 flex text-[11px] text-muted-foreground',
          series.length === 1 ? 'justify-center' : 'justify-between',
        )}
        aria-hidden="true"
      >
        {axisDays(series).map((day) => (
          <span key={day}>{dayLabel(day)}</span>
        ))}
      </div>
      <table className="sr-only">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Received</th>
          </tr>
        </thead>
        <tbody>
          {series
            .filter((entry) => entry.total > 0)
            .map((entry) => (
              <tr key={entry.day}>
                <td>{dayLabel(entry.day)}</td>
                <td>{entry.total}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </figure>
  );
}

/** The ten partners most leads came through: the company, its code, the count and a bar. */
export function TopPartners({ partners }: { partners: LeadStatsResponse['partners'] }) {
  const most = Math.max(1, ...partners.map((entry) => entry.total));
  if (partners.length === 0) {
    return <p className="text-sm text-muted-foreground">No partner sales in this period.</p>;
  }
  return (
    <ol className="flex flex-col gap-2.5" aria-label="Top partners">
      {partners.map((entry) => (
        <li key={entry.code} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate">
              {entry.name ?? entry.code}
              {entry.name ? (
                <span className="ml-2 font-mono text-xs text-muted-foreground">{entry.code}</span>
              ) : null}
            </span>
            <span className="font-semibold tabular-nums">{entry.total}</span>
          </div>
          <div className="h-1.5 w-full" aria-hidden="true">
            <div
              className="h-full rounded-r-[4px]"
              style={{ width: `${(entry.total / most) * 100}%`, backgroundColor: SERIES }}
            />
          </div>
        </li>
      ))}
    </ol>
  );
}
