'use client';

import { useMemo, useState, type ReactNode } from 'react';
import type { WebAnalyticsDays, WebAnalyticsReport, WebAnalyticsTotals } from '@gt-sales/contracts';
import { Card, CardContent, cn } from '@gt-sales/ui';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ClockIcon,
  EyeIcon,
  LogOutIcon,
  MousePointerClickIcon,
  RadioIcon,
  UsersIcon,
  type LucideIcon,
} from 'lucide-react';

import { getWebAnalytics } from '../../lib/api';
import { describeError } from '../../lib/error-text';
import { useResource } from '../../lib/use-resource';
import { BarList, ChartCard, TrendChart, numberFormat } from '../analytics/charts';
import { LoadingSkeleton } from '../crm/loading-skeleton';
import { useStaffSession } from '../staff-session-provider';

const PERIODS: readonly { days: WebAnalyticsDays; label: string }[] = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
];

const UNAVAILABLE: Record<'not_configured' | 'no_website' | 'unreachable', string> = {
  not_configured:
    'Website analytics is not connected yet. The owner connects Umami by adding its address and an API key to the CRM’s settings.',
  no_website: 'This site has no Umami website linked yet, so there is no traffic to show for it.',
  unreachable: 'Umami did not answer just now. Try again in a minute.',
};

/** `1m 05s`, `42s`, `2h 03m`. */
export function durationLabel(seconds: number): string {
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes}m ${String(whole % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

const percent = new Intl.NumberFormat('en-CA', { style: 'percent', maximumFractionDigits: 0 });

/** Share of visits that left after one page; null when there were no visits. */
function bounceRate(totals: WebAnalyticsTotals): number | null {
  return totals.visits > 0 ? Math.min(1, totals.bounces / totals.visits) : null;
}

function averageVisit(totals: WebAnalyticsTotals): number | null {
  return totals.visits > 0 ? totals.totalSeconds / totals.visits : null;
}

const countryNames =
  typeof Intl.DisplayNames === 'function'
    ? new Intl.DisplayNames(['en'], { type: 'region' })
    : undefined;

/** `CA` → `Canada`; anything Umami sends that is not a country code stays as it is. */
function countryLabel(code: string): string {
  if (!/^[A-Z]{2}$/.test(code)) return code;
  try {
    return countryNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

function deviceLabel(device: string): string {
  return device === '' ? device : `${device.charAt(0).toUpperCase()}${device.slice(1)}`;
}

/** The change from the period before; nothing when there is nothing to compare with. */
function Change({
  current,
  previous,
  lowerIsBetter = false,
}: {
  current: number | null;
  previous: number | null;
  lowerIsBetter?: boolean;
}) {
  if (current === null || previous === null || previous === 0) return null;
  const change = (current - previous) / previous;
  if (!Number.isFinite(change)) return null;
  const up = change > 0;
  const good = change === 0 ? undefined : up !== lowerIsBetter;
  const Icon = up ? ArrowUpIcon : ArrowDownIcon;
  return (
    <p
      className={cn(
        'flex items-center gap-1 text-xs font-medium',
        good === true && 'text-emerald-700 dark:text-emerald-400',
        good === false && 'text-rose-700 dark:text-rose-400',
        good === undefined && 'text-muted-foreground',
      )}
    >
      {change === 0 ? null : <Icon className="size-3" aria-hidden="true" />}
      {percent.format(Math.abs(change))} {up ? 'more' : change === 0 ? 'no change' : 'less'}
      <span className="font-normal text-muted-foreground">than the period before</span>
    </p>
  );
}

function Tile({
  label,
  value,
  hint,
  icon: Icon,
  children,
}: {
  label: string;
  value: string;
  hint: string;
  icon: LucideIcon;
  children?: ReactNode;
}) {
  return (
    <div
      data-tone="info"
      className="crm-stat flex min-h-[7.5rem] flex-col justify-center gap-2 px-5 py-4"
    >
      <h2 className="flex items-center gap-2 text-sm font-normal text-muted-foreground">
        <Icon className="crm-stat-icon size-4 shrink-0" aria-hidden="true" />
        {label}
      </h2>
      <p className="text-2xl font-semibold tracking-tight tabular-nums sm:text-3xl">{value}</p>
      {children}
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

function TopList({
  id,
  title,
  description,
  column,
  rows,
  empty,
}: {
  id: string;
  title: string;
  description: string;
  column: string;
  rows: readonly { label: string; total: number }[];
  empty: string;
}) {
  return (
    <ChartCard
      id={id}
      drawingIsAccessible
      title={title}
      description={description}
      empty={rows.length === 0 ? empty : undefined}
      summary={{ columns: [column, 'Visitors'], rows: rows.map((row) => [row.label, row.total]) }}
    >
      <BarList
        label={title}
        items={rows.map((row) => ({ key: row.label, label: row.label, total: row.total }))}
      />
    </ChartCard>
  );
}

function Report({ report }: { report: WebAnalyticsReport }) {
  const { totals, previous } = report;
  const bounce = bounceRate(totals);
  const visit = averageVisit(totals);
  return (
    <div className="flex flex-col gap-6">
      <section aria-label="Key figures">
        <div className="crm-stat-grid grid grid-cols-1 overflow-hidden rounded-2xl border bg-card min-[480px]:grid-cols-2 lg:grid-cols-3">
          <Tile
            label="Visitors"
            value={numberFormat.format(totals.visitors)}
            hint="Different people who came to the website"
            icon={UsersIcon}
          >
            <Change current={totals.visitors} previous={previous.visitors} />
          </Tile>
          <Tile
            label="Page views"
            value={numberFormat.format(totals.pageviews)}
            hint="Pages opened, all visitors together"
            icon={EyeIcon}
          >
            <Change current={totals.pageviews} previous={previous.pageviews} />
          </Tile>
          <Tile
            label="Visits"
            value={numberFormat.format(totals.visits)}
            hint="A visitor coming back later counts again"
            icon={MousePointerClickIcon}
          >
            <Change current={totals.visits} previous={previous.visits} />
          </Tile>
          <Tile
            label="Left after one page"
            value={bounce === null ? '—' : percent.format(bounce)}
            hint="Visits that saw one page and did nothing else"
            icon={LogOutIcon}
          >
            <Change current={bounce} previous={bounceRate(previous)} lowerIsBetter />
          </Tile>
          <Tile
            label="Average visit"
            value={visit === null ? '—' : durationLabel(visit)}
            hint="Time on the website per visit"
            icon={ClockIcon}
          >
            <Change current={visit} previous={averageVisit(previous)} />
          </Tile>
          <Tile
            label="On the website now"
            value={report.activeNow === null ? '—' : numberFormat.format(report.activeNow)}
            hint="Visitors in the last five minutes"
            icon={RadioIcon}
          />
        </div>
      </section>

      <ChartCard
        id="web-visitors"
        title="Visitors per day"
        description="Different people who came to the website each day."
        empty={totals.visitors === 0 ? 'No visitors in this period.' : undefined}
        summary={{
          columns: ['Day', 'Visitors', 'Page views'],
          rows: report.daily.map((entry) => [entry.day, entry.visitors, entry.pageviews]),
        }}
      >
        <TrendChart
          group="day"
          comparing={false}
          data={report.daily.map((entry) => ({
            bucket: entry.day,
            current: entry.visitors,
            previous: null,
          }))}
        />
      </ChartCard>

      <div className="grid gap-6 xl:grid-cols-2">
        <TopList
          id="web-pages"
          title="Most visited pages"
          description="The pages most visitors opened."
          column="Page"
          rows={report.pages}
          empty="No page views in this period."
        />
        <TopList
          id="web-referrers"
          title="Where visitors came from"
          description="The websites that sent visitors here."
          column="Website"
          rows={report.referrers}
          empty="No visitors from other websites in this period."
        />
        <TopList
          id="web-countries"
          title="Countries"
          description="Where visitors were when they came."
          column="Country"
          rows={report.countries.map((row) => ({ ...row, label: countryLabel(row.label) }))}
          empty="No visitors in this period."
        />
        <TopList
          id="web-devices"
          title="Devices"
          description="What visitors used to open the website."
          column="Device"
          rows={report.devices.map((row) => ({ ...row, label: deviceLabel(row.label) }))}
          empty="No visitors in this period."
        />
      </div>
    </div>
  );
}

/**
 * Analytics: one site's website traffic, read from its Umami website. Totals
 * only (no customer details), for the last 7, 30 or 90 days, each figure with
 * its change from the same number of days before.
 */
export function WebAnalytics({ workspaceSlug }: { workspaceSlug: string }) {
  const { accessToken, workspaces } = useStaffSession();
  const workspaceId = workspaces.find((entry) => entry.slug === workspaceSlug)?.id;
  const [days, setDays] = useState<WebAnalyticsDays>(30);
  const load = useMemo(
    () =>
      accessToken && workspaceId
        ? () => getWebAnalytics(accessToken, workspaceId, { days })
        : undefined,
    [accessToken, workspaceId, days],
  );
  const analytics = useResource(load);
  // A report for another period is not this period's: show the skeleton, not stale figures.
  const data =
    analytics.data?.report?.days === days || analytics.data?.report === null
      ? analytics.data
      : undefined;

  if (!accessToken || !workspaceId) return null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <div
          role="group"
          aria-label="Period"
          className="inline-flex overflow-hidden rounded-lg border bg-card text-sm"
        >
          {PERIODS.map((period) => (
            <button
              key={period.days}
              type="button"
              aria-pressed={days === period.days}
              onClick={() => setDays(period.days)}
              className={cn(
                'border-l px-3 py-1.5 first:border-l-0 hover:bg-muted/50',
                days === period.days && 'bg-primary/10 font-medium text-primary',
              )}
            >
              Last {period.label}
            </button>
          ))}
        </div>
        {data?.report ? (
          <p className="text-sm text-muted-foreground">
            {data.report.from} to {data.report.to}, compared with the {days} days before
          </p>
        ) : null}
      </div>

      {analytics.error && !data ? (
        <p role="alert" className="text-sm text-destructive">
          {describeError(analytics.failure, 'load the analytics')}
        </p>
      ) : !data ? (
        <LoadingSkeleton label="Loading analytics…" variant="dashboard" />
      ) : data.report ? (
        <Report report={data.report} />
      ) : (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            <p role="status">{UNAVAILABLE[data.unavailable ?? 'unreachable']}</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
