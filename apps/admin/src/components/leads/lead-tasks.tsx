'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { AssignableMember, LeadTask, LeadTaskStatus } from '@gt-sales/contracts';
import { Button, cn, Input, NativeSelect } from '@gt-sales/ui';
import { XIcon } from 'lucide-react';

import { createLeadTask, updateLeadTask } from '../../lib/api';
import { dueAtFromDay, dueSentence, dueTone } from '../../lib/dates';
import { assigneeName, memberName } from '../../lib/people';
import { errorReason } from '../../lib/use-resource';
import { PersonChip } from './lead-display';
import { DUE_TONE_CLASS } from './leads-table';

/** A task row: complete it with the checkbox, cancel it with the cross. */
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
  const closed = status !== 'open';
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
          {status === 'cancelled' ? <span>Cancelled</span> : null}
        </p>
      </div>
      {canWrite && status === 'open' ? (
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

  const open = tasks.filter((task) => task.status === 'open');
  const closed = tasks.filter((task) => task.status !== 'open');

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
    <section aria-labelledby="tasks-heading" className="flex flex-col gap-2">
      <h2 id="tasks-heading" className="text-base font-semibold">
        Tasks{' '}
        <span className="text-sm font-normal text-muted-foreground">
          {open.length === 0 ? 'none open' : `${open.length} open`}
        </span>
      </h2>
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
        <form onSubmit={(event) => void add(event)} className="flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-[2_1_14rem]">
            <span className="sr-only">New task</span>
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Add a task, e.g. Call back about the install date"
              maxLength={200}
            />
          </label>
          <label className="flex-[1_1_9rem]">
            <span className="sr-only">Due date</span>
            <Input type="date" value={day} onChange={(event) => setDay(event.target.value)} />
          </label>
          <label className="flex-[1_1_9rem]">
            <span className="sr-only">Assign the task to</span>
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
          <Button type="submit" size="sm" disabled={saving || title.trim() === ''}>
            {saving ? 'Adding…' : 'Add task'}
          </Button>
        </form>
      ) : null}

      {message ? (
        <p role="alert" className="text-sm text-rose-300">
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
