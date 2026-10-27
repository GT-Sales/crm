'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { leadTypeLabel } from '@gt-sales/contracts';
import { Card, CardContent, cn } from '@gt-sales/ui';
import { BellRingIcon } from 'lucide-react';

import { listStaffTasks } from '../lib/api';
import { dueTone, followUpLabel, todayDay } from '../lib/dates';
import { useResource } from '../lib/use-resource';
import { leadDisplayName } from './leads/lead-display';
import { useStaffSession } from './staff-session-provider';

/** As many follow-ups as Get Canada Sim's dashboard lists before "View all". */
const SHOWN = 6;

/**
 * The site's dashboard, where the day starts. Its first card is Get Canada
 * Sim's "Follow-ups due"; the totals and charts of that admin's dashboard
 * join it later (docs/GCS_ADMIN_INVENTORY.md).
 */
export function Dashboard({ workspaceSlug }: { workspaceSlug: string }) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">What needs doing on this site today.</p>
      </div>
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
