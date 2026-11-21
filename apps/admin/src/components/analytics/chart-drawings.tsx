'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Pie,
  PieChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { AnalyticsGroup } from '@gt-sales/contracts';
import { bucketLabel, color, moneyFormat } from './charts';

/**
 * The drawings that need the charting library. `charts.tsx` loads this
 * module on demand, so the library is not part of a page's first JavaScript.
 */

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
      <ComposedChart
        accessibilityLayer={false}
        width={width}
        height={248}
        data={rows}
        margin={{ top: 8, right: 8, left: -16 }}
      >
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis dataKey="label" tick={axisTick} tickLine={false} axisLine={false} minTickGap={24} />
        <YAxis allowDecimals={false} tick={axisTick} tickLine={false} axisLine={false} width={48} />
        <Tooltip contentStyle={tooltipStyle} />
        {comparing ? (
          <Area
            type="monotone"
            dataKey="previous"
            name="Comparison"
            stroke="var(--muted-foreground)"
            strokeOpacity={0.45}
            strokeDasharray="4 4"
            fill="none"
            dot={false}
            isAnimationActive={false}
          />
        ) : null}
        <Area
          type="monotone"
          dataKey="current"
          name="This period"
          stroke="var(--foreground)"
          fill="var(--foreground)"
          fillOpacity={0.07}
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      </ComposedChart>
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
      <BarChart
        accessibilityLayer={false}
        width={width}
        height={220}
        data={rows}
        margin={{ top: 8, right: 8, left: 0 }}
      >
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

/** The donut itself; `Donut` in `charts.tsx` puts its legend beside it. */
export function DonutDrawing({ data }: { data: readonly { label: string; total: number }[] }) {
  return (
    <PieChart accessibilityLayer={false} width={160} height={160}>
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
        accessibilityLayer={false}
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
