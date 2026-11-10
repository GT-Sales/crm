'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  isActiveTaskStatus,
  type AssignableMember,
  type LeadTask,
  type LeadTaskStatus,
} from '@gt-sales/contracts';
import { Button, cn, Input, NativeSelect } from '@gt-sales/ui';
import { ListTodoIcon, PlusIcon, XIcon } from 'lucide-react';

import { createLeadTask, updateLeadTask } from '../../lib/api';
import { dueAtFromDay, dueSentence, dueTone } from '../../lib/dates';
import { assigneeName, memberName } from '../../lib/people';
import { errorReason } from '../../lib/use-resource';
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
  children,
}: {
  task: LeadTask;
  members: readonly AssignableMember[];
  canWrite: boolean;
  busy: boolean;
  onStatus(status: LeadTaskStatus): void;
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
  return (
    <li className="flex items-start gap-3 py-2">
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
      <div className="min-w-0 flex-1 text-sm">
        <p className={cn('break-words', closed && 'text-muted-foreground line-through')}>
          {task.title}
        </p>
        {children}
        <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {task.dueAt ? (
            <span className={closed ? undefined : DUE_TONE_CLASS[dueTone(task.dueAt)]}>
              {dueSentence(task.dueAt)}
            </span>
          ) : (
            <span>No due date</span>
          )}
          {assignee ? <PersonChip name={assignee} size="xs" /> : <span>Unassigned</span>}
          {status === 'in_progress' ? <TaskStatusBadge status={status} /> : null}
          {status === 'cancelled' ? <span>Cancelled</span> : null}
        </p>
      </div>
      {canWrite && isActiveTaskStatus(status) ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
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
  const self = members.find((member) => member.isSelf);
  const [title, setTitle] = useState('');
  const [day, setDay] = useState('');
  const [assignee, setAssignee] = useState<string>('self');
  const [busyId, setBusyId] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();
  const [showClosed, setShowClosed] = useState(false);

  const open = tasks.filter((task) => isActiveTaskStatus(task.status));
  const closed = tasks.filter((task) => !isActiveTaskStatus(task.status));

  async function add(event: FormEvent) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setMessage(undefined);
    try {
      const assignedActorId =
        assignee === 'self' ? (self?.actorId ?? null) : assignee === 'none' ? null : assignee;
      const result = await createLeadTask(accessToken, workspaceId, leadId, {
        title: trimmed,
        dueAt: day ? dueAtFromDay(day) : null,
        assignedActorId,
      });
      onChange(result.task);
      setTitle('');
      setDay('');
    } catch (error) {
      setMessage(`The task was not added. Reason: ${errorReason(error)}.`);
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(task: LeadTask, status: LeadTaskStatus) {
    setBusyId(task.id);
    setMessage(undefined);
    try {
      const result = await updateLeadTask(accessToken, workspaceId, task.id, { status });
      onChange(result.task);
    } catch (error) {
      setMessage(`The task was not updated. Reason: ${errorReason(error)}.`);
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

      {canWrite ? (
        <form onSubmit={(event) => void add(event)} className="grid gap-4">
          <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium">
            <span>New task</span>
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="What needs to be done?"
              className="h-10"
              maxLength={200}
            />
          </label>
          <div className="grid min-w-0 grid-cols-2 gap-3">
            <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium">
              <span className="flex flex-wrap items-center gap-x-1.5">
                Due date{' '}
                <span aria-hidden="true" className="font-normal text-muted-foreground">
                  Optional
                </span>
              </span>
              <Input type="date" value={day} onChange={(event) => setDay(event.target.value)} />
            </label>
            <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium">
              <span>Assign the task to</span>
              <NativeSelect value={assignee} onChange={(event) => setAssignee(event.target.value)}>
                <option value="self">Me</option>
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
          </div>
          <div className="flex justify-end border-t pt-3">
            <Button
              type="submit"
              size="sm"
              className="h-9"
              disabled={saving || title.trim() === ''}
            >
              <PlusIcon className="size-4" aria-hidden="true" />
              {saving ? 'Adding…' : 'Add task'}
            </Button>
          </div>
        </form>
      ) : null}

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
