'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef } from 'react';
import {
  leadCountdownField,
  leadTypeLabel,
  type AssignableMember,
  type LeadListItem,
  type LeadTableColumn,
  type PropertyCatalog,
} from '@gt-sales/contracts';
import { Button, cn } from '@gt-sales/ui';

import { getStaffLeads } from '../../lib/api';
import {
  dateTimeLabel,
  dayLabel,
  dueLabel,
  dueTone,
  relativeTime,
  todayDay,
} from '../../lib/dates';
import { assigneeName } from '../../lib/people';
import { useResource } from '../../lib/use-resource';
import { PropertyValueText } from '../properties/property-value';
import type { InboxQuery } from './inbox-query';
import { CountdownLabel, leadDisplayName, NewBadge, PersonChip, StageBadge } from './lead-display';
import { propertyColumnLabel, propertyColumnProperty } from './lead-fields';

const PAGE_SIZE = 50;

// A compact, Twenty-style grid: 32px rows, 13px text, the lead's name pinned
// while the rest scrolls sideways.
const HEAD_CELL = 'h-8 px-3 text-left text-[12px] font-medium whitespace-nowrap';
const CELL = 'h-8 px-3 whitespace-nowrap';
const NAME_CELL = 'sticky left-0 z-10 border-r border-crm-row-border';

export const DUE_TONE_CLASS = {
  overdue: 'text-rose-300',
  today: 'text-amber-300',
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
              view: query.trash ? 'trash' : 'active',
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
      query.trash,
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
  const rows = leads.data?.leads ?? [];
  const page = leads.data?.page ?? { page: query.page, pageSize: PAGE_SIZE, total: 0 };
  const pages = Math.max(1, Math.ceil(page.total / page.pageSize));
  const leadHref = (lead: LeadListItem) =>
    panel ? panel.href(lead.id) : `/w/${workspaceSlug}/leads/${lead.id}`;
  const openLead = (lead: LeadListItem) =>
    panel ? panel.onOpen(lead.id) : router.push(leadHref(lead));
  const contactsAllowed = leads.data ? leads.data.access.contacts : (canUseProperties ?? false);
  const canSort = contactsAllowed && !query.trash && Boolean(onSort);

  // The type's countdown (a SIM order's arrival) gets a column; on every type's
  // tab, when this page holds a lead that has one.
  const countdownType = query.type ?? rows.find((lead) => lead.countdownDate)?.leadType;
  const countdownField = countdownType ? leadCountdownField(countdownType) : undefined;
  const showCol = (key: LeadTableColumn) => !query.hide.includes(key);
  const showingCountdown = Boolean(countdownField && showCol('countdown'));
  const propertyColumns = contactsAllowed
    ? (query.columns ?? []).filter((key) => !(showingCountdown && countdownField?.key === key))
    : [];
  const hasFilters = Boolean(
    query.q || query.stage || query.assignee || (query.where && query.where.length > 0),
  );

  if (leads.error) {
    return (
      <p role="alert" className="py-10 text-center text-sm text-muted-foreground">
        Could not load leads. Reason: {leads.error}.{' '}
        <button type="button" className="underline" onClick={() => void leads.reload()}>
          Try again
        </button>
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-md border border-crm-row-border">
        <table
          className="w-full min-w-[880px] border-separate border-spacing-0 text-[13px]"
          aria-busy={leads.loading || waiting}
        >
          <thead>
            <tr className="bg-crm-header text-muted-foreground [&>th]:border-b [&>th]:border-crm-row-border">
              <SortableHeader
                label="Lead"
                field="fullName"
                currentSort={query.sort}
                canSort={canSort}
                onSort={onSort}
                className={cn(NAME_CELL, 'bg-crm-header')}
              />
              {query.type || !showCol('type') ? null : (
                <th scope="col" className={HEAD_CELL}>
                  Type
                </th>
              )}
              {showCol('stage') ? (
                <th scope="col" className={HEAD_CELL}>
                  Stage
                </th>
              ) : null}
              {showCol('assignee') ? (
                <th scope="col" className={HEAD_CELL}>
                  Assignee
                </th>
              ) : null}
              {showCol('nextTask') ? (
                <th scope="col" className={HEAD_CELL}>
                  Next task
                </th>
              ) : null}
              {countdownField && showCol('countdown') ? (
                <SortableHeader
                  label={countdownField.label}
                  field={`prop.${countdownField.key}`}
                  currentSort={query.sort}
                  canSort={canSort}
                  onSort={onSort}
                />
              ) : null}
              {propertyColumns.map((key) => (
                <SortableHeader
                  key={key}
                  label={propertyColumnLabel(query.type, key, catalog)}
                  field={`prop.${key}`}
                  currentSort={query.sort}
                  canSort={canSort}
                  onSort={onSort}
                />
              ))}
              {showCol('source') ? (
                <th scope="col" className={HEAD_CELL}>
                  Source
                </th>
              ) : null}
              {showCol('created') ? (
                <SortableHeader
                  label="Created"
                  field="createdAt"
                  currentSort={query.sort}
                  canSort={canSort}
                  onSort={onSort}
                />
              ) : null}
              {showCol('activity') ? (
                query.trash ? (
                  <th scope="col" className={HEAD_CELL}>
                    Deleted
                  </th>
                ) : (
                  <SortableHeader
                    label="Last activity"
                    field="updatedAt"
                    currentSort={query.sort}
                    canSort={canSort}
                    onSort={onSort}
                  />
                )
              ) : null}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={9 + propertyColumns.length}
                  className="px-3 py-10 text-center text-muted-foreground"
                >
                  {leads.loading || waiting ? (
                    'Loading…'
                  ) : query.trash ? (
                    'The trash is empty.'
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
                const lastChange = query.trash
                  ? (lead.deletedAt ?? lead.updatedAt)
                  : lead.updatedAt;
                return (
                  <tr
                    key={lead.id}
                    aria-current={panel?.openId === lead.id ? 'true' : undefined}
                    className="group h-8 cursor-pointer transition-colors hover:bg-crm-row-hover aria-[current=true]:bg-crm-row-hover [&>td]:border-b [&>td]:border-crm-row-border last:[&>td]:border-b-0"
                    onClick={(event) => {
                      // Let a real link, a modifier-click or a text selection behave natively.
                      if (event.target instanceof HTMLElement && event.target.closest('a')) return;
                      if (window.getSelection()?.toString()) return;
                      openLead(lead);
                    }}
                  >
                    <td
                      className={cn(
                        CELL,
                        NAME_CELL,
                        'max-w-[280px] bg-background group-hover:bg-crm-row-hover group-aria-[current=true]:bg-crm-row-hover',
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <Link
                          href={leadHref(lead)}
                          data-lead-id={lead.id}
                          className="min-w-0 shrink-0 truncate font-medium text-foreground hover:underline"
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
                        {secondary ? (
                          <span className="min-w-0 truncate text-[12px] text-muted-foreground">
                            {secondary}
                          </span>
                        ) : null}
                      </span>
                    </td>
                    {query.type || !showCol('type') ? null : (
                      <td className={cn(CELL, 'text-muted-foreground')}>
                        {leadTypeLabel(lead.leadType)}
                      </td>
                    )}
                    {showCol('stage') ? (
                      <td className={CELL}>
                        <StageBadge leadType={lead.leadType} stage={lead.stage} />
                      </td>
                    ) : null}
                    {showCol('assignee') ? (
                      <td className={cn(CELL, 'max-w-[180px]')}>
                        {assignee ? (
                          <PersonChip name={assignee} size="xs" />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    ) : null}
                    {showCol('nextTask') ? (
                      <td className={CELL}>
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
                      <td className={CELL}>
                        {lead.countdownDate ? (
                          <span className="inline-flex items-center gap-1.5">
                            <span>{dayLabel(lead.countdownDate)}</span>
                            <CountdownLabel day={lead.countdownDate} className="text-[12px]" />
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    ) : null}
                    {propertyColumns.map((key) => {
                      const property = propertyColumnProperty(lead.leadType, key, catalog);
                      return (
                        <td key={key} className={cn(CELL, 'max-w-[220px] truncate')}>
                          <PropertyValueText
                            property={property ?? { kind: 'text' }}
                            value={lead.properties?.[key]}
                          />
                        </td>
                      );
                    })}
                    {showCol('source') ? (
                      <td className={cn(CELL, 'max-w-[180px] truncate')}>
                        <code className="text-xs text-muted-foreground">{lead.source}</code>
                      </td>
                    ) : null}
                    {showCol('created') ? (
                      <td
                        className={cn(CELL, 'text-muted-foreground')}
                        title={dateTimeLabel(lead.createdAt)}
                      >
                        {relativeTime(lead.createdAt)}
                      </td>
                    ) : null}
                    {showCol('activity') ? (
                      <td
                        className={cn(CELL, 'text-muted-foreground')}
                        title={dateTimeLabel(lastChange)}
                      >
                        {relativeTime(lastChange)}
                      </td>
                    ) : null}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <nav aria-label="Lead pages" className="flex items-center gap-3 text-[13px]">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={leads.loading || page.page <= 1}
          onClick={() => onPage(Math.max(1, page.page - 1))}
        >
          Previous
        </Button>
        <span className="text-muted-foreground">
          Page {page.page} of {pages} · {page.total} lead{page.total === 1 ? '' : 's'}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={leads.loading || page.page >= pages}
          onClick={() => onPage(page.page + 1)}
        >
          Next
        </Button>
      </nav>
    </div>
  );
}
