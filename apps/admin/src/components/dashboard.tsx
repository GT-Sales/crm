'use client';

import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import {
  LEAD_STATS_WINDOWS,
  leadStageLabel,
  leadTypeEntry,
  leadTypeLabel,
  type LeadStatsResponse,
  type LeadTypeCount,
} from '@gt-sales/contracts';
import { Card, CardContent, NativeSelect, cn } from '@gt-sales/ui';
import { BellRingIcon } from 'lucide-react';

import { getLeadsSummary, getLeadStats, listStaffTasks } from '../lib/api';
import { dueTone, followUpLabel, todayDay } from '../lib/dates';
import { useResource } from '../lib/use-resource';
import { TopPartners, VolumeChart } from './dashboard-charts';
import { leadDisplayName } from './leads/lead-display';
import { useStaffSession } from './staff-session-provider';

/** As many follow-ups as Get Canada Sim's dashboard lists before "View all". */
const SHOWN = 6;

type StatsWindow = (typeof LEAD_STATS_WINDOWS)[number] | null;

/** Get Canada Sim's windows, in its words and order; it opens on the last 7 days. */
const WINDOWS: { days: StatsWindow; label: string; period: string }[] = [
  { days: null, label: 'All time', period: 'all time' },
  { days: 90, label: 'Last 3 months', period: 'the last 3 months' },
  { days: 30, label: 'Last 30 days', period: 'the last 30 days' },
  { days: 7, label: 'Last 7 days', period: 'the last 7 days' },
];

/** The type with the most active leads (a site's orders before its partner applications). */
function busiest(types: readonly LeadTypeCount[]): string | undefined {
  return [...types].sort((a, b) => b.total - a.total)[0]?.leadType;
}

/**
 * The site's dashboard, where the day starts, as in Get Canada Sim's admin:
 * one type's totals over a window (received, then its completed, pending
 * and cancelled when the type defines them), the team's follow-ups due, the
 * volume per day and the top partners. Counts only, for every role.
 */
export function Dashboard({ workspaceSlug }: { workspaceSlug: string }) {
  const { accessToken, workspaces } = useStaffSession();
  const workspaceId = workspaces.find((entry) => entry.slug === workspaceSlug)?.id;
  const today = todayDay();
  const loadSummary = useMemo(
    () =>
      accessToken && workspaceId
        ? () => getLeadsSummary(accessToken, workspaceId, { dueBy: today })
        : undefined,
    [accessToken, workspaceId, today],
  );
  const summary = useResource(loadSummary);
  const types = summary.data?.types ?? [];
  const [chosenType, setChosenType] = useState<string>();
  const leadType =
    chosenType && types.some((entry) => entry.leadType === chosenType)
      ? chosenType
      : busiest(types);
  const [days, setDays] = useState<StatsWindow>(7);
  const loadStats = useMemo(
    () =>
      accessToken && workspaceId && leadType
        ? () =>
            getLeadStats(accessToken, workspaceId, {
              leadType,
              ...(days === null ? {} : { days }),
            })
        : undefined,
    [accessToken, workspaceId, leadType, days],
  );
  const stats = useResource(loadStats);
  const period = WINDOWS.find((entry) => entry.days === days)?.period ?? 'all time';
  const followUpsDue = types.find((entry) => entry.leadType === leadType)?.followUpsDue ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">What needs doing on this site today.</p>
      </div>

      {leadType ? (
        <div className="flex flex-wrap items-center gap-3">
          <div
            role="group"
            aria-label="Period"
            className="flex overflow-hidden rounded-full border border-input"
          >
            {WINDOWS.map((entry, index) => (
              <button
                key={entry.label}
                type="button"
                aria-pressed={entry.days === days}
                onClick={() => setDays(entry.days)}
                className={cn(
                  'h-8 px-3 text-xs font-medium transition-colors hover:bg-muted/50',
                  entry.days === days ? 'bg-muted text-foreground' : 'text-muted-foreground',
                  index > 0 && 'border-l border-input',
                )}
              >
                {entry.label}
              </button>
            ))}
          </div>
          {types.length > 1 ? (
            <label className="w-52">
              <span className="sr-only">Lead type</span>
              <NativeSelect
                value={leadType}
                onChange={(event) => setChosenType(event.target.value)}
              >
                {types.map((entry) => (
                  <option key={entry.leadType} value={entry.leadType}>
                    {leadTypeLabel(entry.leadType)}
                  </option>
                ))}
              </NativeSelect>
            </label>
          ) : null}
        </div>
      ) : null}

      {stats.error ? (
        <p role="alert" className="text-sm text-muted-foreground">
          Could not load the totals. Reason: {stats.error}.
        </p>
      ) : null}
      {leadType && stats.data ? (
        <div className={cn('transition-opacity', stats.loading && 'opacity-60')}>
          <StatTiles stats={stats.data} period={period} followUpsDue={followUpsDue} />
        </div>
      ) : null}

      <FollowUpsDue workspaceSlug={workspaceSlug} />

      {leadType && stats.data ? (
        <div
          className={cn(
            'grid grid-cols-1 gap-4 md:grid-cols-7',
            stats.loading && 'opacity-60 transition-opacity',
          )}
        >
          <Card className="md:col-span-4">
            <CardContent className="flex flex-col gap-3">
              <div>
                <h2 className="text-base font-semibold">
                  {leadTypeLabel(stats.data.leadType)} volume
                </h2>
                <p className="text-sm text-muted-foreground">
                  Received per day over {period}, cancellations aside (UTC days).
                </p>
              </div>
              <VolumeChart
                daily={stats.data.daily}
                days={stats.data.days}
                today={new Date().toISOString().slice(0, 10)}
                caption={`${leadTypeLabel(stats.data.leadType)} received per day, ${period}`}
              />
            </CardContent>
          </Card>
          <Card className="md:col-span-3">
            <CardContent className="flex flex-col gap-3">
              <div>
                <h2 className="text-base font-semibold">Top partners</h2>
                <p className="text-sm text-muted-foreground">
                  The ten partners most came through over {period}.
                </p>
              </div>
              <TopPartners partners={stats.data.partners} />
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  );
}

/** A stat tile: its label, the number, and a line on what it counts. */
function Tile({
  label,
  value,
  hint,
  children,
}: {
  label: string;
  value: number;
  hint: string;
  children?: ReactNode;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">{label}</h2>
        <p className="text-3xl font-semibold tracking-tight">{value.toLocaleString('en-CA')}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
        {children}
      </CardContent>
    </Card>
  );
}

/**
 * Received, then the type's own groups (Get Canada Sim: Completed, Pending
 * action with the follow-ups due, Cancellations with their rate); a type
 * without groups lists its stages instead.
 */
function StatTiles({
  stats,
  period,
  followUpsDue,
}: {
  stats: LeadStatsResponse;
  period: string;
  followUpsDue: number;
}) {
  const outcomes = leadTypeEntry(stats.leadType)?.outcomes;
  const count = (stages: readonly string[]) =>
    stats.stages
      .filter((entry) => stages.includes(entry.stage))
      .reduce((sum, entry) => sum + entry.total, 0);
  const received = (
    <Tile
      label="Received"
      value={stats.total}
      hint={`${leadTypeLabel(stats.leadType)} leads over ${period}`}
    />
  );
  if (!outcomes) {
    return (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        {received}
        <Card className="md:col-span-3">
          <CardContent className="flex flex-col gap-2">
            <h2 className="text-sm font-medium">By stage</h2>
            <ul className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
              {stats.stages.map((entry) => (
                <li key={entry.stage}>
                  <span className="text-muted-foreground">
                    {leadStageLabel(stats.leadType, entry.stage)}
                  </span>{' '}
                  <span className="font-semibold tabular-nums">{entry.total}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    );
  }
  const lost = count(outcomes.lost.stages);
  const rate = stats.total > 0 ? (lost / stats.total) * 100 : 0;
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
      {received}
      <Tile
        label={outcomes.done.label}
        value={count(outcomes.done.stages)}
        hint={outcomes.done.hint}
      />
      <Tile
        label={outcomes.waiting.label}
        value={count(outcomes.waiting.stages)}
        hint={outcomes.waiting.hint}
      >
        {followUpsDue > 0 ? (
          <p className="text-xs font-medium text-amber-300">
            {followUpsDue} follow-up{followUpsDue === 1 ? '' : 's'} due
          </p>
        ) : null}
      </Tile>
      <Tile
        label={outcomes.lost.label}
        value={lost}
        hint={`${rate.toFixed(1)}% ${outcomes.lost.hint}`}
      />
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
              status: 'open',
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
    <Card className={cn(total > 0 && 'border-amber-500/30')}>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <BellRingIcon className="size-4 text-amber-400" aria-hidden="true" />
              Follow-ups due
            </h2>
            <p className="text-sm text-muted-foreground">
              Open tasks due today or earlier, across the team.
            </p>
          </div>
          {due.data ? (
            <span
              className="rounded-md border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-sm text-amber-300 tabular-nums"
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
          <p className="text-sm text-muted-foreground" aria-busy="true">
            Loading follow-ups…
          </p>
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
                          ? 'border-rose-500/30 bg-rose-500/15 text-rose-300'
                          : 'border-amber-500/30 bg-amber-500/15 text-amber-300',
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
