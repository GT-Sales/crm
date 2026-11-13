'use client';

import Link from 'next/link';
import { useState, type DragEvent, type FormEvent } from 'react';
import {
  isActiveTaskStatus,
  leadTypeLabel,
  type AssignableMember,
  type LeadTaskStatus,
  type WorkspaceTask,
} from '@gt-sales/contracts';
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
} from '@gt-sales/ui';
import { AlertCircleIcon, CheckIcon, EllipsisIcon } from 'lucide-react';

import { dueAtFromDay, dueDay, dueLabel, relativeTime } from '../../lib/dates';
import { describeError } from '../../lib/error-text';
import { assigneeName } from '../../lib/people';
import { leadDisplayName, PersonChip } from './lead-display';
import { TASK_STATUS_LABELS, TaskStatusBadge } from './lead-tasks';

/**
 * The Tasks page's board. Two layouts, one card:
 *
 * - **By status**: To do, In progress and Done. Inside To do and In progress
 *   the cards are grouped by due date (Overdue, Today, Upcoming, No due
 *   date), as the list groups them. Moving a card changes its status.
 * - **By date**: Overdue, Today, Upcoming and No due date (the active tasks,
 *   each card badged To do or In progress), then Done. Moving a card to
 *   Today dates it today, to Upcoming tomorrow (another day is picked from the
 *   card's menu) and to No due date clears it; Overdue only shows, it takes
 *   no drops. A done task moved to a date column is reopened as To do.
 *
 * Done holds the tasks completed in the last `DONE_WINDOW_DAYS` days, most
 * recent first, `DONE_PAGE` at a time behind "Show more". Cancelled tasks are
 * not on the board. Every move is a drag (native HTML5, as the leads board
 * drags) or the card's menu, the keyboard and touch path, which offers every
 * status and due-date change.
 */

export const DONE_WINDOW_DAYS = 14;
export const DONE_PAGE = 10;
const DRAG_TYPE = 'application/x-gt-task';

export type BoardGroupBy = 'status' | 'date';
export type DateGroup = 'overdue' | 'today' | 'upcoming' | 'undated';
export type BoardColumnKey = 'open' | 'in_progress' | 'done' | DateGroup;

export interface TaskChange {
  status?: LeadTaskStatus;
  dueAt?: string | null;
}

export const DATE_GROUPS: readonly { key: DateGroup; label: string }[] = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'today', label: 'Today' },
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'undated', label: 'No due date' },
];

const COLUMN_LABELS: Record<BoardColumnKey, string> = {
  open: 'To do',
  in_progress: 'In progress',
  done: 'Done',
  overdue: 'Overdue',
  today: 'Today',
  upcoming: 'Upcoming',
  undated: 'No due date',
};

export const BOARD_COLUMNS: Record<BoardGroupBy, readonly BoardColumnKey[]> = {
  status: ['open', 'in_progress', 'done'],
  date: ['overdue', 'today', 'upcoming', 'undated', 'done'],
};

/** The list's date group of a task, against the viewer's `today`. */
export function dateGroupOf(task: Pick<WorkspaceTask, 'dueAt'>, today: string): DateGroup {
  if (!task.dueAt) return 'undated';
  const day = dueDay(task.dueAt);
  if (day < today) return 'overdue';
  if (day === today) return 'today';
  return 'upcoming';
}

/** `YYYY-MM-DD` plus `days` calendar days. */
export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const byDue = (a: WorkspaceTask, b: WorkspaceTask) =>
  (a.dueAt ?? '￿').localeCompare(b.dueAt ?? '￿') ||
  a.createdAt.localeCompare(b.createdAt) ||
  a.id.localeCompare(b.id);

const byCompleted = (a: WorkspaceTask, b: WorkspaceTask) =>
  (b.completedAt ?? '').localeCompare(a.completedAt ?? '') || a.id.localeCompare(b.id);

/** The cards of one column, in order: soonest due first, Done most recently completed first. */
export function columnTasks(
  tasks: readonly WorkspaceTask[],
  column: BoardColumnKey,
  today: string,
): WorkspaceTask[] {
  if (column === 'done') {
    const since = `${addDays(today, -DONE_WINDOW_DAYS)}T00:00:00.000Z`;
    return tasks
      .filter((task) => task.status === 'done' && (task.completedAt ?? '') >= since)
      .sort(byCompleted);
  }
  if (column === 'open' || column === 'in_progress') {
    return tasks.filter((task) => task.status === column).sort(byDue);
  }
  return tasks
    .filter((task) => isActiveTaskStatus(task.status) && dateGroupOf(task, today) === column)
    .sort(byDue);
}

/**
 * What moving `task` into `column` changes, or undefined when the move does
 * nothing (its own column) or is not allowed (Overdue takes no drops).
 */
export function dropChange(
  task: WorkspaceTask,
  column: BoardColumnKey,
  today: string,
): TaskChange | undefined {
  if (column === 'open' || column === 'in_progress' || column === 'done') {
    return task.status === column ? undefined : { status: column };
  }
  if (column === 'overdue') return undefined;
  const active = isActiveTaskStatus(task.status);
  if (active && dateGroupOf(task, today) === column) return undefined;
  const dueAt =
    column === 'today'
      ? dueAtFromDay(today)
      : column === 'upcoming'
        ? dueAtFromDay(addDays(today, 1))
        : null;
  const change: TaskChange = {};
  if (!active) change.status = 'open';
  if ((task.dueAt === null ? null : dueDay(task.dueAt)) !== (dueAt && dueDay(dueAt))) {
    change.dueAt = dueAt;
  }
  return Object.keys(change).length > 0 ? change : undefined;
}

/** A move in words, for the page's announcement: `In progress`, `due Tomorrow`. */
export function changeWords(change: TaskChange): string {
  const parts: string[] = [];
  if (change.status) parts.push(TASK_STATUS_LABELS[change.status]);
  if (change.dueAt !== undefined)
    parts.push(change.dueAt === null ? 'no due date' : `due ${dueLabel(change.dueAt)}`);
  return parts.join(', ');
}

export function TasksBoard({
  tasks,
  groupBy,
  today,
  members,
  workspaceSlug,
  canWrite,
  busyIds,
  doneState,
  onMove,
}: {
  /** The active tasks and the recently done ones, together. */
  tasks: readonly WorkspaceTask[];
  groupBy: BoardGroupBy;
  today: string;
  members: readonly AssignableMember[];
  workspaceSlug: string;
  canWrite: boolean;
  /** Tasks with a move on its way; they take no other move until it settles. */
  busyIds: ReadonlySet<string>;
  /** The Done column's own load. */
  doneState: { loading: boolean; error?: string; failure?: unknown };
  onMove(task: WorkspaceTask, change: TaskChange): void;
}) {
  const [dragging, setDragging] = useState<string>();
  const [dropTarget, setDropTarget] = useState<BoardColumnKey>();
  const [doneShown, setDoneShown] = useState(DONE_PAGE);
  const [picking, setPicking] = useState<string>();
  const byId = new Map(tasks.map((task) => [task.id, task]));

  function move(task: WorkspaceTask, change: TaskChange | undefined) {
    if (!change || busyIds.has(task.id)) return;
    onMove(task, change);
  }

  function onDrop(event: DragEvent<HTMLElement>, column: BoardColumnKey) {
    event.preventDefault();
    setDropTarget(undefined);
    setDragging(undefined);
    const task = byId.get(event.dataTransfer.getData(DRAG_TYPE));
    if (task) move(task, dropChange(task, column, today));
  }

  function card(task: WorkspaceTask) {
    const assignee = assigneeName(task.assignedActorId, members);
    const active = isActiveTaskStatus(task.status);
    const overdue = active && dateGroupOf(task, today) === 'overdue';
    const busy = busyIds.has(task.id);
    const leadName = leadDisplayName(task.lead.contact);
    return (
      <li
        key={task.id}
        data-task-id={task.id}
        draggable={canWrite && !busy && picking !== task.id}
        onDragStart={(event) => {
          event.dataTransfer.setData(DRAG_TYPE, task.id);
          event.dataTransfer.effectAllowed = 'move';
          setDragging(task.id);
        }}
        onDragEnd={() => {
          setDragging(undefined);
          setDropTarget(undefined);
        }}
        aria-busy={busy || undefined}
        className={cn(
          'rounded-md border bg-card p-3 text-sm shadow-xs transition-colors hover:border-primary/40 dark:bg-background',
          canWrite && 'cursor-grab active:cursor-grabbing',
          overdue && 'border-l-[3px] border-l-rose-500 dark:border-l-rose-400',
          dragging === task.id && 'opacity-50',
          busy && 'opacity-70',
        )}
      >
        <div className="flex items-start gap-2">
          <p
            className={cn(
              'min-w-0 flex-1 font-medium break-words',
              task.status === 'done' && 'text-muted-foreground line-through',
            )}
          >
            {task.title}
          </p>
          {canWrite ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="-mt-1 -mr-1 size-7 shrink-0 text-muted-foreground"
                  disabled={busy}
                  aria-label={`Move “${task.title}”`}
                >
                  <EllipsisIcon className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Status</DropdownMenuLabel>
                {(['open', 'in_progress', 'done'] as const).map((status) => (
                  <DropdownMenuItem
                    key={status}
                    disabled={task.status === status}
                    onSelect={() => move(task, { status })}
                  >
                    {task.status === status ? (
                      <CheckIcon className="size-3.5" aria-hidden="true" />
                    ) : (
                      <span
                        aria-hidden="true"
                        className={cn('size-2 rounded-full', columnDot(status))}
                      />
                    )}
                    {TASK_STATUS_LABELS[status]}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Due date</DropdownMenuLabel>
                <DropdownMenuItem
                  disabled={task.dueAt !== null && dueDay(task.dueAt) === today}
                  onSelect={() => move(task, { dueAt: dueAtFromDay(today) })}
                >
                  Today
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={task.dueAt !== null && dueDay(task.dueAt) === addDays(today, 1)}
                  onSelect={() => move(task, { dueAt: dueAtFromDay(addDays(today, 1)) })}
                >
                  Tomorrow
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setPicking(task.id)}>
                  Pick a date…
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={task.dueAt === null}
                  onSelect={() => move(task, { dueAt: null })}
                >
                  No due date
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
        <Link
          href={`/w/${workspaceSlug}/leads/${task.lead.id}`}
          draggable={false}
          className="mt-0.5 block truncate text-xs text-muted-foreground hover:text-foreground hover:underline"
        >
          {leadName} · {leadTypeLabel(task.lead.leadType)}
        </Link>
        {picking === task.id ? (
          <DatePicker
            title={task.title}
            initial={task.dueAt ? dueDay(task.dueAt) : addDays(today, 1)}
            onCancel={() => setPicking(undefined)}
            onPick={(day) => {
              setPicking(undefined);
              move(
                task,
                task.dueAt !== null && dueDay(task.dueAt) === day
                  ? undefined
                  : { dueAt: dueAtFromDay(day) },
              );
            }}
          />
        ) : null}
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted-foreground">
          {task.status === 'done' && task.completedAt ? (
            <span>Done {relativeTime(task.completedAt)}</span>
          ) : task.dueAt ? (
            <span
              className={cn(
                'inline-flex items-center gap-1 whitespace-nowrap',
                overdue
                  ? 'font-medium text-rose-700 dark:text-rose-300'
                  : dateGroupOf(task, today) === 'today'
                    ? 'text-amber-700 dark:text-amber-300'
                    : undefined,
              )}
            >
              {overdue ? <AlertCircleIcon className="size-3.5" aria-hidden="true" /> : null}
              {overdue ? 'Overdue · ' : ''}
              {dueLabel(task.dueAt)}
            </span>
          ) : (
            <span>No due date</span>
          )}
          {groupBy === 'date' && active ? <TaskStatusBadge status={task.status} /> : null}
          <span className="ml-auto flex min-w-0 max-w-full justify-end">
            {assignee ? (
              <PersonChip name={assignee} size="xs" className="max-w-[8rem]" />
            ) : (
              <span>Unassigned</span>
            )}
          </span>
        </div>
      </li>
    );
  }

  return (
    <div
      role="region"
      aria-label={groupBy === 'status' ? 'Tasks board by status' : 'Tasks board by date'}
      className="-mx-6 flex snap-x scroll-px-6 gap-3 overflow-x-auto px-6 pb-4"
    >
      {BOARD_COLUMNS[groupBy].map((column) => {
        const entries = columnTasks(tasks, column, today);
        const isDone = column === 'done';
        const shown = isDone ? entries.slice(0, doneShown) : entries;
        const droppable = canWrite && column !== 'overdue';
        const label = COLUMN_LABELS[column];
        const draggedTask = dragging ? byId.get(dragging) : undefined;
        const wouldChange = draggedTask ? dropChange(draggedTask, column, today) : undefined;
        return (
          <section
            key={column}
            aria-label={`${label}, ${entries.length} task${entries.length === 1 ? '' : 's'}`}
            data-column={column}
            className={cn(
              'flex w-[17.5rem] shrink-0 snap-start flex-col gap-3 self-start rounded-2xl border bg-sidebar p-3 transition-colors sm:w-80',
              dropTarget === column && wouldChange && 'border-primary/40 bg-muted/30',
            )}
            onDragOver={(event) => {
              if (!droppable || !event.dataTransfer.types.includes(DRAG_TYPE)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              if (dropTarget !== column) setDropTarget(column);
            }}
            onDragLeave={(event) => {
              const next = event.relatedTarget instanceof Node ? event.relatedTarget : null;
              if (!event.currentTarget.contains(next)) setDropTarget(undefined);
            }}
            onDrop={(event) => (droppable ? onDrop(event, column) : undefined)}
          >
            <header className="flex items-center gap-2 px-1 py-1 text-sm font-medium">
              <span aria-hidden="true" className={cn('size-2 rounded-full', columnDot(column))} />
              <h2
                className={cn(
                  'truncate',
                  column === 'overdue' && 'text-rose-700 dark:text-rose-300',
                )}
              >
                {label}
              </h2>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {entries.length}
              </span>
              {isDone ? (
                <span className="ml-auto text-xs text-muted-foreground">
                  Last {DONE_WINDOW_DAYS} days
                </span>
              ) : null}
            </header>
            {column === 'overdue' && entries.length > 0 && canWrite ? (
              <p className="-mt-2 px-1 text-xs text-muted-foreground">
                Move a card to Today or Upcoming to reschedule it.
              </p>
            ) : null}

            {isDone && doneState.error ? (
              <p role="alert" className="px-1 py-4 text-center text-xs text-muted-foreground">
                {describeError(doneState.failure ?? doneState.error, 'load the done tasks')}
              </p>
            ) : isDone && doneState.loading && entries.length === 0 ? (
              <p className="px-1 py-4 text-center text-xs text-muted-foreground">Loading…</p>
            ) : entries.length === 0 ? (
              <p className="px-1 py-4 text-center text-xs text-muted-foreground">No tasks</p>
            ) : groupBy === 'status' && !isDone ? (
              DATE_GROUPS.map((group) => {
                const inGroup = shown.filter((task) => dateGroupOf(task, today) === group.key);
                if (inGroup.length === 0) return null;
                return (
                  <div key={group.key} className="flex flex-col gap-2">
                    <h3
                      className={cn(
                        'flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground',
                        group.key === 'overdue' && 'text-rose-700 dark:text-rose-300',
                      )}
                    >
                      {group.label}
                      <span className="font-normal tabular-nums">{inGroup.length}</span>
                    </h3>
                    <ol className="flex flex-col gap-2">{inGroup.map((task) => card(task))}</ol>
                  </div>
                );
              })
            ) : (
              <ol className="flex flex-col gap-2">{shown.map((task) => card(task))}</ol>
            )}

            {isDone && entries.length > shown.length ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 text-xs text-muted-foreground"
                onClick={() => setDoneShown((count) => count + DONE_PAGE)}
              >
                Show more ({entries.length - shown.length})
              </Button>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function columnDot(column: BoardColumnKey): string {
  switch (column) {
    case 'open':
      return 'bg-muted-foreground/50';
    case 'in_progress':
      return 'bg-sky-500';
    case 'done':
      return 'bg-emerald-500';
    case 'overdue':
      return 'bg-rose-500';
    case 'today':
      return 'bg-amber-500';
    case 'upcoming':
      return 'bg-violet-500';
    case 'undated':
      return 'bg-muted-foreground/30';
  }
}

/** The card's "Pick a date…": a date field with Save and Cancel, keyboard first. */
function DatePicker({
  title,
  initial,
  onPick,
  onCancel,
}: {
  title: string;
  initial: string;
  onPick(day: string): void;
  onCancel(): void;
}) {
  const [day, setDay] = useState(initial);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) onPick(day);
  }
  return (
    <form
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
      className="mt-2 flex flex-wrap items-center gap-2"
    >
      <Input
        type="date"
        autoFocus
        value={day}
        onChange={(event) => setDay(event.target.value)}
        aria-label={`Due date for “${title}”`}
        className="h-8 w-auto min-w-0 flex-1 text-xs"
      />
      <Button type="submit" size="sm" className="h-8">
        Save
      </Button>
      <Button type="button" size="sm" variant="ghost" className="h-8" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}
