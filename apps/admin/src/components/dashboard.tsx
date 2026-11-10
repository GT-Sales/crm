'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo, type ReactNode } from 'react';
import {
  analyticsDelta,
  analyticsFunnel,
  leadStageLabel,
  leadTypeLabel,
  type AnalyticsCompared,
  type AnalyticsResponse,
} from '@gt-sales/contracts';
import { Card, CardContent, cn } from '@gt-sales/ui';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BellRingIcon,
  CircleCheckIcon,
  CoinsIcon,
  FileCheckIcon,
  InboxIcon,
  PercentIcon,
  WalletIcon,
  type LucideIcon,
} from 'lucide-react';

import {
  getAnalytics,
  getLeadsSummary,
  listPlans,
  listStaffTasks,
  listWorkspaceMembers,
} from '../lib/api';
import { dueTone, followUpLabel, todayDay } from '../lib/dates';
import { memberName } from '../lib/people';
import { busiest } from '../lib/stats-windows';
import { useResource } from '../lib/use-resource';
import {
  COMPARE_LABELS,
  analyticsQueryOf,
  dashboardSearch,
  leadsHref,
  parseDashboardState,
  type DashboardState,
} from './analytics/analytics-query';
import {
  BarList,
  ChartCard,
  Donut,
  Funnel,
  MoneyBars,
  StatusBars,
  TrendChart,
  bucketLabel,
  moneyFormat,
  numberFormat,
  percentFormat,
} from './analytics/charts';
import { FilterBar, rangeLabel } from './analytics/filter-bar';
import { LoadingSkeleton } from './crm/loading-skeleton';
import { leadDisplayName } from './leads/lead-display';
import { useStaffSession } from './staff-session-provider';

/** As many follow-ups as the card lists before "Open the follow-ups in Leads". */
const SHOWN = 6;

/** The lead types whose leads carry documents to review. */
const DOCUMENT_TYPES = new Set(['sim_order', 'mobility']);

const STATUS_LABELS: Record<string, string> = {
  not_needed: 'Not needed',
  pending: 'Pending',
  paid: 'Paid',
  not_yet: 'Not yet',
  invoiced: 'Invoiced',
  received: 'Received',
  clawback: 'Clawback',
  '(not set)': 'Not set',
};

const statusLabel = (key: string) =>
  STATUS_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1).replaceAll('_', ' ');

/**
 * The site's analytics dashboard. A sticky filter bar (period, comparison,
 * grouping, filters) drives every card; its state lives in the URL so a view
 * can be shared. Counts are for every role; the money cards and the
 * commission chart appear only when the backend sent them (the owner).
 */
export function Dashboard({ workspaceSlug }: { workspaceSlug: string }) {
  const { accessToken, workspaces } = useStaffSession();
  const workspaceId = workspaces.find((entry) => entry.slug === workspaceSlug)?.id;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlKey = searchParams.toString();
  const state = useMemo(() => parseDashboardState(new URLSearchParams(urlKey)), [urlKey]);

  const loadSummary = useMemo(
    () =>
      accessToken && workspaceId ? () => getLeadsSummary(accessToken, workspaceId) : undefined,
    [accessToken, workspaceId],
  );
  const summary = useResource(loadSummary);
  const types = useMemo(
    () => (summary.data?.types ?? []).map((entry) => entry.leadType),
    [summary.data],
  );
  // No type in the URL: the site's busiest; `all` is every type.
  const leadType =
    state.type === 'all'
      ? undefined
      : state.type && types.includes(state.type)
        ? state.type
        : busiest(summary.data?.types ?? []);

  const loadMembers = useMemo(
    () =>
      accessToken && workspaceId ? () => listWorkspaceMembers(accessToken, workspaceId) : undefined,
    [accessToken, workspaceId],
  );
  const members = useResource(loadMembers).data?.members ?? [];
  const loadPlans = useMemo(
    () =>
      accessToken && workspaceId
        ? () => listPlans(accessToken, workspaceId, { includeInactive: 'true' })
        : undefined,
    [accessToken, workspaceId],
  );
  const plans = useResource(loadPlans).data?.plans ?? [];

  const query = useMemo(() => analyticsQueryOf(state, leadType), [state, leadType]);
  const loadAnalytics = useMemo(
    () =>
      accessToken && workspaceId && summary.data
        ? () => getAnalytics(accessToken, workspaceId, query)
        : undefined,
    [accessToken, workspaceId, summary.data, query],
  );
  const analytics = useResource(loadAnalytics);
  const data = analytics.data;

  const update = (next: DashboardState) =>
    router.replace(`${pathname}${dashboardSearch(next)}`, { scroll: false });

  if (!summary.data && !summary.error) {
    return <LoadingSkeleton label="Loading the dashboard…" variant="dashboard" />;
  }

  return (
    <div className="crm-dashboard flex flex-col gap-6">
      <FilterBar
        state={state}
        leadType={leadType}
        onChange={update}
        options={{
          types,
          sources: (data?.sources ?? [])
            .map((entry) => entry.key)
            .filter((key) => key !== '(none)'),
          partners: data?.partners ?? [],
          members: members.map((member) => ({
            actorId: member.actorId,
            name: member.isSelf ? 'You' : memberName(member),
          })),
          plans: plans
            .filter((plan) => leadType === undefined || plan.leadType === leadType)
            .map((plan) => ({ id: plan.id, name: plan.name })),
        }}
      />

      {summary.error || analytics.error ? (
        <p role="alert" className="text-sm text-muted-foreground">
          Could not load the dashboard. Reason: {summary.error ?? analytics.error}.
        </p>
      ) : null}

      {!data && !analytics.error ? (
        <LoadingSkeleton label="Loading the dashboard…" variant="dashboard">
          <FollowUpsDue workspaceSlug={workspaceSlug} />
        </LoadingSkeleton>
      ) : null}

      {data ? (
        <div
          className={cn(
            'flex flex-col gap-6 transition-opacity',
            analytics.loading && 'opacity-60',
          )}
          aria-busy={analytics.loading}
        >
          <p className="text-sm text-muted-foreground">
            {leadType ? leadTypeLabel(leadType) : 'All lead types'} ·{' '}
            {rangeLabel(data.range.from, data.range.to)}
            {data.comparison
              ? ` · compared with ${rangeLabel(data.comparison.from, data.comparison.to)}`
              : ''}{' '}
            (UTC days)
          </p>
          <Kpis
            data={data}
            leadType={leadType}
            workspaceSlug={workspaceSlug}
            compareLabel={COMPARE_LABELS[state.compare].toLowerCase()}
          />
          <Charts data={data} leadType={leadType} workspaceSlug={workspaceSlug} members={members} />
        </div>
      ) : null}
    </div>
  );
}

/** ▲ 12.5 % or ▼ 3 % against the comparison; nothing when there is no base. */
function Delta({
  value,
  compareLabel,
  invert = false,
}: {
  value: AnalyticsCompared | { current: number; previous: number | null };
  compareLabel: string;
  invert?: boolean;
}) {
  const delta = analyticsDelta(value.current, value.previous);
  if (value.previous === null) return null;
  if (delta === null) {
    return <p className="text-xs text-muted-foreground">No {compareLabel} figure to compare</p>;
  }
  const up = delta > 0;
  const good = delta === 0 ? undefined : up !== invert;
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
      {delta === 0 ? null : <Icon className="size-3.5" aria-hidden="true" />}
      <span>
        <span className="sr-only">{up ? 'Up' : delta === 0 ? 'Unchanged' : 'Down'} </span>
        {percentFormat.format(Math.abs(delta))}
        <span className="font-normal text-muted-foreground"> vs {compareLabel}</span>
      </span>
    </p>
  );
}

function Kpi({
  label,
  value,
  hint,
  icon: Icon = InboxIcon,
  tone = 'info',
  href,
  children,
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: LucideIcon;
  tone?: 'info' | 'success' | 'warning' | 'danger';
  href?: string;
  children?: ReactNode;
}) {
  const body = (
    <>
      <h2 className="flex items-center gap-2 text-sm font-normal text-muted-foreground">
        <Icon className="crm-stat-icon size-4 shrink-0" aria-hidden="true" />
        {label}
      </h2>
      <p className="text-2xl font-semibold tracking-tight tabular-nums sm:text-3xl">{value}</p>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </>
  );
  return (
    <div
      data-tone={tone}
      className="crm-stat flex min-h-[7.5rem] flex-col justify-center gap-2 px-5 py-4"
    >
      {href ? (
        <Link
          href={href}
          className="-m-2 flex flex-col gap-2 rounded-lg p-2 transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
        >
          {body}
        </Link>
      ) : (
        body
      )}
    </div>
  );
}

function Kpis({
  data,
  leadType,
  workspaceSlug,
  compareLabel,
}: {
  data: AnalyticsResponse;
  leadType: string | undefined;
  workspaceSlug: string;
  compareLabel: string;
}) {
  const { kpis, commission } = data;
  const rate = (won: number, created: number) => (created > 0 ? won / created : 0);
  const conversion = {
    current: rate(kpis.won.current, kpis.newLeads.current),
    previous:
      kpis.won.previous === null || kpis.newLeads.previous === null
        ? null
        : rate(kpis.won.previous, kpis.newLeads.previous),
  };
  const received = data.statuses.commission.find((entry) => entry.key === 'received')?.total ?? 0;
  const outstanding = data.statuses.commission
    .filter((entry) => !['received', 'clawback', '(not set)'].includes(entry.key))
    .reduce((sum, entry) => sum + entry.total, 0);
  const showDocuments = leadType === undefined || DOCUMENT_TYPES.has(leadType);
  const typeHref = leadType ? leadsHref(workspaceSlug, { type: leadType }) : undefined;

  return (
    <section aria-label="Key figures" className="flex flex-col gap-4">
      <div className="crm-stat-grid grid grid-cols-1 overflow-hidden rounded-2xl border bg-card min-[480px]:grid-cols-2 lg:grid-cols-4">
        <Kpi
          label={leadType === 'sim_order' ? 'New orders' : 'New leads'}
          value={numberFormat.format(kpis.newLeads.current)}
          hint="Created in the period, cancellations aside"
          {...(typeHref ? { href: typeHref } : {})}
        >
          <Delta value={kpis.newLeads} compareLabel={compareLabel} />
        </Kpi>
        <Kpi
          tone="success"
          icon={CircleCheckIcon}
          label="Won"
          value={numberFormat.format(kpis.won.current)}
          hint={
            leadType === 'sim_order' ? 'Activated or completed in the period' : 'Won in the period'
          }
        >
          <Delta value={kpis.won} compareLabel={compareLabel} />
        </Kpi>
        <Kpi
          tone="success"
          icon={PercentIcon}
          label="Conversion rate"
          value={percentFormat.format(conversion.current)}
          hint="Won ÷ new in the period"
        >
          <Delta value={conversion} compareLabel={compareLabel} />
        </Kpi>
        <Kpi
          icon={WalletIcon}
          label="Paid"
          value={numberFormat.format(kpis.paid.current)}
          hint="Created in the period and marked paid"
        >
          <Delta value={kpis.paid} compareLabel={compareLabel} />
        </Kpi>
        <Kpi
          tone="warning"
          icon={BellRingIcon}
          label="Open follow-ups"
          value={numberFormat.format(kpis.followUps.due)}
          hint="Open tasks due today or earlier"
          href={`/w/${workspaceSlug}/leads?due=1`}
        >
          {kpis.followUps.overdue > 0 ? (
            <p className="text-xs font-medium text-rose-700 dark:text-rose-400">
              {numberFormat.format(kpis.followUps.overdue)} overdue
            </p>
          ) : null}
        </Kpi>
        <Kpi
          icon={CoinsIcon}
          label="Carrier commission"
          value={`${numberFormat.format(received)} received`}
          hint={`${numberFormat.format(outstanding)} outstanding, orders created in the period`}
        />
        {showDocuments ? (
          <Kpi
            tone="warning"
            icon={FileCheckIcon}
            label="Documents to review"
            value={numberFormat.format(kpis.documentsToReview)}
            hint="Across the site, never reviewed"
            href={`/w/${workspaceSlug}/documents`}
          />
        ) : null}
      </div>

      {commission ? (
        commission.anyPlanHasCommission ? (
          <div
            aria-label="Commission (owner only)"
            role="group"
            className="crm-stat-grid grid grid-cols-1 overflow-hidden rounded-2xl border bg-card min-[480px]:grid-cols-3"
          >
            <Kpi
              tone="success"
              icon={CoinsIcon}
              label="Commission earned"
              value={moneyFormat.format(commission.earnedMinor.current / 100)}
              hint="On leads won in the period (won date: first move to a won stage, else created)"
            >
              <Delta value={commission.earnedMinor} compareLabel={compareLabel} />
            </Kpi>
            <Kpi
              icon={CoinsIcon}
              label="Expected commission"
              value={moneyFormat.format(commission.expectedMinor / 100)}
              hint="Open leads created in the period"
            />
            <Kpi
              tone={commission.wonWithoutCommission > 0 ? 'warning' : 'info'}
              icon={CoinsIcon}
              label="Won without a commission"
              value={numberFormat.format(commission.wonWithoutCommission)}
              hint="No plan matched, or its plan has none"
            />
          </div>
        ) : (
          <Card>
            <CardContent className="text-sm text-muted-foreground">
              <h2 className="mb-1 font-medium text-foreground">Commission</h2>
              No plan of this type has a commission yet.{' '}
              <Link
                href={`/w/${workspaceSlug}/settings/plans`}
                className="text-primary hover:underline"
              >
                Set commission on plans in Settings → Plans
              </Link>
              .
            </CardContent>
          </Card>
        )
      ) : null}
    </section>
  );
}

function Charts({
  data,
  leadType,
  workspaceSlug,
  members,
}: {
  data: AnalyticsResponse;
  leadType: string | undefined;
  workspaceSlug: string;
  members: readonly Parameters<typeof memberName>[0][];
}) {
  const comparing = data.comparison !== null;
  const steps = leadType
    ? analyticsFunnel(
        leadType,
        data.stages.filter((entry) => entry.leadType === leadType),
      )
    : [];
  const nameOf = (actorId: string | null) => {
    if (actorId === null) return 'Unassigned';
    const member = members.find((entry) => entry.actorId === actorId);
    if (!member) return 'Former teammate';
    return member.isSelf ? 'You' : memberName(member);
  };
  const deliveryLabel = (key: string) =>
    key === 'esim' ? 'eSIM' : key === 'pickup' ? 'Physical SIM' : 'Not given';
  const mix =
    leadType === 'sim_order'
      ? data.mix.delivery.map((entry) => ({ label: deliveryLabel(entry.key), total: entry.total }))
      : leadType === undefined
        ? data.mix.leadTypes.map((entry) => ({
            label: leadTypeLabel(entry.leadType),
            total: entry.total,
          }))
        : [];
  const trendTotal = data.trend.reduce((sum, entry) => sum + entry.current, 0);

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
      <ChartCard
        id="chart-trend"
        className="xl:col-span-2"
        title="New leads over time"
        description={`Per ${data.group}${comparing ? '; the faint dashed line is the comparison period, aligned day for day' : ''}.`}
        empty={trendTotal === 0 ? 'No new leads in this period.' : undefined}
        summary={{
          columns: ['Bucket', 'This period', ...(comparing ? ['Comparison'] : [])],
          rows: data.trend.map((entry) => [
            bucketLabel(entry.bucket, data.group),
            entry.current,
            ...(comparing ? [entry.previous ?? 0] : []),
          ]),
        }}
      >
        <TrendChart data={data.trend} group={data.group} comparing={comparing} />
      </ChartCard>

      <ChartCard
        id="chart-funnel"
        drawingIsAccessible
        title="Funnel by stage"
        description="Leads created in the period that reached each stage, with the share of the step before."
        empty={
          !leadType
            ? 'Choose a lead type to see its funnel.'
            : steps.length === 0 || (steps[0]?.reached ?? 0) === 0
              ? 'No leads in this period.'
              : undefined
        }
        summary={{
          columns: ['Stage', 'Reached', 'From the step before'],
          rows: steps.map((step) => [
            leadType ? leadStageLabel(leadType, step.stage) : step.stage,
            step.reached,
            step.conversion === null ? '' : percentFormat.format(step.conversion),
          ]),
        }}
      >
        {leadType ? (
          <Funnel
            steps={steps}
            stageLabel={(stage) => leadStageLabel(leadType, stage)}
            hrefOf={(stage) => leadsHref(workspaceSlug, { type: leadType, stage })}
          />
        ) : null}
      </ChartCard>

      <ChartCard
        id="chart-sources"
        drawingIsAccessible
        title="Sources and partners"
        description="The ten biggest UTM sources and partners in the period."
        empty={
          data.sources.length === 0 && data.partners.length === 0
            ? 'No leads in this period.'
            : undefined
        }
        summary={{
          columns: ['Source or partner', 'Leads'],
          rows: [
            ...data.sources.map((entry) => [
              entry.key === '(none)' ? 'No UTM source' : entry.key,
              entry.total,
            ]),
            ...data.partners.map((entry) => [`Partner ${entry.name ?? entry.code}`, entry.total]),
          ],
        }}
      >
        <div className="grid gap-6 sm:grid-cols-2">
          <div>
            <h3 className="mb-2 text-sm font-medium">Sources</h3>
            <BarList
              label="Top sources"
              items={data.sources.map((entry) => ({
                key: entry.key,
                label: entry.key === '(none)' ? 'No UTM source' : entry.key,
                total: entry.total,
              }))}
            />
          </div>
          <div>
            <h3 className="mb-2 text-sm font-medium">Partners</h3>
            {data.partners.length === 0 ? (
              <p className="text-sm text-muted-foreground">No partner leads in this period.</p>
            ) : (
              <BarList
                label="Top partners"
                items={data.partners.map((entry) => ({
                  key: entry.code,
                  label: entry.name ?? entry.code,
                  ...(entry.name ? { detail: entry.code } : {}),
                  total: entry.total,
                }))}
              />
            )}
          </div>
        </div>
      </ChartCard>

      <ChartCard
        id="chart-mix"
        drawingIsAccessible
        title="Mix"
        description={
          leadType === 'sim_order'
            ? 'Orders by plan, and eSIM against physical SIM.'
            : leadType === undefined
              ? 'Leads by plan, and by lead type.'
              : 'Leads by plan.'
        }
        empty={
          data.mix.plans.length === 0 && mix.length === 0 ? 'No orders in this period.' : undefined
        }
        summary={{
          columns: ['Part', 'Leads'],
          rows: [
            ...data.mix.plans.map((entry) => [entry.name, entry.total]),
            ...mix.map((entry) => [entry.label, entry.total]),
          ],
        }}
      >
        <div className="flex flex-col gap-6">
          {data.mix.plans.length > 0 ? (
            <BarList
              label="Plans"
              items={data.mix.plans.map((entry) => ({
                key: entry.planId ?? 'none',
                label: entry.name,
                total: entry.total,
              }))}
            />
          ) : null}
          {mix.length > 0 ? <Donut data={mix} /> : null}
        </div>
      </ChartCard>

      <ChartCard
        id="chart-status"
        title="Payment and commission status"
        description="Orders created in the period, by payment status and by carrier commission status."
        empty={
          data.statuses.payment.length === 0 && data.statuses.commission.length === 0
            ? 'No orders in this period.'
            : undefined
        }
        summary={{
          columns: ['Status', 'Orders'],
          rows: [
            ...data.statuses.payment.map((entry) => [
              `Payment: ${statusLabel(entry.key)}`,
              entry.total,
            ]),
            ...data.statuses.commission.map((entry) => [
              `Commission: ${statusLabel(entry.key)}`,
              entry.total,
            ]),
          ],
        }}
      >
        <StatusBars
          rows={[
            {
              label: 'Payment',
              parts: data.statuses.payment.map((entry) => ({
                key: `payment:${entry.key}`,
                label: statusLabel(entry.key),
                total: entry.total,
              })),
            },
            {
              label: 'Commission',
              parts: data.statuses.commission.map((entry) => ({
                key: `commission:${entry.key}`,
                label: statusLabel(entry.key),
                total: entry.total,
              })),
            },
          ]}
        />
      </ChartCard>

      {data.commissionTrend && data.commission?.anyPlanHasCommission ? (
        <ChartCard
          id="chart-commission"
          title="Commission earned over time"
          description={`Per ${data.group}, by won date. Owner only.`}
          empty={
            data.commissionTrend.every((entry) => entry.earnedMinor === 0)
              ? 'No commission earned in this period.'
              : undefined
          }
          summary={{
            columns: ['Bucket', 'Earned'],
            rows: data.commissionTrend.map((entry) => [
              bucketLabel(entry.bucket, data.group),
              moneyFormat.format(entry.earnedMinor / 100),
            ]),
          }}
        >
          <MoneyBars data={data.commissionTrend} group={data.group} />
        </ChartCard>
      ) : null}

      <Card className="min-w-0">
        <CardContent className="flex flex-col gap-3">
          <div>
            <h2 className="text-base font-medium">Team</h2>
            <p className="text-sm text-muted-foreground">
              Leads created in the period per assignee, those won, and their overdue follow-ups.
            </p>
          </div>
          {data.team.length === 0 ? (
            <p className="text-sm text-muted-foreground">No leads in this period.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">Team</caption>
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th scope="col" className="py-2 pr-3 font-normal">
                      Member
                    </th>
                    <th scope="col" className="py-2 pr-3 text-right font-normal">
                      Assigned
                    </th>
                    <th scope="col" className="py-2 pr-3 text-right font-normal">
                      Won
                    </th>
                    <th scope="col" className="py-2 text-right font-normal">
                      Overdue
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.team.map((row) => (
                    <tr key={row.actorId ?? 'none'} className="border-b last:border-0">
                      <th scope="row" className="py-2 pr-3 text-left font-medium">
                        <Link
                          href={leadsHref(workspaceSlug, {
                            ...(leadType ? { type: leadType } : {}),
                            assignee: row.actorId ?? 'none',
                          })}
                          className="hover:underline"
                        >
                          {nameOf(row.actorId)}
                        </Link>
                      </th>
                      <td className="py-2 pr-3 text-right tabular-nums">{row.assigned}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{row.won}</td>
                      <td
                        className={cn(
                          'py-2 text-right tabular-nums',
                          row.overdue > 0 && 'font-medium text-rose-700 dark:text-rose-400',
                        )}
                      >
                        {row.overdue}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <FollowUpsDue workspaceSlug={workspaceSlug} />
    </div>
  );
}

/**
 * The whole team's open tasks due today or earlier (the viewer's today; due
 * dates are calendar days), most overdue first, each linking to its lead.
 */
function FollowUpsDue({ workspaceSlug }: { workspaceSlug: string }) {
  const { accessToken, workspaces } = useStaffSession();
  const workspaceId = workspaces.find((entry) => entry.slug === workspaceSlug)?.id;
  const today = todayDay();
  const load = useMemo(
    () =>
      accessToken && workspaceId
        ? () =>
            listStaffTasks(accessToken, workspaceId, {
              assignee: 'all',
              status: 'active',
              dueBy: today,
              pageSize: SHOWN,
            })
        : undefined,
    [accessToken, workspaceId, today],
  );
  const due = useResource(load);
  const tasks = due.data?.tasks ?? [];
  const total = due.data?.page.total ?? 0;

  return (
    <Card className={cn('min-w-0', total > 0 && 'border-amber-500/30')}>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <BellRingIcon
                className="size-4 text-amber-700 dark:text-amber-400"
                aria-hidden="true"
              />
              Follow-ups due
            </h2>
            <p className="text-sm text-muted-foreground">
              Open tasks due today or earlier, across the team.
            </p>
          </div>
          {due.data ? (
            <span
              className="rounded-md border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-sm text-amber-700 dark:text-amber-300 tabular-nums"
              aria-label={`${total} due`}
            >
              {total}
            </span>
          ) : null}
        </div>

        {due.error ? (
          <p role="alert" className="text-sm text-muted-foreground">
            {due.error === 'permission_denied'
              ? 'Your role does not include lead tasks.'
              : `Could not load the follow-ups. Reason: ${due.error}.`}
          </p>
        ) : !due.data ? (
          <LoadingSkeleton label="Loading follow-ups…" rows={4} />
        ) : tasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing due. A task shows up here on the day it is due.
          </p>
        ) : (
          <ul className="-mx-2 divide-y">
            {tasks.map((task) => (
              <li key={task.id}>
                <Link
                  href={`/w/${workspaceSlug}/leads/${task.lead.id}`}
                  className="flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-muted/40"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {leadDisplayName(task.lead.contact)}{' '}
                      <span className="font-mono text-xs font-normal text-muted-foreground">
                        {task.lead.externalRef ?? leadTypeLabel(task.lead.leadType)}
                      </span>
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {task.title}
                    </span>
                  </span>
                  {task.dueAt ? (
                    <span
                      className={cn(
                        'shrink-0 rounded-md border px-2 py-0.5 text-xs whitespace-nowrap',
                        dueTone(task.dueAt) === 'overdue'
                          ? 'border-rose-500/30 bg-rose-500/15 text-rose-700 dark:text-rose-300'
                          : 'border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300',
                      )}
                    >
                      {followUpLabel(task.dueAt)}
                    </span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        )}

        {due.data && total > 0 ? (
          <p className="text-xs text-muted-foreground">
            {total > tasks.length ? `${tasks.length} of ${total} shown. ` : null}
            <Link href={`/w/${workspaceSlug}/leads?due=1`} className="text-primary hover:underline">
              Open the follow-ups in Leads
            </Link>
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
