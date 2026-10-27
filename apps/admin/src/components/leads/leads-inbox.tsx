'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { leadTypeEntry, leadTypeLabel } from '@gt-sales/contracts';
import { cn, Input, NativeSelect } from '@gt-sales/ui';
import { BellRingIcon, KanbanSquareIcon, SearchIcon, TableIcon, Trash2Icon } from 'lucide-react';

import { getLeadsSummary } from '../../lib/api';
import { todayDay } from '../../lib/dates';
import { memberName } from '../../lib/people';
import { useResource } from '../../lib/use-resource';
import { inboxSearch, parseInboxQuery, type InboxQuery } from './inbox-query';
import { LeadsBoard } from './leads-board';
import { LeadsTable } from './leads-table';
import { useLeadWorkspace } from './use-lead-workspace';

const SEARCH_DELAY_MS = 300;

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        '-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors',
        active
          ? 'border-primary font-medium text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function Count({ value }: { value: number | undefined }) {
  if (value === undefined) return null;
  return (
    <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground tabular-nums">
      {value}
    </span>
  );
}

/**
 * The leads inbox: a tab per lead type the site has, the trash, a search,
 * stage and assignee filters, "Follow-ups due", and a table or (for one
 * type) a board. Every choice is in the URL.
 */
export function LeadsInbox({ workspaceSlug }: { workspaceSlug: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = parseInboxQuery(searchParams);
  const { workspaceId, accessToken, members } = useLeadWorkspace(workspaceSlug);

  // Follow-ups count as due by the viewer's own today.
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
  const access = summary.data?.access;
  const totalActive = types.reduce((sum, entry) => sum + entry.total, 0);
  const followUpsDue = types
    .filter((entry) => !query.type || entry.leadType === query.type)
    .reduce((sum, entry) => sum + (entry.followUpsDue ?? 0), 0);

  // Every change merges into the filters as they are when it lands, not as
  // they were when it was scheduled: the delayed search below must not undo a
  // tab clicked while it waited.
  const latestQuery = useRef(query);
  const urlKey = searchParams.toString();
  useEffect(() => {
    latestQuery.current = parseInboxQuery(new URLSearchParams(urlKey));
  }, [urlKey]);
  function update(patch: Partial<InboxQuery>) {
    const next: InboxQuery = { ...latestQuery.current, page: 1, ...patch };
    latestQuery.current = next;
    router.replace(`${pathname}${inboxSearch(next)}`, { scroll: false });
  }

  // The search box answers as staff type, without a request per keystroke.
  const [searchText, setSearchText] = useState(query.q ?? '');
  useEffect(() => {
    setSearchText(query.q ?? '');
  }, [query.q]);
  useEffect(() => {
    const trimmed = searchText.trim();
    if (trimmed === (query.q ?? '')) return;
    const timer = setTimeout(
      () => update({ q: trimmed === '' ? undefined : trimmed.slice(0, 100) }),
      SEARCH_DELAY_MS,
    );
    return () => clearTimeout(timer);
    // `update` reads the latest filters through the ref; the text and the
    // current search are what should restart the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText, query.q]);

  const stages = query.type ? (leadTypeEntry(query.type)?.stages ?? []) : [];
  const boardType = query.type ?? types[0]?.leadType;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Leads</h1>
          <p className="text-sm text-muted-foreground">
            {query.due
              ? 'Leads with a follow-up due today or earlier, most overdue first.'
              : 'Every enquiry the site has sent, newest activity first.'}
          </p>
        </div>
        <div role="group" aria-label="View" className="inline-flex rounded-md border p-0.5 text-sm">
          <button
            type="button"
            aria-pressed={query.view === 'table'}
            onClick={() => update({ view: 'table' })}
            className={cn(
              'inline-flex items-center gap-1.5 rounded px-2.5 py-1',
              query.view === 'table' ? 'bg-muted text-foreground' : 'text-muted-foreground',
            )}
          >
            <TableIcon className="size-4" aria-hidden="true" /> Table
          </button>
          <button
            type="button"
            aria-pressed={query.view === 'board'}
            disabled={!boardType || query.trash}
            title={query.trash ? 'The trash has no board' : undefined}
            onClick={() =>
              update({
                view: 'board',
                type: boardType,
                stage: undefined,
                trash: false,
                due: false,
              })
            }
            className={cn(
              'inline-flex items-center gap-1.5 rounded px-2.5 py-1 disabled:opacity-50',
              query.view === 'board' ? 'bg-muted text-foreground' : 'text-muted-foreground',
            )}
          >
            <KanbanSquareIcon className="size-4" aria-hidden="true" /> Board
          </button>
        </div>
      </div>

      <div role="tablist" aria-label="Lead types" className="flex overflow-x-auto border-b">
        <TabButton
          active={!query.type && !query.trash}
          onClick={() => update({ type: undefined, trash: false, stage: undefined, view: 'table' })}
        >
          All leads <Count value={summary.data ? totalActive : undefined} />
        </TabButton>
        {types.map((entry) => (
          <TabButton
            key={entry.leadType}
            active={query.type === entry.leadType}
            onClick={() => update({ type: entry.leadType, trash: false, stage: undefined })}
          >
            {leadTypeLabel(entry.leadType)} <Count value={entry.total} />
          </TabButton>
        ))}
        {(summary.data?.trash ?? 0) > 0 || query.trash ? (
          <TabButton
            active={query.trash}
            onClick={() =>
              update({ trash: true, type: undefined, stage: undefined, view: 'table' })
            }
          >
            <Trash2Icon className="size-3.5" aria-hidden="true" /> Trash{' '}
            <Count value={summary.data?.trash} />
          </TabButton>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="relative w-full max-w-xs">
          <span className="sr-only">Search leads</span>
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder={
              access && !access.contacts
                ? 'Search needs contact access'
                : 'Search name, email, phone…'
            }
            disabled={access ? !access.contacts : false}
            className="pl-8"
            maxLength={100}
          />
        </label>
        {query.view === 'table' && stages.length > 0 ? (
          <label className="w-44">
            <span className="sr-only">Stage</span>
            <NativeSelect
              value={query.stage ?? ''}
              onChange={(event) => update({ stage: event.target.value || undefined })}
            >
              <option value="">All stages</option>
              {stages.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.label}
                </option>
              ))}
            </NativeSelect>
          </label>
        ) : null}
        <label className="w-48">
          <span className="sr-only">Assignee</span>
          <NativeSelect
            value={query.assignee ?? ''}
            onChange={(event) => update({ assignee: event.target.value || undefined })}
          >
            <option value="">Anyone</option>
            <option value="me">Assigned to me</option>
            <option value="none">Unassigned</option>
            {members
              .filter((member) => !member.isSelf)
              .map((member) => (
                <option key={member.actorId} value={member.actorId}>
                  {memberName(member)}
                </option>
              ))}
          </NativeSelect>
        </label>
        {/* "Who do I call today": shown while there is something due, or while on. */}
        {!query.trash && (followUpsDue > 0 || query.due) ? (
          <button
            type="button"
            aria-pressed={query.due}
            onClick={() => update(query.due ? { due: false } : { due: true, view: 'table' })}
            className={cn(
              'inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm transition-colors',
              query.due
                ? 'border-primary bg-primary text-primary-foreground'
                : 'text-foreground hover:bg-muted',
            )}
          >
            <BellRingIcon className="size-4" aria-hidden="true" /> Follow-ups due
            {summary.data ? (
              <span
                className={cn(
                  'rounded-sm px-1 text-xs tabular-nums',
                  query.due ? 'bg-primary-foreground/20' : 'bg-muted text-muted-foreground',
                )}
              >
                {followUpsDue}
              </span>
            ) : null}
          </button>
        ) : null}
      </div>

      {summary.error ? (
        <p role="alert" className="text-sm text-muted-foreground">
          Could not load the lead counts. Reason: {summary.error}.
        </p>
      ) : null}

      {!accessToken || !workspaceId ? null : query.view === 'board' && query.type ? (
        <LeadsBoard
          workspaceSlug={workspaceSlug}
          workspaceId={workspaceId}
          accessToken={accessToken}
          members={members}
          query={{ ...query, type: query.type }}
        />
      ) : (
        <LeadsTable
          workspaceSlug={workspaceSlug}
          workspaceId={workspaceId}
          accessToken={accessToken}
          members={members}
          query={query}
          onPage={(page) => update({ page })}
        />
      )}
    </div>
  );
}
