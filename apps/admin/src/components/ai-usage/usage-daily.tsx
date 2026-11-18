'use client';

import type { AiUsageDay } from '@gt-sales/contracts';
import { useEffect, useRef, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts';

import { bucketLabel, ChartCard, numberFormat } from '../analytics/charts';

/**
 * Turns and tokens per day of the period. Each `day` is a Toronto calendar
 * day as the backend counted it, labelled through `bucketLabel`, which reads
 * the string as a UTC date, so a viewer west of UTC never sees it a day
 * early. The drawing is hidden from assistive tech; `ChartCard` adds a
 * visually hidden table of the same numbers, as the dashboard's charts do.
 */
const axisTick = { fill: 'var(--muted-foreground)', fontSize: 12 };
const tooltipStyle = {
  background: 'var(--popover)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  color: 'var(--popover-foreground)',
  fontSize: 12,
};

/** The width of the drawing, measured; a fixed fallback where there is no ResizeObserver (tests). */
function useWidth(fallback = 560) {
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

/** The day as the axis and the hidden table read it ("Nov 18"). */
export function usageDayLabel(day: string): string {
  return bucketLabel(day, 'day');
}

function Legend({ items }: { items: readonly { label: string; color: string }[] }) {
  return (
    <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm" style={{ background: item.color }} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

function StackedDays({
  rows,
  series,
}: {
  rows: readonly Record<string, string | number>[];
  series: readonly { key: string; label: string; color: string }[];
}) {
  const { ref, width } = useWidth();
  return (
    <div ref={ref} className="w-full">
      <Legend items={series} />
      <BarChart
        accessibilityLayer={false}
        width={width}
        height={220}
        data={[...rows]}
        margin={{ top: 8, right: 8, left: 0 }}
      >
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis dataKey="label" tick={axisTick} tickLine={false} axisLine={false} minTickGap={24} />
        <YAxis
          allowDecimals={false}
          tick={axisTick}
          tickLine={false}
          axisLine={false}
          width={56}
          tickFormatter={(value: number) => numberFormat.format(value)}
        />
        <Tooltip
          contentStyle={tooltipStyle}
          cursor={{ fill: 'var(--muted)', opacity: 0.5 }}
          formatter={(value) => numberFormat.format(Number(value))}
        />
        {series.map((entry, index) => (
          <Bar
            key={entry.key}
            dataKey={entry.key}
            name={entry.label}
            stackId="day"
            fill={entry.color}
            radius={index === series.length - 1 ? [3, 3, 0, 0] : 0}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </div>
  );
}

const FAILED = 'var(--crm-danger)';

export function UsageDaily({ daily }: { daily: readonly AiUsageDay[] }) {
  const turns = daily.reduce((sum, day) => sum + day.turns, 0);
  const tokens = daily.reduce((sum, day) => sum + day.inputTokens + day.outputTokens, 0);
  const empty = turns === 0 ? 'No activity in this period' : undefined;
  const rows = daily.map((day) => ({
    label: usageDayLabel(day.day),
    ok: day.turns - day.failedTurns,
    failed: day.failedTurns,
    inputTokens: day.inputTokens,
    outputTokens: day.outputTokens,
  }));
  return (
    <section aria-label="Per day" className="grid gap-6 xl:grid-cols-2">
      <ChartCard
        id="chart-ai-turns"
        title="Turns per day"
        description={`${numberFormat.format(turns)} turns, by day in Toronto`}
        empty={empty}
        summary={{
          columns: ['Day', 'Turns', 'Failed'],
          rows: daily.map((day) => [usageDayLabel(day.day), day.turns, day.failedTurns]),
        }}
      >
        <StackedDays
          rows={rows}
          series={[
            { key: 'ok', label: 'Did not fail', color: 'var(--chart-1)' },
            { key: 'failed', label: 'Failed', color: FAILED },
          ]}
        />
      </ChartCard>
      <ChartCard
        id="chart-ai-tokens"
        title="Tokens per day"
        description={`${numberFormat.format(tokens)} tokens, by day in Toronto`}
        empty={empty}
        summary={{
          columns: ['Day', 'Tokens in', 'Tokens out'],
          rows: daily.map((day) => [usageDayLabel(day.day), day.inputTokens, day.outputTokens]),
        }}
      >
        <StackedDays
          rows={rows}
          series={[
            { key: 'inputTokens', label: 'Tokens in', color: 'var(--chart-1)' },
            { key: 'outputTokens', label: 'Tokens out', color: 'var(--chart-3)' },
          ]}
        />
      </ChartCard>
    </section>
  );
}
