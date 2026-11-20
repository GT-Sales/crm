'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  allowedStageMoves,
  leadCountdownField,
  leadStageLabel,
  leadTypeLabel,
  stageGates,
  type AssignableMember,
  type LeadListItem,
  type LeadTableColumn,
  type PropertyCatalog,
} from '@gt-sales/contracts';
import {
  Button,
  Checkbox,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@gt-sales/ui';
import {
  ChevronDownIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
  CopyIcon,
  ExternalLinkIcon,
  MoreHorizontalIcon,
  PanelRightOpenIcon,
  UserPlusIcon,
} from 'lucide-react';

import { getStaffLeads, updateStaffLead } from '../../lib/api';
import { notifyLeadWorkSaved } from '../../lib/lead-work-events';
import { errorReason, useResource } from '../../lib/use-resource';
import { stageMoveRefusal } from './stage-move-dialog';
import {
  dateTimeLabel,
  dayLabel,
  dueLabel,
  dueTone,
  relativeTime,
  todayDay,
} from '../../lib/dates';
import { assigneeName, memberName } from '../../lib/people';
import { describeError } from '../../lib/error-text';
import { PropertyValueText } from '../properties/property-value';
import type { InboxQuery } from './inbox-query';
import type { TableDensity } from './view-preferences';
import { TableRowsSkeleton } from '../crm/loading-skeleton';
import {
  CountdownLabel,
  leadDisplayName,
  leadNameWeight,
  NewBadge,
  PersonChip,
  StageBadge,
} from './lead-display';
import { propertyColumnLabel, propertyColumnProperty } from './lead-fields';
import { readableSource } from '../../lib/source-label';

const PAGE_SIZE = 50;

// A roomy list: 14px text, the lead's name over its email or phone, a soft
// rule between rows and no pinned column; wide tables scroll sideways whole.
const HEAD_CELL = 'px-3 py-3 text-left font-medium whitespace-nowrap';
/** The row padding: about 61px rows, or about 44px in compact rows (View options). */
const CELL_Y = { comfortable: 'py-3', compact: 'py-1' } as const;
/**
 * Below `md` a row is two lines in the Lead cell (name and stage, then type,
 * assignee, source and last activity); the other columns are for wider screens.
 */
const WIDE = 'hidden md:table-cell';

export const DUE_TONE_CLASS = {
  overdue: 'text-rose-700 dark:text-rose-300',
  today: 'text-amber-700 dark:text-amber-300',
  upcoming: 'text-muted-foreground',
} as const;

function secondaryLine(lead: LeadListItem): string | undefined {
  const { fullName, email, phone } = lead.contact;
  if (fullName) return email ?? phone;
  if (email) return phone;
  return undefined;
}

function ariaSortFor(
  currentSort: string | undefined,
  field: string,
): 'ascending' | 'descending' | 'none' {
  if (currentSort === `${field}:asc`) return 'ascending';
  if (currentSort === `${field}:desc`) return 'descending';
  return 'none';
}

/** The leads ticked for an action on several at once (the export). */
export interface LeadSelection {
  /** The ticked lead ids, across pages. */
  selected: ReadonlySet<string>;
  /** Every lead matching the list's filters, on every page, rather than a set of ids. */
  allMatching: boolean;
}

export const NO_LEAD_SELECTION: LeadSelection = { selected: new Set(), allMatching: false };

const countFormat = new Intl.NumberFormat('en-CA');
/** A menu renders in a portal, but its clicks still bubble to the row in React: stop them there. */
const stopRowClick = (event: { stopPropagation(): void }) => event.stopPropagation();
/** A cell's value as a quiet menu button: the arrow shows on hover and focus. */
const QUICK_TRIGGER =
  'group/quick -mx-1.5 inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60';
const QUICK_CHEVRON =
  'size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/quick:opacity-100 group-focus-visible/quick:opacity-100 group-data-[state=open]/quick:opacity-100';

export function cycleLeadSort(currentSort: string | undefined, field: string): string | undefined {
  if (currentSort === `${field}:asc`) return `${field}:desc`;
  if (currentSort === `${field}:desc`) return undefined;
  return `${field}:asc`;
}

function SortableHeader({
  label,
  field,
  currentSort,
  canSort,
  onSort,
  className,
}: {
  label: string;
  field: string;
  currentSort: string | undefined;
  canSort: boolean;
  onSort?(next: string | undefined): void;
  className?: string;
}) {
  if (!canSort || !onSort) {
    return (
      <th scope="col" className={cn(HEAD_CELL, className)}>
        {label}
      </th>
    );
  }
  const direction = ariaSortFor(currentSort, field);
  return (
    <th
      scope="col"
      aria-sort={direction}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onSort(cycleLeadSort(currentSort, field));
        }
      }}
      className={cn(HEAD_CELL, className)}
    >
      <button
        type="button"
        onClick={() => onSort(cycleLeadSort(currentSort, field))}
        className="inline-flex items-center gap-1 font-medium text-muted-foreground hover:text-foreground"
      >
        <span>{label}</span>
        <span aria-hidden="true" className="text-[10px]">
          {direction === 'ascending' ? '↑' : direction === 'descending' ? '↓' : '↕'}
        </span>
      </button>
    </th>
  );
}

/**
 * A row's `…` menu: open the lead (here or in a new tab), assign it to the
 * viewer, copy the email. Only what the row already has data and permission
 * for. Shown on hover and focus, and always on a touch screen; its clicks
 * never reach the row.
 */
function RowActions({
  name,
  pageHref,
  email,
  canAssignToMe,
  onOpen,
  onAssignToMe,
  onCopyEmail,
}: {
  name: string;
  pageHref: string;
  email?: string;
  canAssignToMe: boolean;
  onOpen(): void;
  onAssignToMe(): void;
  onCopyEmail(email: string): void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`Actions for ${name}`}
          className="size-7 text-muted-foreground opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 motion-reduce:transition-none pointer-coarse:opacity-100"
          onClick={stopRowClick}
        >
          <MoreHorizontalIcon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={stopRowClick}>
        <DropdownMenuItem onSelect={onOpen}>
          <PanelRightOpenIcon aria-hidden="true" />
          Open lead
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={pageHref} target="_blank" rel="noopener noreferrer">
            <ExternalLinkIcon aria-hidden="true" />
            Open in new tab
          </a>
        </DropdownMenuItem>
        {canAssignToMe ? (
          <DropdownMenuItem onSelect={onAssignToMe}>
            <UserPlusIcon aria-hidden="true" />
            Assign to me
          </DropdownMenuItem>
        ) : null}
        {email ? (
          <DropdownMenuItem onSelect={() => onCopyEmail(email)}>
            <CopyIcon aria-hidden="true" />
            Copy email
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The inbox as a table: one row per lead, newest activity first (follow-ups
 * due: most overdue first). Property columns read through the site's
 * catalogue; `waiting` holds the load while that catalogue is still needed.
 */
export function LeadsTable({
  workspaceSlug,
  workspaceId,
  accessToken,
  members,
  query,
  catalog,
  waiting,
  canUseProperties,
  onPage,
  onSort,
  onClearFilters,
  panel,
  reloadToken,
  selection,
  onSelectionChange,
  selectionActions,
  selectionBar = true,
  onLoaded,
  density = 'comfortable',
}: {
  workspaceSlug: string;
  workspaceId: string;
  accessToken: string;
  members: readonly AssignableMember[];
  query: InboxQuery;
  catalog: PropertyCatalog;
  waiting?: boolean;
  canUseProperties?: boolean;
  onPage(page: number): void;
  onSort?(sort: string | undefined): void;
  onClearFilters?(): void;
  /**
   * Rows open in the inbox's side panel instead of the lead page: a row or
   * its name opens `onOpen`, and the name links to `href` (the list with the
   * panel open) for a new tab.
   */
  panel?: { openId?: string; href(leadId: string): string; onOpen(leadId: string): void };
  /** A new value asks for the same page again (a lead changed in the side panel). */
  reloadToken?: number;
  /**
   * With a selection the table grows a checkbox column: a box per row, one in
   * the header for the page, and, once the whole page is ticked, the offer to
   * take every lead matching the filters. Without it the table is as before.
   */
  selection?: LeadSelection;
  onSelectionChange?(next: LeadSelection): void;
  /** What can be done with the ticked leads, shown beside their count. */
  selectionActions?: ReactNode;
  /**
   * False when the parent shows the count and actions itself (the inbox does,
   * in its toolbar), so ticking a row does not push the table down.
   */
  selectionBar?: boolean;
  /** Told how many leads match the filters, and which are on the page, each time a page arrives. */
  onLoaded?(info: { total: number; rowIds: readonly string[] }): void;
  /** Row padding, the viewer's choice in View options. */
  density?: TableDensity;
}) {
  const router = useRouter();
  const load = useMemo(
    () =>
      waiting
        ? undefined
        : () =>
            getStaffLeads(accessToken, workspaceId, {
              type: query.type,
              stage: query.stage,
              assignee: query.assignee,
              q: query.q,
              view: query.archived ? 'archived' : 'active',
              // Due by the viewer's own today: due dates are calendar days.
              dueBy: query.due ? todayDay() : undefined,
              ...(query.where && query.where.length > 0 ? { where: query.where } : {}),
              ...(query.sort ? { sort: query.sort } : {}),
              ...(query.columns && query.columns.length > 0 ? { columns: query.columns } : {}),
              page: query.page,
              pageSize: PAGE_SIZE,
            }),
    [
      waiting,
      accessToken,
      workspaceId,
      query.type,
      query.stage,
      query.assignee,
      query.q,
      query.archived,
      query.due,
      query.where,
      query.sort,
      query.columns,
      query.page,
    ],
  );
  const leads = useResource(load);
  // Asked again in place, keeping the rows on screen while it loads.
  const seenToken = useRef(reloadToken);
  const { reload } = leads;
  useEffect(() => {
    if (seenToken.current === reloadToken) return;
    seenToken.current = reloadToken;
    void reload();
  }, [reloadToken, reload]);
  const loadedPage = leads.data;
  const reportLoaded = useRef(onLoaded);
  useEffect(() => {
    reportLoaded.current = onLoaded;
  }, [onLoaded]);
  useEffect(() => {
    if (loadedPage)
      reportLoaded.current?.({
        total: loadedPage.page.total,
        rowIds: loadedPage.leads.map((lead) => lead.id),
      });
  }, [loadedPage]);
  const rows = leads.data?.leads ?? [];
  const page = leads.data?.page ?? { page: query.page, pageSize: PAGE_SIZE, total: 0 };
  const pages = Math.max(1, Math.ceil(page.total / page.pageSize));
  const pagerBusy = !leads.data || Boolean(waiting) || leads.loading;
  const leadHref = (lead: LeadListItem) =>
    panel ? panel.href(lead.id) : `/w/${workspaceSlug}/leads/${lead.id}`;
  const openLead = (lead: LeadListItem) =>
    panel ? panel.onOpen(lead.id) : router.push(leadHref(lead));
  const contactsAllowed = leads.data ? leads.data.access.contacts : (canUseProperties ?? false);
  const canSort = contactsAllowed && !query.archived && Boolean(onSort);

  // The type's countdown (a SIM order's arrival) gets a column; on every type's
  // tab, when this page holds a lead that has one.
  const countdownType = query.type ?? rows.find((lead) => lead.countdownDate)?.leadType;
  const countdownField = countdownType ? leadCountdownField(countdownType) : undefined;
  const showCol = (key: LeadTableColumn) => !query.hide.includes(key);
  const showingCountdown = Boolean(countdownField && showCol('countdown'));
  const initialLoading = !leads.data || Boolean(waiting);
  const propertyColumns = contactsAllowed
    ? (query.columns ?? []).filter((key) => !(showingCountdown && countdownField?.key === key))
    : [];
  const hasFilters = Boolean(
    query.q || query.stage || query.assignee || (query.where && query.where.length > 0),
  );
  const optionalColumns: readonly LeadTableColumn[] = [
    'stage',
    'assignee',
    'nextTask',
    'source',
    'created',
    'activity',
  ];
  const selecting = selection !== undefined && onSelectionChange !== undefined;

  // Stage and assignee change in place for whoever manages leads (not in the archive).
  const canQuickEdit = leads.data?.access.manage === true && !query.archived;
  const [quickBusy, setQuickBusy] = useState<string>();
  const [quickMessage, setQuickMessage] = useState<string>();
  const [quickNote, setQuickNote] = useState<string>();
  const self = members.find((member) => member.isSelf);
  async function quickUpdate(
    lead: LeadListItem,
    body: { stage: string } | { assignedActorId: string | null },
  ) {
    setQuickBusy(lead.id);
    setQuickMessage(undefined);
    setQuickNote(undefined);
    try {
      await updateStaffLead(accessToken, workspaceId, lead.id, body);
      notifyLeadWorkSaved(workspaceId, lead.id);
      await leads.reload();
    } catch (error) {
      const refusal =
        'stage' in body
          ? stageMoveRefusal(errorReason(error), lead.leadType, lead.stage)
          : undefined;
      setQuickMessage(refusal ?? describeError(error, 'save the change'));
    } finally {
      setQuickBusy(undefined);
    }
  }
  async function copyEmail(email: string) {
    setQuickMessage(undefined);
    setQuickNote(undefined);
    try {
      await navigator.clipboard.writeText(email);
      setQuickNote('Email copied.');
    } catch {
      setQuickMessage('The browser did not allow copying. Open the lead and copy it from there.');
    }
  }
  function quickStage(lead: LeadListItem, to: string) {
    // A move that asks for details or documents is made on the lead itself.
    if (stageGates(lead.leadType, to).length > 0) openLead(lead);
    else void quickUpdate(lead, { stage: to });
  }
  const isTicked = (leadId: string) =>
    selecting && (selection.allMatching || selection.selected.has(leadId));
  const tickedOnPage = rows.filter((lead) => isTicked(lead.id)).length;
  const pageTicked = rows.length > 0 && tickedOnPage === rows.length;
  const tickedCount = !selecting ? 0 : selection.allMatching ? page.total : selection.selected.size;

  function tickRow(leadId: string, on: boolean) {
    if (!selecting) return;
    // "Every lead matching" minus one is this page's other rows, as ticks.
    const next = new Set(selection.allMatching ? rows.map((lead) => lead.id) : selection.selected);
    if (on) next.add(leadId);
    else next.delete(leadId);
    onSelectionChange({ selected: next, allMatching: false });
  }
  function tickPage(on: boolean) {
    if (!selecting) return;
    const next = new Set(selection.allMatching ? [] : selection.selected);
    for (const lead of rows) {
      if (on) next.add(lead.id);
      else next.delete(lead.id);
    }
    onSelectionChange({ selected: next, allMatching: false });
  }

  const cell = cn('px-3', CELL_Y[density]);
  const columnCount =
    Number(selecting) +
    1 +
    1 /* row actions */ +
    Number(!query.type && showCol('type')) +
    optionalColumns.filter(showCol).length +
    Number(showingCountdown) +
    propertyColumns.length;

  if (leads.error) {
    return (
      <p role="alert" className="py-10 text-center text-sm text-muted-foreground">
        {describeError(leads.failure, 'load the leads')}{' '}
        <button type="button" className="underline" onClick={() => void leads.reload()}>
          Try again
        </button>
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {initialLoading ? (
        <span role="status" aria-label="Loading leads…" className="sr-only">
          Loading leads…
        </span>
      ) : null}
      {selectionBar && selecting && tickedCount > 0 ? (
        <div
          role="status"
          aria-label="Selected leads"
          className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm"
        >
          <span className="font-medium tabular-nums">
            {selection.allMatching
              ? `All ${countFormat.format(page.total)} leads matching are selected`
              : `${countFormat.format(tickedCount)} selected`}
          </span>
          {!selection.allMatching && pageTicked && page.total > tickedCount ? (
            <button
              type="button"
              className="text-primary underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onSelectionChange({ selected: new Set(), allMatching: true })}
            >
              Select all {countFormat.format(page.total)} leads matching
            </button>
          ) : null}
          <button
            type="button"
            className="text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onSelectionChange(NO_LEAD_SELECTION)}
          >
            Clear selection
          </button>
          {selectionActions ? <span className="ml-auto flex gap-2">{selectionActions}</span> : null}
        </div>
      ) : null}
      {quickMessage ? (
        <p role="alert" className="text-sm text-destructive">
          {quickMessage}
        </p>
      ) : null}
      {quickNote ? (
        <p role="status" className="text-sm text-muted-foreground">
          {quickNote}
        </p>
      ) : null}
      <div className="overflow-x-auto rounded-lg border">
        <table
          className="w-full text-sm md:min-w-[880px]"
          aria-busy={initialLoading || leads.loading}
        >
          <thead>
            <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              {selecting ? (
                <th scope="col" className="w-10 py-3 pr-0 pl-3 text-left">
                  <Checkbox
                    aria-label="Select all leads on this page"
                    checked={pageTicked ? true : tickedOnPage > 0 ? 'indeterminate' : false}
                    disabled={rows.length === 0}
                    onCheckedChange={(checked) => tickPage(checked === true)}
                    className="block"
                  />
                </th>
              ) : null}
              <SortableHeader
                label="Lead"
                field="fullName"
                currentSort={query.sort}
                canSort={canSort}
                onSort={onSort}
              />
              {query.type || !showCol('type') ? null : (
                <th scope="col" className={cn(HEAD_CELL, WIDE)}>
                  Type
                </th>
              )}
              {showCol('stage') ? (
                <th scope="col" className={cn(HEAD_CELL, WIDE)}>
                  Stage
                </th>
              ) : null}
              {showCol('assignee') ? (
                <th scope="col" className={cn(HEAD_CELL, WIDE)}>
                  Assignee
                </th>
              ) : null}
              {showCol('nextTask') ? (
                <th scope="col" className={cn(HEAD_CELL, WIDE)}>
                  Next task
                </th>
              ) : null}
              {countdownField && showCol('countdown') ? (
                <SortableHeader
                  className={WIDE}
                  label={countdownField.label}
                  field={`prop.${countdownField.key}`}
                  currentSort={query.sort}
                  canSort={canSort}
                  onSort={onSort}
                />
              ) : null}
              {propertyColumns.map((key) => (
                <SortableHeader
                  className={WIDE}
                  key={key}
                  label={propertyColumnLabel(query.type, key, catalog)}
                  field={`prop.${key}`}
                  currentSort={query.sort}
                  canSort={canSort}
                  onSort={onSort}
                />
              ))}
              {showCol('source') ? (
                <th scope="col" className={cn(HEAD_CELL, WIDE)}>
                  Source
                </th>
              ) : null}
              {showCol('created') ? (
                <SortableHeader
                  className={WIDE}
                  label="Created"
                  field="createdAt"
                  currentSort={query.sort}
                  canSort={canSort}
                  onSort={onSort}
                />
              ) : null}
              {showCol('activity') ? (
                query.archived ? (
                  <th scope="col" className={cn(HEAD_CELL, WIDE)}>
                    Archived
                  </th>
                ) : (
                  <SortableHeader
                    className={WIDE}
                    label="Last activity"
                    field="updatedAt"
                    currentSort={query.sort}
                    canSort={canSort}
                    onSort={onSort}
                  />
                )
              ) : null}
              <th scope="col" className={cn('w-10 px-2', WIDE)}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {initialLoading ? (
              <TableRowsSkeleton columns={columnCount} />
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={columnCount} className="px-3 py-10 text-center text-muted-foreground">
                  {query.archived ? (
                    'The archive is empty.'
                  ) : query.due ? (
                    'No follow-ups due today or earlier.'
                  ) : hasFilters ? (
                    <>
                      <span>No leads match these filters.</span>
                      {onClearFilters ? (
                        <>
                          {' '}
                          <button
                            type="button"
                            className="font-medium text-foreground underline"
                            onClick={onClearFilters}
                          >
                            Clear filters
                          </button>
                        </>
                      ) : null}
                    </>
                  ) : (
                    'No leads yet.'
                  )}
                </td>
              </tr>
            ) : (
              rows.map((lead) => {
                const assignee = assigneeName(lead.assignedActorId, members);
                const secondary = secondaryLine(lead);
                const lastChange = query.archived
                  ? (lead.deletedAt ?? lead.updatedAt)
                  : lead.updatedAt;
                return (
                  <tr
                    key={lead.id}
                    aria-current={panel?.openId === lead.id ? 'true' : undefined}
                    className="group/row cursor-pointer border-b transition-colors last:border-0 hover:bg-muted/40 aria-[current=true]:bg-muted/60"
                    onClick={(event) => {
                      // Let a real link, a modifier-click or a text selection behave natively;
                      // the checkbox cell ticks the row and opens nothing.
                      if (
                        event.target instanceof HTMLElement &&
                        event.target.closest('a, [data-row-select]')
                      ) {
                        return;
                      }
                      if (window.getSelection()?.toString()) return;
                      openLead(lead);
                    }}
                  >
                    {selecting ? (
                      <td
                        data-row-select
                        className={cn('w-10 cursor-default pr-0 pl-3', CELL_Y[density])}
                      >
                        <Checkbox
                          aria-label={`Select ${leadDisplayName(lead.contact)}`}
                          checked={isTicked(lead.id)}
                          onCheckedChange={(checked) => tickRow(lead.id, checked === true)}
                          className="block"
                        />
                      </td>
                    ) : null}
                    <td className={cn(cell, 'w-full max-w-0 md:w-auto md:max-w-[260px]')}>
                      <span className="flex min-w-0 items-center gap-1.5">
                        <Link
                          href={leadHref(lead)}
                          data-lead-id={lead.id}
                          className={cn(
                            'min-w-0 truncate text-foreground hover:underline',
                            leadNameWeight(lead.isNew),
                          )}
                          onClick={(event) => {
                            // A plain click opens the panel; a modifier-click opens a tab.
                            if (!panel || event.button !== 0) return;
                            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
                              return;
                            }
                            event.preventDefault();
                            panel.onOpen(lead.id);
                          }}
                        >
                          {leadDisplayName(lead.contact)}
                        </Link>
                        {lead.isNew ? <NewBadge /> : null}
                        {showCol('stage') ? (
                          <span className="ml-auto shrink-0 pl-2 md:hidden">
                            <StageBadge leadType={lead.leadType} stage={lead.stage} />
                          </span>
                        ) : null}
                      </span>
                      {secondary ? (
                        <span className="hidden truncate text-xs text-muted-foreground md:block">
                          {secondary}
                        </span>
                      ) : null}
                      <span
                        data-slot="lead-row-phone-meta"
                        className="mt-0.5 block truncate text-xs text-muted-foreground md:hidden"
                      >
                        {[
                          query.type ? undefined : leadTypeLabel(lead.leadType),
                          assignee ?? 'Unassigned',
                          readableSource(lead.source),
                          relativeTime(lastChange),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </td>
                    {query.type || !showCol('type') ? null : (
                      <td className={cn(cell, WIDE, 'whitespace-nowrap text-muted-foreground')}>
                        {leadTypeLabel(lead.leadType)}
                      </td>
                    )}
                    {showCol('stage') ? (
                      <td
                        className={cn(cell, WIDE)}
                        {...(canQuickEdit ? { 'data-row-select': true } : {})}
                      >
                        {canQuickEdit && allowedStageMoves(lead.leadType, lead.stage).length > 0 ? (
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              disabled={quickBusy === lead.id}
                              aria-label={`Change stage of ${leadDisplayName(lead.contact)}, now ${leadStageLabel(lead.leadType, lead.stage)}`}
                              className={QUICK_TRIGGER}
                            >
                              <StageBadge leadType={lead.leadType} stage={lead.stage} />
                              <ChevronDownIcon aria-hidden="true" className={QUICK_CHEVRON} />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start" onClick={stopRowClick}>
                              <DropdownMenuLabel>Move to</DropdownMenuLabel>
                              {allowedStageMoves(lead.leadType, lead.stage).map((to) => (
                                <DropdownMenuItem key={to} onSelect={() => quickStage(lead, to)}>
                                  {leadStageLabel(lead.leadType, to)}
                                  {stageGates(lead.leadType, to).length > 0 ? (
                                    <span className="ml-auto pl-3 text-xs text-muted-foreground">
                                      asks for details
                                    </span>
                                  ) : null}
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : (
                          <StageBadge leadType={lead.leadType} stage={lead.stage} />
                        )}
                      </td>
                    ) : null}
                    {showCol('assignee') ? (
                      <td
                        className={cn(cell, WIDE, 'max-w-[180px]')}
                        {...(canQuickEdit ? { 'data-row-select': true } : {})}
                      >
                        {canQuickEdit ? (
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              disabled={quickBusy === lead.id}
                              aria-label={`Change assignee of ${leadDisplayName(lead.contact)}, now ${assignee ?? 'unassigned'}`}
                              className={QUICK_TRIGGER}
                            >
                              {assignee ? (
                                <PersonChip name={assignee} size="xs" />
                              ) : (
                                <span className="text-muted-foreground">Unassigned</span>
                              )}
                              <ChevronDownIcon aria-hidden="true" className={QUICK_CHEVRON} />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start" onClick={stopRowClick}>
                              <DropdownMenuLabel>Assign to</DropdownMenuLabel>
                              {lead.assignedActorId !== null ? (
                                <DropdownMenuItem
                                  onSelect={() => void quickUpdate(lead, { assignedActorId: null })}
                                >
                                  Unassigned
                                </DropdownMenuItem>
                              ) : null}
                              {members
                                .filter((member) => member.actorId !== lead.assignedActorId)
                                .map((member) => (
                                  <DropdownMenuItem
                                    key={member.actorId}
                                    onSelect={() =>
                                      void quickUpdate(lead, { assignedActorId: member.actorId })
                                    }
                                  >
                                    {memberName(member)}
                                    {member.isSelf ? ' (you)' : ''}
                                  </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : assignee ? (
                          <PersonChip name={assignee} size="xs" />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    ) : null}
                    {showCol('nextTask') ? (
                      <td className={cn(cell, WIDE, 'whitespace-nowrap')}>
                        {lead.nextTaskDueAt ? (
                          <span className={DUE_TONE_CLASS[dueTone(lead.nextTaskDueAt)]}>
                            {dueLabel(lead.nextTaskDueAt)}
                            {lead.openTaskCount > 1 ? ` · ${lead.openTaskCount} open` : ''}
                          </span>
                        ) : lead.openTaskCount > 0 ? (
                          <span className="text-muted-foreground">{lead.openTaskCount} open</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    ) : null}
                    {countdownField && showCol('countdown') ? (
                      <td className={cn(cell, WIDE, 'whitespace-nowrap')}>
                        {lead.countdownDate ? (
                          <>
                            <span className="block">{dayLabel(lead.countdownDate)}</span>
                            <CountdownLabel day={lead.countdownDate} className="block" />
                          </>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    ) : null}
                    {propertyColumns.map((key) => {
                      const property = propertyColumnProperty(lead.leadType, key, catalog);
                      return (
                        <td key={key} className={cn(cell, WIDE, 'max-w-[200px] truncate')}>
                          <PropertyValueText
                            property={property ?? { kind: 'text' }}
                            value={lead.properties?.[key]}
                          />
                        </td>
                      );
                    })}
                    {showCol('source') ? (
                      <td className={cn(cell, WIDE, 'max-w-[180px] truncate')}>
                        <span className="text-muted-foreground" title={lead.source}>
                          {readableSource(lead.source)}
                        </span>
                      </td>
                    ) : null}
                    {showCol('created') ? (
                      <td
                        className={cn(cell, WIDE, 'whitespace-nowrap text-muted-foreground')}
                        title={dateTimeLabel(lead.createdAt)}
                      >
                        {relativeTime(lead.createdAt)}
                      </td>
                    ) : null}
                    {showCol('activity') ? (
                      <td
                        className={cn(cell, WIDE, 'whitespace-nowrap text-muted-foreground')}
                        title={dateTimeLabel(lastChange)}
                      >
                        {relativeTime(lastChange)}
                      </td>
                    ) : null}
                    <td className={cn('w-10 px-2 text-right', CELL_Y[density], WIDE)}>
                      <RowActions
                        name={leadDisplayName(lead.contact)}
                        pageHref={`/w/${workspaceSlug}/leads/${lead.id}`}
                        email={lead.contact.email ?? undefined}
                        canAssignToMe={
                          canQuickEdit &&
                          self !== undefined &&
                          lead.assignedActorId !== self.actorId &&
                          quickBusy !== lead.id
                        }
                        onOpen={() => openLead(lead)}
                        onAssignToMe={() =>
                          self
                            ? void quickUpdate(lead, { assignedActorId: self.actorId })
                            : undefined
                        }
                        onCopyEmail={(email) => void copyEmail(email)}
                      />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* The count, or how many are ticked, on the left; the pager only when there is more than one page. */}
      <div
        data-slot="lead-list-footer"
        className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm text-muted-foreground"
      >
        <p className={cn('tabular-nums', initialLoading && 'invisible')}>
          {tickedCount > 0
            ? `${countFormat.format(tickedCount)} of ${countFormat.format(page.total)} selected`
            : `${countFormat.format(page.total)} lead${page.total === 1 ? '' : 's'}`}
        </p>
        {pages > 1 || page.page > 1 ? (
          <nav aria-label="Lead pages" className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-8"
              aria-label="First page"
              title="First page"
              disabled={pagerBusy || page.page <= 1}
              onClick={() => onPage(1)}
            >
              <ChevronsLeftIcon aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pagerBusy || page.page <= 1}
              onClick={() => onPage(Math.max(1, Math.min(page.page - 1, pages)))}
            >
              Previous
            </Button>
            <span className="px-1.5 whitespace-nowrap tabular-nums">
              Page {page.page} of {pages}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pagerBusy || page.page >= pages}
              onClick={() => onPage(page.page + 1)}
            >
              Next
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-8"
              aria-label="Last page"
              title="Last page"
              disabled={pagerBusy || page.page >= pages}
              onClick={() => onPage(pages)}
            >
              <ChevronsRightIcon aria-hidden="true" />
            </Button>
          </nav>
        ) : null}
      </div>
    </div>
  );
}
