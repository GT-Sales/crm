'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo } from 'react';
import {
  leadCountdownField,
  leadTypeLabel,
  type AssignableMember,
  type LeadListItem,
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
import type { InboxQuery } from './inbox-query';
import { CountdownLabel, leadDisplayName, NewBadge, PersonChip, StageBadge } from './lead-display';

const PAGE_SIZE = 50;

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

/** The inbox as a table: one row per lead, newest activity first (follow-ups due: most overdue first). */
export function LeadsTable({
  workspaceSlug,
  workspaceId,
  accessToken,
  members,
  query,
  onPage,
}: {
  workspaceSlug: string;
  workspaceId: string;
  accessToken: string;
  members: readonly AssignableMember[];
  query: InboxQuery;
  onPage(page: number): void;
}) {
  const router = useRouter();
  const load = useMemo(
    () => () =>
      getStaffLeads(accessToken, workspaceId, {
        type: query.type,
        stage: query.stage,
        assignee: query.assignee,
        q: query.q,
        view: query.trash ? 'trash' : 'active',
        // Due by the viewer's own today: due dates are calendar days.
        dueBy: query.due ? todayDay() : undefined,
        page: query.page,
        pageSize: PAGE_SIZE,
      }),
    [
      accessToken,
      workspaceId,
      query.type,
      query.stage,
      query.assignee,
      query.q,
      query.trash,
      query.due,
      query.page,
    ],
  );
  const leads = useResource(load);
  const rows = leads.data?.leads ?? [];
  const page = leads.data?.page ?? { page: query.page, pageSize: PAGE_SIZE, total: 0 };
  const pages = Math.max(1, Math.ceil(page.total / page.pageSize));
  const leadHref = (lead: LeadListItem) => `/w/${workspaceSlug}/leads/${lead.id}`;
  // The type's countdown (a SIM order's arrival) gets a column; on every type's
  // tab, when this page holds a lead that has one.
  const countdownType = query.type ?? rows.find((lead) => lead.countdownDate)?.leadType;
  const countdownField = countdownType ? leadCountdownField(countdownType) : undefined;

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
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[880px] text-sm" aria-busy={leads.loading}>
          <thead>
            <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <th scope="col" className="px-3 py-2 font-medium">
                Lead
              </th>
              {query.type ? null : (
                <th scope="col" className="px-3 py-2 font-medium">
                  Type
                </th>
              )}
              <th scope="col" className="px-3 py-2 font-medium">
                Stage
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Assignee
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Next task
              </th>
              {countdownField ? (
                <th scope="col" className="px-3 py-2 font-medium">
                  {countdownField.label}
                </th>
              ) : null}
              <th scope="col" className="px-3 py-2 font-medium">
                Source
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Created
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {query.trash ? 'Deleted' : 'Last activity'}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-3 py-10 text-center text-muted-foreground">
                  {leads.loading
                    ? 'Loading…'
                    : query.trash
                      ? 'The trash is empty.'
                      : query.due
                        ? 'No follow-ups due today or earlier.'
                        : query.q || query.stage || query.assignee
                          ? 'No leads match these filters.'
                          : 'No leads yet.'}
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
                    className="cursor-pointer border-b transition-colors last:border-0 hover:bg-muted/40"
                    onClick={(event) => {
                      // Let a real link, a modifier-click or a text selection behave natively.
                      if (event.target instanceof HTMLElement && event.target.closest('a')) return;
                      if (window.getSelection()?.toString()) return;
                      router.push(leadHref(lead));
                    }}
                  >
                    <td className="max-w-[260px] px-3 py-2">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <Link
                          href={leadHref(lead)}
                          className="min-w-0 truncate font-medium text-foreground hover:underline"
                        >
                          {leadDisplayName(lead.contact)}
                        </Link>
                        {lead.isNew ? <NewBadge /> : null}
                      </span>
                      {secondary ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          {secondary}
                        </span>
                      ) : null}
                    </td>
                    {query.type ? null : (
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                        {leadTypeLabel(lead.leadType)}
                      </td>
                    )}
                    <td className="px-3 py-2">
                      <StageBadge leadType={lead.leadType} stage={lead.stage} />
                    </td>
                    <td className="max-w-[180px] px-3 py-2">
                      {assignee ? (
                        <PersonChip name={assignee} size="xs" />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
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
                    {countdownField ? (
                      <td className="px-3 py-2 whitespace-nowrap">
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
                    <td className="max-w-[180px] truncate px-3 py-2">
                      <code className="text-xs text-muted-foreground">{lead.source}</code>
                    </td>
                    <td
                      className="px-3 py-2 whitespace-nowrap text-muted-foreground"
                      title={dateTimeLabel(lead.createdAt)}
                    >
                      {relativeTime(lead.createdAt)}
                    </td>
                    <td
                      className="px-3 py-2 whitespace-nowrap text-muted-foreground"
                      title={dateTimeLabel(lastChange)}
                    >
                      {relativeTime(lastChange)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <nav aria-label="Lead pages" className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={leads.loading || page.page <= 1}
          onClick={() => onPage(Math.max(1, page.page - 1))}
        >
          Previous
        </Button>
        <span className={cn('text-sm text-muted-foreground')}>
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
