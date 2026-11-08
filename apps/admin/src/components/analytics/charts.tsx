'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { AnalyticsGroup, FunnelStep } from '@gt-sales/contracts';
import { Card, CardContent, cn } from '@gt-sales/ui';

/** The theme's chart colours (`--chart-1..5`), light and dark. */
export const CHART_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
] as const;

const color = (index: number) => CHART_COLORS[index % CHART_COLORS.length] ?? 'var(--chart-1)';

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

/** The width of a box, measured; a fixed fallback where there is no ResizeObserver (tests). */
function useWidth(fallback = 640) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const measure = () => setWidth(Math.max(240, Math.floor(node.getBoundingClientRect().width)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
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
  className,
  drawingIsAccessible = false,
  children,
}: {
  id: string;
  /** The drawing is plain lists and links (no SVG): shown to assistive tech, no extra table. */
  drawingIsAccessible?: boolean;
  title: string;
  description: string;
  summary: { columns: readonly string[]; rows: readonly (readonly (string | number)[])[] };
  /** Shown instead of the chart when there is nothing to draw. */
  empty?: string | undefined;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Card className={cn('min-w-0', className)}>
      <figure aria-labelledby={`${id}-title`} className="m-0 flex flex-col gap-3">
        <div className="px-6">
          <h2 id={`${id}-title`} className="text-base font-medium">
            {title}
          </h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        <CardContent className="min-w-0">
          {empty ? (
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

const axisTick = { fill: 'var(--muted-foreground)', fontSize: 12 };
const tooltipStyle = {
  background: 'var(--popover)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  color: 'var(--popover-foreground)',
  fontSize: 12,
};

/** New leads per bucket, the comparison range as a faint dashed ghost. */
export function TrendChart({
  data,
  group,
  comparing,
}: {
  data: readonly { bucket: string; current: number; previous: number | null }[];
  group: AnalyticsGroup;
  comparing: boolean;
}) {
  const { ref, width } = useWidth();
  const rows = data.map((entry) => ({ ...entry, label: bucketLabel(entry.bucket, group) }));
  return (
    <div ref={ref} className="w-full">
      <LineChart width={width} height={240} data={rows} margin={{ top: 8, right: 8, left: -16 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis dataKey="label" tick={axisTick} tickLine={false} axisLine={false} minTickGap={24} />
        <YAxis allowDecimals={false} tick={axisTick} tickLine={false} axisLine={false} width={48} />
        <Tooltip contentStyle={tooltipStyle} />
        {comparing ? (
          <Line
            type="monotone"
            dataKey="previous"
            name="Comparison"
            stroke="var(--muted-foreground)"
            strokeOpacity={0.45}
            strokeDasharray="4 4"
            dot={false}
            isAnimationActive={false}
          />
        ) : null}
        <Line
          type="monotone"
          dataKey="current"
          name="This period"
          stroke="var(--chart-1)"
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </div>
  );
}

/** Money per bucket, as bars. */
export function MoneyBars({
  data,
  group,
}: {
  data: readonly { bucket: string; earnedMinor: number }[];
  group: AnalyticsGroup;
}) {
  const { ref, width } = useWidth();
  const rows = data.map((entry) => ({
    label: bucketLabel(entry.bucket, group),
    earned: entry.earnedMinor / 100,
  }));
  return (
    <div ref={ref} className="w-full">
      <BarChart width={width} height={220} data={rows} margin={{ top: 8, right: 8, left: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis dataKey="label" tick={axisTick} tickLine={false} axisLine={false} minTickGap={24} />
        <YAxis
          tick={axisTick}
          tickLine={false}
          axisLine={false}
          width={64}
          tickFormatter={(value: number) => moneyFormat.format(value)}
        />
        <Tooltip
          contentStyle={tooltipStyle}
          formatter={(value) => moneyFormat.format(Number(value))}
        />
        <Bar
          dataKey="earned"
          name="Earned"
          fill="var(--chart-2)"
          radius={[4, 4, 0, 0]}
          isAnimationActive={false}
        />
      </BarChart>
    </div>
  );
}

/** Parts of a whole as a donut (eSIM vs physical, internet vs mobility). */
export function Donut({ data }: { data: readonly { label: string; total: number }[] }) {
  const total = data.reduce((sum, entry) => sum + entry.total, 0);
  return (
    <div className="flex flex-wrap items-center gap-6">
      <PieChart width={160} height={160}>
        <Pie
          data={[...data]}
          dataKey="total"
          nameKey="label"
          innerRadius={48}
          outerRadius={72}
          stroke="var(--card)"
          isAnimationActive={false}
        >
          {data.map((entry, index) => (
            <Cell key={entry.label} fill={color(index)} />
          ))}
        </Pie>
        <Tooltip contentStyle={tooltipStyle} />
      </PieChart>
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
export function StatusBars({
  rows,
}: {
  rows: readonly {
    label: string;
    parts: readonly { key: string; label: string; total: number }[];
  }[];
}) {
  const { ref, width } = useWidth();
  const keys = [...new Set(rows.flatMap((row) => row.parts.map((part) => part.key)))];
  const labels = new Map(rows.flatMap((row) => row.parts.map((part) => [part.key, part.label])));
  const data = rows.map((row) => ({
    row: row.label,
    ...Object.fromEntries(row.parts.map((part) => [part.key, part.total])),
  }));
  return (
    <div ref={ref} className="w-full">
      <BarChart
        width={width}
        height={140}
        data={data}
        layout="vertical"
        margin={{ top: 4, right: 8, left: 8, bottom: 4 }}
      >
        <XAxis type="number" hide allowDecimals={false} />
        <YAxis
          type="category"
          dataKey="row"
          tick={axisTick}
          tickLine={false}
          axisLine={false}
          width={96}
        />
        <Tooltip contentStyle={tooltipStyle} />
        {keys.map((key, index) => (
          <Bar
            key={key}
            dataKey={key}
            name={labels.get(key) ?? key}
            stackId="status"
            fill={color(index)}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {keys.map((key, index) => (
          <li key={key} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: color(index) }} />
            {labels.get(key) ?? key}
          </li>
        ))}
      </ul>
    </div>
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
