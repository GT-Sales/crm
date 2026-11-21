'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { type ReactNode } from 'react';
import type { AnalyticsGroup, FunnelStep } from '@gt-sales/contracts';
import { ChartNoAxesColumnIcon } from 'lucide-react';
import { Card, CardContent, cn } from '@gt-sales/ui';

/** The theme's chart colours (`--chart-1..5`), light and dark. */
export const CHART_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
] as const;

export const color = (index: number) =>
  CHART_COLORS[index % CHART_COLORS.length] ?? 'var(--chart-1)';

export const numberFormat = new Intl.NumberFormat('en-CA');
export const moneyFormat = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });
export const percentFormat = new Intl.NumberFormat('en-CA', {
  style: 'percent',
  maximumFractionDigits: 1,
});

/** "Nov 3", "Week of Nov 3" or "Nov 2026" for a bucket's first day. */
export function bucketLabel(bucket: string, group: AnalyticsGroup): string {
  const date = new Date(`${bucket}T00:00:00.000Z`);
  if (group === 'month')
    return date.toLocaleDateString('en-CA', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const day = date.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return group === 'week' ? `Week of ${day}` : day;
}

/**
 * A chart's card: its title and description, the drawing (hidden from
 * assistive tech) and a visually hidden table of the same numbers.
 */
export function ChartCard({
  id,
  title,
  description,
  summary,
  empty,
  emptyState,
  className,
  drawingIsAccessible = false,
  action,
  children,
}: {
  id: string;
  /** A control beside the title (a link to the full report), shown even when the chart is empty. */
  action?: ReactNode;
  /** The drawing is plain lists and links (no SVG): shown to assistive tech, no extra table. */
  drawingIsAccessible?: boolean;
  title: string;
  description: string;
  summary: { columns: readonly string[]; rows: readonly (readonly (string | number)[])[] };
  /** Shown instead of the chart when there is nothing to draw. */
  empty?: string | undefined;
  /** Shown instead of the chart, in place of `empty`, as a full empty state. */
  emptyState?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Card className={cn('min-w-0 gap-0 py-0', className)}>
      <figure aria-labelledby={`${id}-title`} className="m-0 flex flex-col">
        <div className="crm-card-heading flex-wrap justify-between">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <ChartNoAxesColumnIcon
              className="size-8 shrink-0 rounded-lg border p-2 text-muted-foreground"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <h2 id={`${id}-title`} className="text-base font-medium">
                {title}
              </h2>
              <p className="text-xs text-muted-foreground">{description}</p>
            </div>
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
        <CardContent className="min-w-0 px-5 py-5">
          {emptyState ? (
            emptyState
          ) : empty ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{empty}</p>
          ) : (
            <div aria-hidden={drawingIsAccessible ? undefined : true}>{children}</div>
          )}
          {drawingIsAccessible ? null : (
            <table className="sr-only">
              <caption>{title}</caption>
              <thead>
                <tr>
                  {summary.columns.map((column) => (
                    <th key={column} scope="col">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {summary.rows.map((row, index) => (
                  <tr key={index}>
                    {row.map((cell, cellIndex) =>
                      cellIndex === 0 ? (
                        <th key={cellIndex} scope="row">
                          {cell}
                        </th>
                      ) : (
                        <td key={cellIndex}>{cell}</td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </figure>
    </Card>
  );
}

/** Ranked horizontal bars, each row optionally a link (sources, partners, plans). */
export function BarList({
  items,
  label,
}: {
  items: readonly { key: string; label: string; detail?: string; total: number; href?: string }[];
  label: string;
}) {
  const max = Math.max(1, ...items.map((item) => item.total));
  return (
    <ul aria-label={label} className="flex flex-col gap-2.5">
      {items.map((item) => {
        const body = (
          <>
            <span className="mb-1 flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">
                {item.label}
                {item.detail ? (
                  <span className="ml-1.5 font-mono text-xs text-muted-foreground">
                    {item.detail}
                  </span>
                ) : null}
              </span>
              <span className="font-medium tabular-nums">{numberFormat.format(item.total)}</span>
            </span>
            <span className="block h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
              <span
                className="block h-full rounded-full bg-[var(--chart-1)]"
                style={{ width: `${(item.total / max) * 100}%` }}
              />
            </span>
          </>
        );
        return (
          <li key={item.key}>
            {item.href ? (
              <Link
                href={item.href}
                className="block rounded-md p-1 transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
              >
                {body}
              </Link>
            ) : (
              <div className="p-1">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The funnel: each step's leads and the share that reached it from the step before. */
export function Funnel({
  steps,
  stageLabel,
  hrefOf,
}: {
  steps: readonly FunnelStep[];
  stageLabel: (stage: string) => string;
  hrefOf: (stage: string) => string;
}) {
  const max = Math.max(1, steps[0]?.reached ?? 0);
  return (
    <ol aria-label="Funnel by stage" className="flex flex-col gap-2">
      {steps.map((step, index) => (
        <li key={step.stage}>
          <Link
            href={hrefOf(step.stage)}
            className="group grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)_auto] items-center gap-3 rounded-md p-1 text-sm transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring sm:grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto]"
          >
            <span className="truncate text-muted-foreground">{stageLabel(step.stage)}</span>
            <span className="block h-6 overflow-hidden rounded bg-muted" aria-hidden="true">
              <span
                className="block h-full rounded"
                style={{
                  width: `${(step.reached / max) * 100}%`,
                  background: color(index),
                }}
              />
            </span>
            <span className="text-right tabular-nums">
              <span className="font-medium">{numberFormat.format(step.reached)}</span>
              {step.conversion !== null ? (
                <span className="ml-2 text-xs text-muted-foreground">
                  {percentFormat.format(step.conversion)}
                </span>
              ) : null}
            </span>
          </Link>
        </li>
      ))}
    </ol>
  );
}

/** The drawings' module, and with it the charting library. */
const loadDrawings = () => import('./chart-drawings');
// Asked for as soon as a page with charts runs, while its figures are still
// on their way, so a chart seldom waits for it.
if (typeof window !== 'undefined') void loadDrawings();

/** Keeps a drawing's place in its card until the module is here. */
function holdingPlace(height: number, width?: number) {
  return function ChartLoading() {
    return <div aria-hidden="true" style={{ height, width }} />;
  };
}

/** New leads per bucket, the comparison range as a faint dashed ghost. */
export const TrendChart = dynamic(() => loadDrawings().then((module) => module.TrendChart), {
  ssr: false,
  loading: holdingPlace(248),
});

/** Money per bucket, as bars. */
export const MoneyBars = dynamic(() => loadDrawings().then((module) => module.MoneyBars), {
  ssr: false,
  loading: holdingPlace(220),
});

const DonutDrawing = dynamic(() => loadDrawings().then((module) => module.DonutDrawing), {
  ssr: false,
  loading: holdingPlace(160, 160),
});

/** Parts of a whole as a donut (eSIM vs physical, internet vs mobility), its legend beside it. */
export function Donut({ data }: { data: readonly { label: string; total: number }[] }) {
  const total = data.reduce((sum, entry) => sum + entry.total, 0);
  return (
    <div className="flex flex-wrap items-center gap-6">
      <DonutDrawing data={data} />
      <ul className="flex min-w-0 flex-col gap-2 text-sm">
        {data.map((entry, index) => (
          <li key={entry.label} className="flex items-center gap-2">
            <span className="size-2.5 rounded-sm" style={{ background: color(index) }} />
            <span className="text-muted-foreground">{entry.label}</span>
            <span className="font-medium tabular-nums">{numberFormat.format(entry.total)}</span>
            <span className="text-xs text-muted-foreground tabular-nums">
              {total > 0 ? percentFormat.format(entry.total / total) : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Two stacked bars (payment status, commission status), each split by its values. */
export const StatusBars = dynamic(() => loadDrawings().then((module) => module.StatusBars), {
  ssr: false,
  loading: holdingPlace(140),
});
