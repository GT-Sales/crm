'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { leadTypeLabel, type LeadTaskStatus, type WorkspaceTask } from '@gt-sales/contracts';
import { cn } from '@gt-sales/ui';

import { listStaffTasks, updateLeadTask } from '../../lib/api';
import { dueDay, todayDay } from '../../lib/dates';
import { errorReason, useResource } from '../../lib/use-resource';
import { leadDisplayName } from './lead-display';
import { TaskRow } from './lead-tasks';
import { useLeadWorkspace } from './use-lead-workspace';

type Scope = 'me' | 'none';

const GROUPS = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'today', label: 'Today' },
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'undated', label: 'No due date' },
] as const;

type GroupKey = (typeof GROUPS)[number]['key'];

function groupOf(task: WorkspaceTask, today: string): GroupKey {
  if (!task.dueAt) return 'undated';
  const day = dueDay(task.dueAt);
  if (day < today) return 'overdue';
  if (day === today) return 'today';
  return 'upcoming';
}

/**
 * "My tasks": every open task assigned to the viewer on this site, by due
 * date, with the lead it belongs to; or the unassigned ones, for picking up
 * work. Completing one here completes it on the lead.
 */
export function MyTasks({ workspaceSlug }: { workspaceSlug: string }) {
  const { workspaceId, accessToken, members } = useLeadWorkspace(workspaceSlug);
  const [scope, setScope] = useState<Scope>('me');
  const load = useMemo(
    () =>
      accessToken && workspaceId
        ? () =>
            listStaffTasks(accessToken, workspaceId, {
              assignee: scope,
              status: 'open',
              pageSize: 200,
            })
        : undefined,
    [accessToken, workspaceId, scope],
  );
  const tasks = useResource(load);
  const [busyId, setBusyId] = useState<string>();
  const [message, setMessage] = useState<string>();
  const today = todayDay();

  async function setStatus(task: WorkspaceTask, status: LeadTaskStatus) {
    if (!accessToken || !workspaceId) return;
    setBusyId(task.id);
    setMessage(undefined);
    try {
      const result = await updateLeadTask(accessToken, workspaceId, task.id, { status });
      tasks.mutate((current) => ({
        ...current,
        tasks: current.tasks.map((entry) =>
          entry.id === task.id ? { ...entry, ...result.task } : entry,
        ),
      }));
    } catch (error) {
      setMessage(`The task was not updated. Reason: ${errorReason(error)}.`);
    } finally {
      setBusyId(undefined);
    }
  }

  const list = tasks.data?.tasks ?? [];
  const openCount = list.filter((task) => task.status === 'open').length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">My tasks</h1>
          <p className="text-sm text-muted-foreground">
            Follow-ups on this site’s leads, soonest first.
          </p>
        </div>
        <div
          role="group"
          aria-label="Whose tasks"
          className="inline-flex rounded-md border p-0.5 text-sm"
        >
          {(
            [
              ['me', 'Assigned to me'],
              ['none', 'Unassigned'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={scope === value}
              onClick={() => setScope(value)}
              className={cn(
                'rounded px-2.5 py-1',
                scope === value ? 'bg-muted text-foreground' : 'text-muted-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {message ? (
        <p role="alert" className="text-sm text-rose-300">
          {message}
        </p>
      ) : null}

      {tasks.error ? (
        <p role="alert" className="text-sm text-muted-foreground">
          {tasks.error === 'permission_denied'
            ? 'Your role does not include lead tasks.'
            : `Could not load tasks. Reason: ${tasks.error}.`}
        </p>
      ) : !tasks.data ? (
        <p className="text-sm text-muted-foreground" aria-busy="true">
          Loading tasks…
        </p>
      ) : list.length === 0 ? (
        <p className="rounded-lg border px-4 py-10 text-center text-sm text-muted-foreground">
          {scope === 'me'
            ? 'Nothing due. Tasks you are given on a lead show up here.'
            : 'No unassigned tasks.'}
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {openCount} open task{openCount === 1 ? '' : 's'}
          </p>
          {GROUPS.map((group) => {
            const entries = list.filter((task) => groupOf(task, today) === group.key);
            if (entries.length === 0) return null;
            return (
              <section
                key={group.key}
                aria-labelledby={`tasks-${group.key}`}
                className="rounded-lg border"
              >
                <h2
                  id={`tasks-${group.key}`}
                  className={cn(
                    'border-b px-4 py-2 text-sm font-semibold',
                    group.key === 'overdue' && 'text-rose-300',
                  )}
                >
                  {group.label}{' '}
                  <span className="font-normal text-muted-foreground">{entries.length}</span>
                </h2>
                <ul className="divide-y px-4">
                  {entries.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      members={members}
                      canWrite={tasks.data?.access.manage ?? false}
                      busy={busyId === task.id}
                      onStatus={(status) => void setStatus(task, status)}
                    >
                      <Link
                        href={`/w/${workspaceSlug}/leads/${task.lead.id}`}
                        className="text-xs text-muted-foreground hover:text-foreground hover:underline"
                      >
                        {leadDisplayName(task.lead.contact)} · {leadTypeLabel(task.lead.leadType)}
                      </Link>
                    </TaskRow>
                  ))}
                </ul>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
