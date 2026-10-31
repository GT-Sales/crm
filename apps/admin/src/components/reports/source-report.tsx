'use client';

import { useId, useMemo, useState } from 'react';
import {
  leadTypeLabel,
  type SourceReportCampaign,
  type SourceReportResponse,
  type SourceReportRow,
} from '@gt-sales/contracts';
import { Button, NativeSelect, cn } from '@gt-sales/ui';
import { ChevronRightIcon } from 'lucide-react';

import { getLeadsSummary, getSourceReport } from '../../lib/api';
import { WINDOWS, busiest, type StatsWindow } from '../../lib/stats-windows';
import { useResource } from '../../lib/use-resource';
import { useStaffSession } from '../staff-session-provider';

const HEAD_CELL = 'px-3 py-2 font-medium';
const CELL = 'px-3 py-2.5';
const NUMBER = 'text-right tabular-nums';

/** A source as staff read it: Direct and Other by name, every other label exactly as sent. */
export function sourceLabel(row: Pick<SourceReportRow, 'source' | 'kind'>): string {
  if (row.kind === 'direct') return 'Direct';
  if (row.kind === 'other') return 'Other';
  return row.source;
}

/** The share of received leads that made it, to a whole percent; a dash when none came in. */
export function madeItRate(madeIt: number, received: number): string {
  if (received === 0) return '—';
  return `${String(Math.round((madeIt / received) * 100))}%`;
}

function campaignLabel(campaign: SourceReportCampaign): string {
  if (campaign.other) return 'Other';
  return campaign.campaign ?? '(no campaign)';
}

/**
 * Reports → Sources: one lead type's leads per source over a window, how
 * many came in, were submitted and made it, a UTM source opening onto its
 * campaigns. Counts only, for every role. Every source and campaign is
 * customer-influenced text, so it goes in as a text child, never as markup or
 * a link.
 */
export function SourceReport({ workspaceSlug }: { workspaceSlug: string }) {
  const { accessToken, workspaces } = useStaffSession();
  const workspaceId = workspaces.find((entry) => entry.slug === workspaceSlug)?.id;
  const loadSummary = useMemo(
    () =>
      accessToken && workspaceId ? () => getLeadsSummary(accessToken, workspaceId) : undefined,
    [accessToken, workspaceId],
  );
  const summary = useResource(loadSummary);
  const types = summary.data?.types ?? [];
  const [chosenType, setChosenType] = useState<string>();
  const leadType =
    chosenType && types.some((entry) => entry.leadType === chosenType)
      ? chosenType
      : busiest(types);
  // The report opens on the last 30 days (the dashboard keeps 7).
  const [days, setDays] = useState<StatsWindow>(30);
  const loadReport = useMemo(
    () =>
      accessToken && workspaceId && leadType
        ? () =>
            getSourceReport(accessToken, workspaceId, {
              leadType,
              ...(days === null ? {} : { days }),
            })
        : undefined,
    [accessToken, workspaceId, leadType, days],
  );
  const report = useResource(loadReport);
  const period = WINDOWS.find((entry) => entry.days === days)?.period ?? 'all time';

  let body;
  if (summary.error) {
    body = <LoadFailed onRetry={() => void summary.reload()} />;
  } else if (!summary.data) {
    body = <Loading />;
  } else if (!leadType) {
    body = <NoLeads />;
  } else if (report.error) {
    body = <LoadFailed onRetry={() => void report.reload()} />;
  } else if (report.loading || !report.data) {
    body = <Loading />;
  } else if (report.data.totals.received === 0) {
    body = <NoLeads />;
  } else {
    body = <ReportTable report={report.data} period={period} />;
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sources</h1>
        <p className="text-sm text-muted-foreground">
          Leads per source: how many came in, were submitted and made it.
        </p>
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
          <label className="w-52">
            <span className="sr-only">Lead type</span>
            <NativeSelect value={leadType} onChange={(event) => setChosenType(event.target.value)}>
              {types.map((entry) => (
                <option key={entry.leadType} value={entry.leadType}>
                  {leadTypeLabel(entry.leadType)}
                </option>
              ))}
            </NativeSelect>
          </label>
        </div>
      ) : null}

      {body}
    </div>
  );
}

function Loading() {
  return (
    <p role="status" className="text-sm text-muted-foreground">
      Loading the report…
    </p>
  );
}

function NoLeads() {
  return <p className="text-sm text-muted-foreground">No leads in this period</p>;
}

function LoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
      <p>Could not load the report.</p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

function ReportTable({ report, period }: { report: SourceReportResponse; period: string }) {
  const { totals } = report;
  return (
    <div className="flex flex-col gap-3">
      {report.withSourceData === 0 ? (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          No source data yet. Your websites don&apos;t send UTM tags or referrers to the CRM yet, so
          every lead counts as direct.
        </p>
      ) : null}
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[640px] text-sm">
          <caption className="sr-only">{`Leads per source, ${period}`}</caption>
          <thead>
            <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <th scope="col" className={HEAD_CELL}>
                Source
              </th>
              <th scope="col" className={cn(HEAD_CELL, 'text-right')}>
                Received
              </th>
              <th scope="col" className={cn(HEAD_CELL, 'text-right')}>
                Submitted
              </th>
              <th scope="col" className={cn(HEAD_CELL, 'text-right')}>
                Made it
              </th>
              <th scope="col" className={cn(HEAD_CELL, 'text-right')}>
                Made-it rate
              </th>
            </tr>
          </thead>
          {report.rows.map((row) => (
            <SourceRows key={`${row.kind}:${row.source}`} row={row} />
          ))}
          <tfoot>
            <tr className="border-t bg-muted/40 font-medium">
              <th scope="row" className={cn(CELL, 'text-left')}>
                Total
              </th>
              <Counts counts={totals} />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Made it: the lead reached Activated, Installed, Completed or Won.
      </p>
    </div>
  );
}

function Counts({
  counts,
}: {
  counts: Pick<SourceReportRow, 'received' | 'submitted' | 'madeIt'>;
}) {
  return (
    <>
      <td className={cn(CELL, NUMBER)}>{counts.received.toLocaleString('en-CA')}</td>
      <td className={cn(CELL, NUMBER)}>{counts.submitted.toLocaleString('en-CA')}</td>
      <td className={cn(CELL, NUMBER)}>{counts.madeIt.toLocaleString('en-CA')}</td>
      <td className={cn(CELL, NUMBER, 'text-muted-foreground')}>
        {madeItRate(counts.madeIt, counts.received)}
      </td>
    </>
  );
}

/** One source's row and, opened, its campaign rows (their own `tbody`, the button's target). */
function SourceRows({ row }: { row: SourceReportRow }) {
  const campaignsId = useId();
  const [open, setOpen] = useState(false);
  const label = sourceLabel(row);
  const expandable = row.kind === 'utm' && row.campaigns.length > 0;
  return (
    <>
      <tbody>
        <tr className="border-b transition-colors hover:bg-muted/40">
          <th scope="row" className={cn(CELL, 'max-w-[420px] text-left font-medium break-all')}>
            {expandable ? (
              <button
                type="button"
                aria-expanded={open}
                aria-controls={campaignsId}
                onClick={() => setOpen((current) => !current)}
                className="inline-flex items-start gap-1 rounded-sm text-left font-medium break-all hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <ChevronRightIcon
                  aria-hidden="true"
                  className={cn(
                    'mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform',
                    open && 'rotate-90',
                  )}
                />
                {label}
              </button>
            ) : (
              label
            )}
          </th>
          <Counts counts={row} />
        </tr>
      </tbody>
      {expandable ? (
        <tbody id={campaignsId}>
          {open
            ? row.campaigns.map((campaign) => (
                <tr
                  key={campaign.other ? '\u0000other' : (campaign.campaign ?? '\u0000none')}
                  className="border-b bg-muted/20 text-muted-foreground"
                >
                  <th
                    scope="row"
                    className={cn(CELL, 'max-w-[420px] pl-10 text-left font-normal break-all')}
                  >
                    {campaignLabel(campaign)}
                  </th>
                  <Counts counts={campaign} />
                </tr>
              ))
            : null}
        </tbody>
      ) : null}
    </>
  );
}
