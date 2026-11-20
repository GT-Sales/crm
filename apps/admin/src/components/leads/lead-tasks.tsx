'use client';

import { useEffect, useState, type ReactNode } from 'react';
import {
  isActiveTaskStatus,
  type AssignableMember,
  type LeadTask,
  type LeadTaskStatus,
} from '@gt-sales/contracts';
import { Button, cn } from '@gt-sales/ui';
import { CalendarDaysIcon, ListTodoIcon, XIcon } from 'lucide-react';

import { createLeadTask, updateLeadTask } from '../../lib/api';
import { dueSentence, dueTone } from '../../lib/dates';
import { assigneeName } from '../../lib/people';
import { describeError } from '../../lib/error-text';
import { TaskComposer, type NewTask } from '../tasks/task-composer';
import { PersonChip } from './lead-display';
import { DUE_TONE_CLASS } from './leads-table';

/** How a task's status reads on a badge: `To do`, `In progress`, `Done`, `Cancelled`. */
export const TASK_STATUS_LABELS: Record<LeadTaskStatus, string> = {
  open: 'To do',
  in_progress: 'In progress',
  done: 'Done',
  cancelled: 'Cancelled',
};

/** A small status badge (the Tasks board's date layout, and in-progress rows). */
export function TaskStatusBadge({
  status,
  className,
}: {
  status: LeadTaskStatus;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] leading-none font-medium',
        status === 'in_progress'
          ? 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300'
          : status === 'done'
            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
            : 'border-border bg-muted/50 text-muted-foreground',
        className,
      )}
    >
      {TASK_STATUS_LABELS[status]}
    </span>
  );
}

/**
 * A task row: complete it with the checkbox, cancel it with the cross. An
 * in-progress task carries a badge; unticking a done task makes it To do.
 */
export function TaskRow({
  task,
  members,
  canWrite,
  busy,
  onStatus,
  compact = false,
  children,
}: {
  task: LeadTask;
  members: readonly AssignableMember[];
  canWrite: boolean;
  busy: boolean;
  onStatus(status: LeadTaskStatus): void;
  compact?: boolean;
  /** Extra detail under the title, e.g. the lead on "My tasks". */
  children?: ReactNode;
}) {
  // The checkbox answers the click at once; the saved status replaces it when
  // the request settles, so a refused change springs back.
  const [pending, setPending] = useState<LeadTaskStatus>();
  useEffect(() => {
    if (!busy) setPending(undefined);
  }, [busy]);
  const status = pending ?? task.status;
  const assignee = assigneeName(task.assignedActorId, members);
  const closed = !isActiveTaskStatus(status);
  const due = (
    <span
      className={cn(
        'inline-flex items-center gap-1',
        task.dueAt && !closed && DUE_TONE_CLASS[dueTone(task.dueAt)],
      )}
    >
      {compact ? <CalendarDaysIcon aria-hidden="true" className="size-3.5 shrink-0" /> : null}
      {task.dueAt ? dueSentence(task.dueAt) : 'No due date'}
    </span>
  );
  const person = assignee ? <PersonChip name={assignee} size="xs" /> : <span>Unassigned</span>;
  const badge =
    status === 'in_progress' ? (
      <TaskStatusBadge status={status} />
    ) : status === 'cancelled' ? (
      <span>Cancelled</span>
    ) : null;
  return (
    <li
      className={cn(
        'flex gap-3',
        compact
          ? 'group/task min-h-11 items-start px-3 py-2 hover:bg-muted/30'
          : 'items-start py-2',
      )}
    >
      <input
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 accent-primary"
        checked={status === 'done'}
        disabled={!canWrite || busy || status === 'cancelled'}
        onChange={(event) => {
          const next = event.target.checked ? 'done' : 'open';
          setPending(next);
          onStatus(next);
        }}
        aria-label={`${status === 'done' ? 'Reopen' : 'Complete'} “${task.title}”`}
      />
      <div
        className={cn(
          'min-w-0 flex-1 text-sm',
          compact &&
            'grid items-center gap-x-3 gap-y-1 md:grid-cols-[minmax(0,1fr)_minmax(7rem,0.6fr)_minmax(10rem,auto)]',
        )}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p
            className={cn(
              'min-w-0 break-words',
              compact && 'font-medium',
              closed && 'text-muted-foreground line-through',
            )}
          >
            {task.title}
          </p>
          {compact ? badge : null}
        </div>
        {children}
        <div
          className={cn(
            'flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground',
            compact ? 'md:justify-end' : 'mt-0.5',
          )}
        >
          {due}
          {person}
          {compact ? null : badge}
        </div>
      </div>
      {canWrite && isActiveTaskStatus(status) ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            'size-7 text-muted-foreground',
            // In a list of many (My tasks) the cross waits for hover or focus; a
            // touch screen has no hover, so there it always shows.
            compact &&
              'opacity-0 transition-opacity group-focus-within/task:opacity-100 group-hover/task:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none pointer-coarse:opacity-100',
          )}
          disabled={busy}
          onClick={() => onStatus('cancelled')}
          aria-label={`Cancel “${task.title}”`}
        >
          <XIcon className="size-3.5" />
        </Button>
      ) : null}
    </li>
  );
}

/** The lead's follow-ups: open ones first, a form to add one, and the closed ones folded away. */
export function LeadTasks({
  workspaceId,
  leadId,
  tasks,
  members,
  canWrite,
  accessToken,
  onChange,
}: {
  workspaceId: string;
  leadId: string;
  tasks: readonly LeadTask[];
  members: readonly AssignableMember[];
  canWrite: boolean;
  accessToken: string;
  /** A created or changed task, as the backend now has it. */
  onChange(task: LeadTask): void;
}) {
  const [busyId, setBusyId] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [showClosed, setShowClosed] = useState(false);

  const open = tasks.filter((task) => isActiveTaskStatus(task.status));
  const closed = tasks.filter((task) => !isActiveTaskStatus(task.status));

  async function add(task: NewTask) {
    const result = await createLeadTask(accessToken, workspaceId, leadId, {
      title: task.title,
      dueAt: task.dueAt,
      assignedActorId: task.assignedActorId,
    });
    onChange(result.task);
  }

  async function setStatus(task: LeadTask, status: LeadTaskStatus) {
    setBusyId(task.id);
    setMessage(undefined);
    try {
      const result = await updateLeadTask(accessToken, workspaceId, task.id, { status });
      onChange(result.task);
    } catch (error) {
      setMessage(describeError(error, 'update the task'));
    } finally {
      setBusyId(undefined);
    }
  }

  return (
    <section aria-labelledby="tasks-heading" className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 id="tasks-heading" className="flex items-center gap-2 text-base font-semibold">
          <ListTodoIcon className="size-4 text-muted-foreground" aria-hidden="true" />
          Tasks
        </h2>
        <span className="rounded-full border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground tabular-nums">
          {open.length} open
        </span>
      </div>
      {open.length > 0 ? (
        <ul className="divide-y">
          {open.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              members={members}
              canWrite={canWrite}
              busy={busyId === task.id}
              onStatus={(status) => void setStatus(task, status)}
            />
          ))}
        </ul>
      ) : null}

      {canWrite ? <TaskComposer members={members} onAdd={add} onError={setMessage} /> : null}

      {message ? (
        <p role="alert" className="text-sm text-rose-700 dark:text-rose-300">
          {message}
        </p>
      ) : null}

      {closed.length > 0 ? (
        <div>
          <button
            type="button"
            className="text-xs text-muted-foreground hover:underline"
            aria-expanded={showClosed}
            onClick={() => setShowClosed((value) => !value)}
          >
            {showClosed ? 'Hide' : 'Show'} {closed.length} closed task
            {closed.length === 1 ? '' : 's'}
          </button>
          {showClosed ? (
            <ul className="divide-y">
              {closed.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  members={members}
                  canWrite={canWrite}
                  busy={busyId === task.id}
                  onStatus={(status) => void setStatus(task, status)}
                />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
