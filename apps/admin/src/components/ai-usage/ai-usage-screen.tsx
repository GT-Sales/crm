'use client';

import { useMemo, useState } from 'react';
import type {
  AiUsageMember,
  AiUsagePeriod,
  AiUsageResponse,
  AiUsageTotals,
} from '@gt-sales/contracts';
import { Button, cn } from '@gt-sales/ui';

import { BackendError, getAiUsage } from '../../lib/api';
import { dateTimeLabel } from '../../lib/dates';
import { describeError, errorKind } from '../../lib/error-text';
import { useResource } from '../../lib/use-resource';
import { percentFormat } from '../analytics/charts';
import { LoadingSkeleton } from '../crm/loading-skeleton';
import { useStaffSession } from '../staff-session-provider';
import { ScrollEdge } from './scroll-edge';
import { CostByModel, CostUnavailable, costShown, costTile, MemberCost } from './usage-cost';
import { UsageDaily } from './usage-daily';
import { answerTime, count, lastUsed, totalTokens } from './usage-format';
import {
  AssistantCard,
  CELL,
  FailuresCard,
  HEAD_CELL,
  ModelsTable,
  NUMBER,
} from './usage-sections';

const PERIODS: readonly { days: AiUsagePeriod; label: string }[] = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
];

/** What a member with no display name is called: they never set one, or have left the site. */
export const FORMER_MEMBER = 'Unnamed member';

function memberLabel(member: Pick<AiUsageMember, 'displayName'>): string {
  return member.displayName ?? FORMER_MEMBER;
}

/** Most tokens first; the same total by name, then by id so the order never wobbles. */
export function sortMembers(members: readonly AiUsageMember[]): AiUsageMember[] {
  return [...members].sort(
    (a, b) =>
      totalTokens(b) - totalTokens(a) ||
      memberLabel(a).localeCompare(memberLabel(b)) ||
      a.actorId.localeCompare(b.actorId),
  );
}

/**
 * Settings → AI usage, the owner's Ask AI monitoring page, top to bottom:
 * how the assistant is set up now, the period's totals and approximate cost,
 * the cost per model, turns, tokens and cost per day, the models that served
 * turns, why turns failed, and each member's use, over the last 7, 30 or 90
 * calendar days in Toronto. Counts, amounts, codes and configuration names
 * only, never a question or an answer. The backend
 * answers the owner alone, so anyone else who reaches the page is told so;
 * an older backend without the route reads as "not available yet", and one
 * that sends only the totals and members gets the page as it was (no
 * assistant, per-day, models or failure sections). Member names, model ids
 * and codes go in as text children only.
 */
export function AiUsageScreen({ workspaceSlug }: { workspaceSlug: string }) {
  const { accessToken, workspaces } = useStaffSession();
  const workspaceId = workspaces.find((entry) => entry.slug === workspaceSlug)?.id;
  const [days, setDays] = useState<AiUsagePeriod>(30);
  const load = useMemo(
    () =>
      accessToken && workspaceId
        ? () => getAiUsage(accessToken, workspaceId, { period: days })
        : undefined,
    [accessToken, workspaceId, days],
  );
  // `data` stays on screen while another period loads, so the numbers do not flash away.
  const usage = useResource(load);

  let body;
  if (usage.error) {
    body = <LoadFailed failure={usage.failure} onRetry={() => void usage.reload()} />;
  } else if (!usage.data) {
    body = <LoadingSkeleton label="Loading AI usage…" variant="report" />;
  } else {
    body = <Usage usage={usage.data} busy={usage.loading} />;
  }

  return (
    <div className="flex flex-col gap-4">
      <div
        role="group"
        aria-label="Period"
        className="flex w-fit max-w-full overflow-hidden rounded-full border border-input"
      >
        {PERIODS.map((entry, index) => (
          <button
            key={entry.days}
            type="button"
            aria-pressed={entry.days === days}
            onClick={() => setDays(entry.days)}
            className={cn(
              'h-8 px-3 text-xs font-medium whitespace-nowrap transition-colors hover:bg-muted/50',
              entry.days === days ? 'bg-muted text-foreground' : 'text-muted-foreground',
              index > 0 && 'border-l border-input',
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {body}

      <p className="text-xs text-muted-foreground">Usage older than 90 days is not kept.</p>
    </div>
  );
}

/** True for a refusal that means this route is not there (an older backend) or the feature is off. */
function isNotAvailable(failure: unknown): boolean {
  return failure instanceof BackendError && (failure.status === 404 || failure.status === 503);
}

function isDenied(failure: unknown): boolean {
  return (
    errorKind(failure) === 'permission' ||
    (failure instanceof BackendError && failure.status === 403)
  );
}

function LoadFailed({ failure, onRetry }: { failure: unknown; onRetry: () => void }) {
  if (isDenied(failure)) {
    return (
      <p role="alert" className="text-sm text-muted-foreground">
        {describeError(failure, 'view AI usage')}
      </p>
    );
  }
  const unavailable = isNotAvailable(failure);
  return (
    <div
      role={unavailable ? 'status' : 'alert'}
      className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground"
    >
      <p>
        {unavailable
          ? 'AI usage is not available yet. It will appear here once the CRM is updated.'
          : describeError(failure, 'load AI usage')}
      </p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

/**
 * The totals as tiles, in rows of four (three when four would leave one tile
 * alone); a field the backend did not send has no tile.
 */
function totalTiles(totals: AiUsageTotals): { label: string; value: string; note?: string }[] {
  const tiles: ({ label: string; value: string; note?: string } | undefined)[] = [
    { label: 'Turns', value: count.format(totals.turns) },
    totals.highEffortTurns === undefined
      ? undefined
      : {
          label: 'High effort turns',
          value: count.format(totals.highEffortTurns),
          ...(totals.turns > 0
            ? { note: `${percentFormat.format(totals.highEffortTurns / totals.turns)} of turns` }
            : {}),
        },
    totals.completedTurns === undefined
      ? undefined
      : { label: 'Completed', value: count.format(totals.completedTurns) },
    totals.failedTurns === undefined
      ? undefined
      : {
          label: 'Failed',
          value: count.format(totals.failedTurns),
          ...(totals.turns > 0
            ? { note: `${percentFormat.format(totals.failedTurns / totals.turns)} of turns` }
            : {}),
        },
    totals.averageDurationMs === undefined
      ? undefined
      : {
          label: 'Average answer time',
          value: answerTime(totals.averageDurationMs),
          ...(totals.averageDurationMs === null ? { note: 'No completed turns' } : {}),
        },
    { label: 'Tokens in', value: count.format(totals.inputTokens) },
    { label: 'Tokens out', value: count.format(totals.outputTokens) },
    { label: 'Total tokens', value: count.format(totalTokens(totals)) },
    totals.toolCalls === undefined
      ? undefined
      : { label: 'Tool calls', value: count.format(totals.toolCalls) },
  ];
  return tiles.filter((tile) => tile !== undefined);
}

function Usage({ usage, busy }: { usage: AiUsageResponse; busy: boolean }) {
  const { totals } = usage;
  const members = useMemo(() => sortMembers(usage.members), [usage.members]);
  // A backend that counts High turns sends them on every member.
  const highColumn = usage.members.some((member) => member.highEffortTurns !== undefined);
  const { cost } = usage;
  // A priced cost is one more figure beside the totals, per day and per member.
  const priced = costShown(cost) ? cost : undefined;
  const memberCosts = useMemo(
    () => new Map((priced?.members ?? []).map((entry) => [entry.actorId, entry])),
    [priced],
  );
  const tiles = [...totalTiles(totals), ...(priced ? [costTile(priced)] : [])];
  const perRow = tiles.length > 4 && tiles.length % 4 === 1 ? 3 : 4;
  const strips = Array.from({ length: Math.ceil(tiles.length / perRow) }, (_, index) =>
    tiles.slice(index * perRow, index * perRow + perRow),
  );
  // Only an answer with the monitoring fields has other sections to tell the people table apart from.
  const monitoring =
    usage.assistant !== undefined ||
    usage.daily !== undefined ||
    usage.models !== undefined ||
    usage.failures !== undefined;
  return (
    <div aria-busy={busy} className={cn('flex flex-col gap-6', busy && 'opacity-70')}>
      {usage.assistant ? <AssistantCard assistant={usage.assistant} /> : null}

      <section aria-label="Totals" className="flex flex-col gap-4">
        {strips.map((strip, index) => (
          <div
            key={index}
            className={cn(
              'crm-kpi-strip grid rounded-xl border bg-card sm:grid-cols-2',
              perRow === 3 ? 'lg:grid-cols-3' : 'lg:grid-cols-4',
            )}
          >
            {strip.map((tile) => (
              <Tile key={tile.label} {...tile} />
            ))}
          </div>
        ))}
        {usage.daily ? (
          <p className="text-xs text-muted-foreground">
            {`Today and the ${String(usage.period - 1)} days before it, as calendar days in Toronto.`}
          </p>
        ) : null}
        {cost ? <CostUnavailable cost={cost} /> : null}
      </section>

      {cost ? <CostByModel cost={cost} period={usage.period} /> : null}

      {usage.daily ? <UsageDaily daily={usage.daily} cost={priced} /> : null}

      {usage.models ? (
        <ModelsTable
          models={usage.models}
          configuredModel={usage.assistant?.configuredModel}
          period={usage.period}
        />
      ) : null}

      {usage.failures ? (
        <FailuresCard failures={usage.failures} failedTurns={totals.failedTurns} />
      ) : null}

      <section
        aria-labelledby={monitoring ? 'ai-usage-people-title' : undefined}
        aria-label={monitoring ? undefined : 'People'}
        className="flex flex-col gap-3"
      >
        {monitoring ? (
          <h2 id="ai-usage-people-title" className="text-base font-medium">
            People
          </h2>
        ) : null}
        {members.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nobody has used Ask AI in this period.</p>
        ) : (
          <ScrollEdge>
            <table className="w-full min-w-[640px] text-sm">
              <caption className="sr-only">{`Ask AI usage per member, last ${String(usage.period)} days`}</caption>
              <thead>
                <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                  <th scope="col" className={HEAD_CELL}>
                    Member
                  </th>
                  <th scope="col" className={cn(HEAD_CELL, 'text-right')}>
                    Turns
                  </th>
                  {highColumn ? (
                    <th scope="col" className={cn(HEAD_CELL, 'text-right')}>
                      High
                    </th>
                  ) : null}
                  <th scope="col" className={cn(HEAD_CELL, 'text-right')}>
                    Tokens in
                  </th>
                  <th scope="col" className={cn(HEAD_CELL, 'text-right')}>
                    Tokens out
                  </th>
                  <th scope="col" className={cn(HEAD_CELL, 'text-right')}>
                    Total tokens
                  </th>
                  {priced ? (
                    <th scope="col" className={cn(HEAD_CELL, 'text-right')}>
                      Approx. cost
                    </th>
                  ) : null}
                  <th scope="col" className={cn(HEAD_CELL, 'text-right')}>
                    Last used
                  </th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr
                    key={member.actorId}
                    className="border-b last:border-0 transition-colors hover:bg-muted/40"
                  >
                    <th
                      scope="row"
                      className={cn(
                        CELL,
                        'max-w-[280px] text-left font-medium break-words',
                        member.displayName === null && 'font-normal text-muted-foreground',
                      )}
                    >
                      {memberLabel(member)}
                    </th>
                    <td className={cn(CELL, NUMBER)}>{count.format(member.turns)}</td>
                    {highColumn ? (
                      <td className={cn(CELL, NUMBER)}>
                        {count.format(member.highEffortTurns ?? 0)}
                      </td>
                    ) : null}
                    <td className={cn(CELL, NUMBER)}>{count.format(member.inputTokens)}</td>
                    <td className={cn(CELL, NUMBER)}>{count.format(member.outputTokens)}</td>
                    <td className={cn(CELL, NUMBER, 'font-medium')}>
                      {count.format(totalTokens(member))}
                    </td>
                    {priced ? (
                      <td className={cn(CELL, NUMBER, 'whitespace-nowrap')}>
                        <MemberCost cost={priced} entry={memberCosts.get(member.actorId)} />
                      </td>
                    ) : null}
                    <td className={cn(CELL, NUMBER, 'whitespace-nowrap text-muted-foreground')}>
                      <time dateTime={member.lastUsedAt} title={dateTimeLabel(member.lastUsedAt)}>
                        {lastUsed(member.lastUsedAt)}
                      </time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollEdge>
        )}
      </section>
    </div>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="crm-stat flex min-w-0 flex-col gap-2 px-5 py-3">
      <h2 className="text-sm font-normal text-muted-foreground">{label}</h2>
      <p className="text-2xl font-semibold tracking-tight tabular-nums sm:text-3xl">{value}</p>
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}
