'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LEAD_WORK_SAVED } from '../../lib/lead-work-events';
import {
  isActiveTaskStatus,
  type LeadTaskStatus,
  type ListWorkspaceTasksResponse,
  type WorkspaceTask,
} from '@gt-sales/contracts';
import { Button, cn } from '@gt-sales/ui';
import {
  CalendarClockIcon,
  CalendarDaysIcon,
  CalendarOffIcon,
  CalendarPlusIcon,
  ChevronDownIcon,
  PlusIcon,
} from 'lucide-react';

import {
  createLeadTask,
  createPlainTask,
  getStaffLeads,
  listStaffTasks,
  updateLeadTask,
} from '../../lib/api';
import { addDays, todayDay } from '../../lib/dates';
import { describeError } from '../../lib/error-text';
import { useResource, type Resource } from '../../lib/use-resource';
import { TaskComposer, type NewTask, type TaskLeadRef } from '../tasks/task-composer';
import { TaskRow } from './lead-tasks';
import {
  changeWords,
  DATE_GROUPS,
  dateGroupOf,
  DONE_WINDOW_DAYS,
  TaskLead,
  TasksBoard,
  type BoardColumnKey,
  type BoardGroupBy,
  type TaskChange,
} from './tasks-board';
import { assigneeName } from '../../lib/people';
import { useLeadWorkspace } from './use-lead-workspace';
import { useStoredChoice } from './view-preferences';
import { LoadingSkeleton } from '../crm/loading-skeleton';

type Scope = 'me' | 'none' | 'all';
type View = 'list' | 'board';

const VIEWS = ['list', 'board'] as const;
const GROUP_BYS = ['status', 'date'] as const;
/** The viewer's own choices, kept in this browser (`useStoredChoice`). */
export const TASKS_VIEW_KEY = 'gt-tasks-view';
export const TASKS_GROUP_KEY = 'gt-tasks-board-group';
/** How many recently done tasks the board's Done column loads. */
const DONE_LOAD = 50;
const DATE_GROUP_STYLES = {
  overdue: {
    icon: CalendarClockIcon,
    className: 'bg-rose-500/10 text-rose-800 dark:text-rose-300',
  },
  today: { icon: CalendarDaysIcon, className: 'bg-sky-500/10 text-sky-800 dark:text-sky-300' },
  upcoming: {
    icon: CalendarPlusIcon,
    className: 'bg-amber-500/10 text-amber-800 dark:text-amber-300',
  },
  undated: { icon: CalendarOffIcon, className: 'bg-muted/50 text-foreground' },
} as const;

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange(next: T): void;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-md border p-0.5 text-sm">
      {options.map(([option, text]) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={cn(
            'rounded px-2.5 py-1',
            value === option ? 'bg-muted text-foreground' : 'text-muted-foreground',
          )}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function patchList(
  resource: Resource<ListWorkspaceTasksResponse>,
  id: string,
  update: (task: WorkspaceTask) => WorkspaceTask,
) {
  resource.mutate((current) => ({
    ...current,
    tasks: current.tasks.map((task) => (task.id === id ? update(task) : task)),
  }));
}

/**
 * "My tasks": the active (to do and in progress) tasks assigned to the
 * viewer on this site, the unassigned ones for picking up work, or the whole
 * team's: tasks on leads and plain tasks (no lead), which this page asks for
 * with `plain: 'include'`. As a list, by due date; as a board (`TasksBoard`),
 * by status or by date. The view and the board's grouping are this viewer's
 * choices, kept in this browser. "New task" makes a plain task, for those who
 * may change tasks.
 */
export function MyTasks({ workspaceSlug }: { workspaceSlug: string }) {
  const { workspaceId, accessToken, members } = useLeadWorkspace(workspaceSlug);
  const [scope, setScope] = useState<Scope>('me');
  const [view, setView] = useStoredChoice<View>(TASKS_VIEW_KEY, VIEWS, 'list');
  const [groupBy, setGroupBy] = useStoredChoice<BoardGroupBy>(TASKS_GROUP_KEY, GROUP_BYS, 'status');
  const today = todayDay();
  const load = useMemo(
    () =>
      accessToken && workspaceId
        ? () =>
            listStaffTasks(accessToken, workspaceId, {
              assignee: scope,
              status: 'active',
              plain: 'include',
              pageSize: 200,
            })
        : undefined,
    [accessToken, workspaceId, scope],
  );
  const tasks = useResource(load);
  const doneSince = addDays(today, -DONE_WINDOW_DAYS);
  const loadDone = useMemo(
    () =>
      accessToken && workspaceId && view === 'board'
        ? () =>
            listStaffTasks(accessToken, workspaceId, {
              assignee: scope,
              status: 'done',
              completedSince: doneSince,
              plain: 'include',
              pageSize: DONE_LOAD,
            })
        : undefined,
    [accessToken, workspaceId, scope, view, doneSince],
  );
  const done = useResource(loadDone);
  const { reload } = tasks;
  const { reload: reloadDone } = done;
  useEffect(() => {
    const saved = (event: Event) => {
      if (event instanceof CustomEvent && event.detail?.workspaceId === workspaceId) {
        void reload();
        void reloadDone();
      }
    };
    window.addEventListener(LEAD_WORK_SAVED, saved);
    return () => window.removeEventListener(LEAD_WORK_SAVED, saved);
  }, [workspaceId, reload, reloadDone]);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState<string>();
  const [announcement, setAnnouncement] = useState<string>();
  // Where the composer is open: the top of the page or one board column. One at a time.
  const [composer, setComposer] = useState<'top' | BoardColumnKey>();
  const [focusSignal, setFocusSignal] = useState(0);
  const addButton = useRef<HTMLButtonElement>(null);
  const pending = useRef(0);

  function patch(id: string, update: (task: WorkspaceTask) => WorkspaceTask) {
    patchList(tasks, id, update);
    patchList(done, id, update);
  }

  /**
   * One change to a task: shown at once, replaced by the saved task when the
   * backend answers, and put back as it was (with a message) if it refuses.
   */
  async function change(task: WorkspaceTask, next: TaskChange, action: string) {
    if (!accessToken || !workspaceId || busyIds.has(task.id)) return;
    const body: TaskChange = {};
    if (next.status !== undefined && next.status !== task.status) body.status = next.status;
    if (next.dueAt !== undefined && next.dueAt !== task.dueAt) body.dueAt = next.dueAt;
    if (body.status === undefined && body.dueAt === undefined) return;
    setBusyIds((current) => new Set(current).add(task.id));
    setMessage(undefined);
    setAnnouncement(undefined);
    const previous = task;
    patch(task.id, (current) => ({
      ...current,
      ...body,
      ...(body.status !== undefined
        ? { completedAt: body.status === 'done' ? new Date().toISOString() : null }
        : {}),
    }));
    try {
      const result = await updateLeadTask(accessToken, workspaceId, task.id, body);
      patch(task.id, (current) => ({ ...current, ...result.task }));
      setAnnouncement(`“${task.title}”: ${changeWords(body)}.`);
    } catch (error) {
      patch(task.id, () => previous);
      setMessage(describeError(error, action));
    } finally {
      setBusyIds((current) => {
        const rest = new Set(current);
        rest.delete(task.id);
        return rest;
      });
    }
  }

  function setStatus(task: WorkspaceTask, status: LeadTaskStatus) {
    void change(task, { status }, 'update the task');
  }

  const self = members.find((member) => member.isSelf);

  /**
   * A task from the composer, in its place at once: a pending card that takes
   * no moves, replaced by the saved task when the backend answers and taken
   * away again (with the composer's message) if it refuses. A task for
   * someone the list does not show is only announced.
   */
  async function addTask(next: NewTask) {
    if (!accessToken || !workspaceId) return;
    setAnnouncement(undefined);
    const tempId = `pending-${++pending.current}`;
    const now = new Date().toISOString();
    const shown =
      scope === 'all' ||
      (scope === 'none' ? next.assignedActorId === null : next.assignedActorId === self?.actorId);
    const draft: WorkspaceTask = {
      id: tempId,
      leadId: next.lead?.id ?? null,
      title: next.title,
      dueAt: next.dueAt,
      assignedActorId: next.assignedActorId,
      status: 'open',
      completedAt: null,
      createdBy: self?.actorId ?? '00000000-0000-4000-8000-000000000000',
      createdAt: now,
      updatedAt: now,
      lead: next.lead ?? null,
    };
    const without = (current: ListWorkspaceTasksResponse, ...ids: string[]) =>
      current.tasks.filter((task) => !ids.includes(task.id));
    if (shown) {
      tasks.mutate((current) => ({ ...current, tasks: [...current.tasks, draft] }));
      setBusyIds((current) => new Set(current).add(tempId));
    }
    const body = {
      title: next.title,
      dueAt: next.dueAt,
      assignedActorId: next.assignedActorId,
    };
    try {
      const result = next.lead
        ? await createLeadTask(accessToken, workspaceId, next.lead.id, body)
        : await createPlainTask(accessToken, workspaceId, body);
      const saved: WorkspaceTask = { ...result.task, lead: next.lead ?? null };
      if (shown) {
        tasks.mutate((current) => ({
          ...current,
          tasks: [...without(current, tempId, saved.id), saved],
        }));
      }
      const who =
        shown || next.assignedActorId === null
          ? ''
          : ` for ${assigneeName(next.assignedActorId, members) ?? 'a teammate'}`;
      setAnnouncement(`“${saved.title}” added${who}.`);
    } catch (error) {
      if (shown) tasks.mutate((current) => ({ ...current, tasks: without(current, tempId) }));
      throw error;
    } finally {
      setBusyIds((current) => {
        const rest = new Set(current);
        rest.delete(tempId);
        return rest;
      });
    }
  }

  const searchLeads = useCallback(
    async (query: string): Promise<TaskLeadRef[]> => {
      if (!accessToken || !workspaceId) return [];
      const result = await getStaffLeads(accessToken, workspaceId, {
        ...(query ? { q: query } : {}),
        pageSize: 8,
      });
      return result.leads.map((lead) => ({
        id: lead.id,
        leadType: lead.leadType,
        stage: lead.stage,
        contact: lead.contact,
        externalRef: lead.externalRef,
      }));
    },
    [accessToken, workspaceId],
  );

  function openComposer(where: 'top' | BoardColumnKey) {
    if (composer === where) setFocusSignal((n) => n + 1);
    setComposer(where);
  }

  /** Close the composer and put focus back on the control that opens it. */
  function closeComposer() {
    const where = composer;
    setComposer(undefined);
    setTimeout(() => {
      const target =
        where && where !== 'top'
          ? document.querySelector<HTMLElement>(`[data-add-row="${where}"]`)
          : addButton.current;
      (target ?? addButton.current)?.focus();
    }, 0);
  }

  const list = tasks.data?.tasks ?? [];
  const activeCount = list.filter((task) => isActiveTaskStatus(task.status)).length;
  // The board reads both loads as one: a task completed here stays in the
  // first until the next load, and one reopened from Done in the second.
  const boardTasks = useMemo(() => {
    const seen = new Set<string>();
    return [...(tasks.data?.tasks ?? []), ...(done.data?.tasks ?? [])].filter((task) => {
      if (seen.has(task.id)) return false;
      seen.add(task.id);
      return true;
    });
  }, [tasks.data, done.data]);
  const canWrite = tasks.data?.access.manage ?? false;

  // "C" opens the composer, as in Linear, unless the person is typing or in a menu or dialog.
  useEffect(() => {
    if (!canWrite) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'c' || event.defaultPrevented || event.repeat) return;
      if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      const target = event.target instanceof Element ? event.target : null;
      if (
        target?.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="listbox"], [role="menu"], [role="dialog"]',
        )
      )
        return;
      event.preventDefault();
      setComposer('top');
      setFocusSignal((n) => n + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canWrite]);

  const composerFor = (where: 'top' | BoardColumnKey) => (
    <TaskComposer
      members={members}
      initialDay={where === 'today' ? today : where === 'upcoming' ? addDays(today, 1) : ''}
      searchLeads={searchLeads}
      onAdd={addTask}
      onError={setMessage}
      onCancel={closeComposer}
      autoFocus
      focusSignal={focusSignal}
      className={where === 'top' ? 'max-w-2xl' : undefined}
    />
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">My tasks</h1>
          <p className="text-sm text-muted-foreground">
            Follow-ups on this site’s leads and tasks with no lead, soonest first.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canWrite ? (
            <Button
              ref={addButton}
              type="button"
              size="sm"
              aria-keyshortcuts="C"
              onClick={() => openComposer('top')}
            >
              <PlusIcon className="size-4" aria-hidden="true" />
              Add task
              <kbd
                aria-hidden="true"
                className="hidden rounded border border-primary-foreground/40 px-1 font-sans text-[10px] sm:inline"
              >
                C
              </kbd>
            </Button>
          ) : null}
          <Segmented<Scope>
            label="Whose tasks"
            value={scope}
            onChange={setScope}
            options={[
              ['me', 'Assigned to me'],
              ['none', 'Unassigned'],
              ['all', 'Everyone'],
            ]}
          />
          <Segmented<View>
            label="View"
            value={view}
            onChange={setView}
            options={[
              ['list', 'List'],
              ['board', 'Board'],
            ]}
          />
          {view === 'board' ? (
            <Segmented<BoardGroupBy>
              label="Group by"
              value={groupBy}
              onChange={setGroupBy}
              options={[
                ['status', 'Status'],
                ['date', 'Date'],
              ]}
            />
          ) : null}
        </div>
      </div>

      {canWrite && composer === 'top' ? composerFor('top') : null}

      {message ? (
        <p role="alert" className="text-sm text-rose-700 dark:text-rose-300">
          {message}
        </p>
      ) : null}
      <p role="status" className="sr-only">
        {announcement}
      </p>

      {tasks.error ? (
        <p role="alert" className="text-sm text-muted-foreground">
          {tasks.error === 'permission_denied'
            ? 'Your role does not include lead tasks. Ask the owner if you need them.'
            : describeError(tasks.failure, 'load the tasks')}
        </p>
      ) : !tasks.data ? (
        <LoadingSkeleton label="Loading tasks…" variant={view === 'board' ? 'board' : 'tasks'} />
      ) : view === 'board' ? (
        <>
          {!canWrite ? (
            <p className="text-sm text-muted-foreground">
              Your role can read these tasks but not change them.
            </p>
          ) : boardTasks.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              Drag cards to move them, or use a card’s menu.
            </p>
          ) : null}
          <TasksBoard
            tasks={boardTasks}
            groupBy={groupBy}
            today={today}
            members={members}
            workspaceSlug={workspaceSlug}
            canWrite={canWrite}
            busyIds={busyIds}
            doneState={{ loading: done.loading, error: done.error, failure: done.failure }}
            onMove={(task, next) => void change(task, next, `move “${task.title}”`)}
            addColumn={composer && composer !== 'top' ? composer : undefined}
            onAddColumn={openComposer}
            renderComposer={composerFor}
          />
        </>
      ) : list.length === 0 ? (
        <p className="rounded-lg border px-4 py-10 text-center text-sm text-muted-foreground">
          {scope === 'me'
            ? 'Nothing due. Tasks you are given show up here.'
            : scope === 'none'
              ? 'No unassigned tasks.'
              : 'No open tasks on this site.'}
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {activeCount} open task{activeCount === 1 ? '' : 's'}
          </p>
          {DATE_GROUPS.map((group) => {
            const entries = list.filter((task) => dateGroupOf(task, today) === group.key);
            if (entries.length === 0) return null;
            const { icon: GroupIcon, className } = DATE_GROUP_STYLES[group.key];
            return (
              <details
                key={group.key}
                open
                className="group/task-group overflow-hidden rounded-lg border bg-card"
              >
                <summary
                  className={cn(
                    'flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden',
                    className,
                  )}
                >
                  <ChevronDownIcon
                    aria-hidden="true"
                    className="size-3.5 shrink-0 -rotate-90 group-open/task-group:rotate-0"
                  />
                  <GroupIcon aria-hidden="true" className="size-4 shrink-0" />
                  <h2 className="text-sm font-semibold">{group.label}</h2>
                  <span className="text-xs font-medium tabular-nums">{entries.length}</span>
                </summary>
                <ul className="divide-y border-t">
                  {entries.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      members={members}
                      compact
                      canWrite={canWrite}
                      busy={busyIds.has(task.id)}
                      onStatus={(status) => setStatus(task, status)}
                    >
                      <TaskLead
                        task={task}
                        workspaceSlug={workspaceSlug}
                        className="min-w-0 truncate rounded-md border px-2 py-0.5 text-xs text-muted-foreground"
                      />
                    </TaskRow>
                  ))}
                </ul>
              </details>
            );
          })}
        </>
      )}
    </div>
  );
}
