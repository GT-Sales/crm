'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import {
  aiCardDraftSchema,
  leadTaskStatusSchema,
  type AiActionCard,
  type AiCardDraft,
  type AiStageMoveNeed,
} from '@gt-sales/contracts';
import { Button, Input, Textarea } from '@gt-sales/ui';
import { TASK_STATUS_LABELS } from '../leads/lead-tasks';
import { useOptionalAssistant, type AiActionView } from './assistant-provider';
import { safeInternalHref } from './assistant-sources';
import { dateTimeLabel } from '../../lib/dates';
import { describeInvalid } from '../../lib/error-text';

/** Why a stage cannot be chosen on the card: it is completed on the lead page first. */
const STAGE_NEED_LABELS: Record<AiStageMoveNeed, string> = {
  dispatch_details: 'needs dispatch details on the lead page',
  activation_details: 'needs an activation date on the lead page',
  documents: 'needs documents approved on the lead page',
};

type Kind = AiCardDraft['kind'];

const FIELD_LABELS = {
  stage: 'Stage',
  assignedActorId: 'Assigned to',
  fullName: 'Customer name',
  phone: 'Phone',
} as const;

/** The card's accessible name, for each kind. */
const REGION_NAMES: Record<Kind, string> = {
  note: 'Confirm note',
  task: 'Confirm task',
  email: 'Review email',
  lead_update: 'Confirm lead update',
  task_update: 'Confirm task move',
  lead_edit: 'Confirm lead change',
  template_email: 'Review email',
  lead_archive: 'Confirm archive change',
  automation_off: 'Confirm automation switch-off',
};

const SAVED_TEXT: Record<Kind, string> = {
  note: 'Note added.',
  task: 'Task created.',
  email: 'Email queued for delivery.',
  lead_update: 'Lead updated.',
  task_update: 'Task updated.',
  lead_edit: 'Lead updated.',
  template_email: 'Email queued for delivery.',
  lead_archive: 'Done.',
  automation_off: 'Automation switched off.',
};

/** What the card says once saved: a task whose stage alone changed was moved (T9). */
function savedText(draft: AiCardDraft): string {
  if (draft.kind === 'lead_archive') return draft.archived ? 'Lead archived.' : 'Lead restored.';
  if (
    draft.kind === 'task_update' &&
    draft.title === undefined &&
    draft.dueDate === undefined &&
    draft.assignee === undefined
  )
    return 'Task moved.';
  return SAVED_TEXT[draft.kind];
}

const dayLabel = (day: string | null | undefined): string =>
  day
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(
        new Date(`${day}T12:00:00Z`),
      )
    : 'No due date';

function titleOf(proposal: AiActionCard): string {
  const draft = proposal.draft;
  switch (draft.kind) {
    case 'lead_update':
      return `Update ${FIELD_LABELS[draft.field].toLowerCase()}`;
    case 'note':
      return 'Add a note';
    case 'email':
      return 'Email the lead’s customer';
    case 'task_update':
      return proposal.taskEditContext ? 'Change a task' : 'Move a task';
    case 'task':
      return draft.leadId === undefined ? 'Create a task' : 'Create a follow-up task';
    case 'lead_edit':
      return draft.changes.stage !== undefined ? 'Move the lead' : 'Change the lead';
    case 'template_email':
      return `Send the “${proposal.templateEmailContext?.templateName ?? 'template'}” email`;
    case 'lead_archive':
      return draft.archived ? 'Archive the lead' : 'Restore the lead';
    case 'automation_off':
      return `Switch off “${proposal.automationOffContext?.name ?? 'automation'}”`;
  }
}

/** One “current → proposed” line; screen readers hear “current … proposed …”. */
function Change({
  label,
  before,
  after,
  emptyAfter = 'Cleared',
}: {
  label: string;
  before: string | null;
  after: string | null;
  /** What an empty proposed value reads as: cleared, or a detail still to be typed. */
  emptyAfter?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="font-medium">{label}</dt>
      <dd className="break-words text-muted-foreground">
        <span className="sr-only">Current: </span>
        {before ?? 'Not set'}
        <span aria-hidden="true"> → </span>
        <span className="sr-only">. Proposed: </span>
        <span className="text-foreground">{after ?? emptyAfter}</span>
      </dd>
    </div>
  );
}

/** C3: what Confirm sets off besides the change, every entry in full. */
function SideEffects({ effects }: { effects: readonly string[] }) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="space-y-1 rounded-lg border border-border p-2.5 text-xs"
    >
      <h4 id={id} className="font-medium">
        What else happens
      </h4>
      <ul className="list-disc space-y-1 pl-4">
        {effects.map((effect) => (
          <li key={effect} className="break-words">
            {effect}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Seconds until the card expires, rechecked so the card turns to "expired" on time. */
function useExpired(expiresAt: string): boolean {
  const [expired, setExpired] = useState(() => Date.parse(expiresAt) <= Date.now());
  useEffect(() => {
    const remaining = Date.parse(expiresAt) - Date.now();
    if (remaining <= 0) {
      setExpired(true);
      return;
    }
    setExpired(false);
    const timer = setTimeout(() => setExpired(true), Math.min(remaining, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [expiresAt]);
  return expired;
}

export function AssistantAction({
  action,
  onConfirm,
  onCancel,
  onRevise,
}: {
  action: AiActionView;
  /** `acknowledged`: the person ticked the mention warning (B1). */
  onConfirm(acknowledged?: boolean): void;
  onCancel(): void;
  onRevise(draft: AiCardDraft): void;
}) {
  const { proposal, status } = action;
  // UI-9: while an answer streams the provider ignores Confirm and Revise, so
  // the buttons say so instead of doing nothing.
  const streaming = useOptionalAssistant()?.streaming ?? false;
  const draft = proposal.draft;
  const kind = draft.kind;
  const isEmail = kind === 'email' || kind === 'template_email';
  const taskContext = proposal.taskUpdateContext;
  const editContext = proposal.leadEditContext;
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState<AiCardDraft>(draft);
  const [editError, setEditError] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const acknowledgeId = useId();
  const expired = useExpired(proposal.expiresAt);
  const href = proposal.leadHref === undefined ? undefined : safeInternalHref(proposal.leadHref);
  const choices = proposal.assigneeChoices ?? [
    { value: 'me', label: 'You' },
    { value: 'none', label: 'Unassigned' },
  ];
  const assigneeLabel = (value: string | undefined) =>
    choices.find((choice) => choice.value === value)?.label ?? 'A member';
  // Cards the person cannot edit: the server's own mail, an archive and a
  // switch, and a lead change with no detail to type (T6: never an empty form).
  const editable =
    kind !== 'template_email' &&
    kind !== 'lead_archive' &&
    kind !== 'automation_off' &&
    (kind !== 'lead_edit' || (editContext?.inputs.length ?? 0) > 0);
  // T4: where focus goes after each step, so a keyboard user never lands on the page.
  const regionRef = useRef<HTMLElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const previous = useRef({ status, editing });
  useEffect(() => {
    const before = previous.current;
    previous.current = { status, editing };
    if (before.status === status && before.editing === editing) return;
    // Only when the person was working in this card (or its control vanished
    // under them): a card that changes on its own takes no focus from elsewhere.
    const active = document.activeElement;
    const region = regionRef.current;
    if (active !== null && active !== document.body && !region?.contains(active)) return;
    if (editing) {
      formRef.current?.querySelector<HTMLElement>('input, textarea, select')?.focus();
      return;
    }
    if (status === 'pending') {
      const next = [confirmRef.current, editRef.current].find(
        (button) => button !== null && !button.disabled,
      );
      (next ?? statusRef.current)?.focus();
      return;
    }
    statusRef.current?.focus();
  }, [status, editing]);
  // A stage move's order details still to be typed on the card.
  const missingInputs =
    draft.kind === 'lead_edit'
      ? (editContext?.inputs ?? []).filter((input) => {
          if (!input.required) return false;
          const value = draft.changes.order?.[input.field];
          return (value === undefined ? input.current : value) === null || value === '';
        })
      : [];
  const blocked =
    expired ||
    missingInputs.length > 0 ||
    (proposal.acknowledgementRequired === true && !acknowledged);

  function submitEdit() {
    let next = edited;
    if (next.kind === 'task_update' && taskContext && proposal.taskEditContext) {
      // Only what differs from the task as it is goes in the draft.
      const { status: nextStatus, title, dueDate, assignee, ...rest } = next;
      next = {
        ...rest,
        ...(nextStatus !== undefined && nextStatus !== taskContext.before
          ? { status: nextStatus }
          : {}),
        ...(title !== undefined && title !== taskContext.title ? { title } : {}),
        ...(dueDate !== undefined && dueDate !== proposal.taskEditContext.dueDate
          ? { dueDate }
          : {}),
        ...(assignee !== undefined ? { assignee } : {}),
      };
    }
    const parsed = aiCardDraftSchema.safeParse(next);
    if (!parsed.success) {
      setEditError(
        describeInvalid(parsed.error, {
          subject: 'The email subject',
          body: edited.kind === 'email' ? 'The email message' : 'The note',
          title: 'The task title',
          dueDate: 'The due date',
          assignee: 'The assignee',
          value: 'The proposed value',
          status: 'The new stage',
          changes: 'The change',
        }),
      );
      return;
    }
    setEditError('');
    setEditing(false);
    onRevise(parsed.data);
  }

  return (
    <section
      ref={regionRef}
      aria-label={REGION_NAMES[kind]}
      className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-3 text-sm"
    >
      <div>
        <h3 className="font-semibold">{titleOf(proposal)}</h3>
        <p className="mt-1 break-words text-xs text-muted-foreground">
          {proposal.siteName} ·{' '}
          {kind === 'automation_off' ? 'Automation' : (proposal.leadLabel ?? 'No lead')}
        </p>
      </div>
      {isEmail && proposal.emailContext ? (
        <dl className="space-y-1 break-all text-xs">
          <div>
            <dt className="inline text-muted-foreground">To: </dt>
            <dd className="inline">{proposal.emailContext.toAddress}</dd>
          </div>
          <div>
            <dt className="inline text-muted-foreground">From: </dt>
            <dd className="inline">{proposal.emailContext.fromAddress}</dd>
          </div>
        </dl>
      ) : null}
      {editing ? (
        <form
          ref={formRef}
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            submitEdit();
          }}
        >
          {edited.kind === 'email' ? (
            <label className="block text-xs">
              Subject
              <Input
                aria-label="Email subject"
                value={edited.subject}
                maxLength={150}
                onChange={(event) => setEdited({ ...edited, subject: event.target.value })}
              />
            </label>
          ) : null}
          {edited.kind === 'lead_update' ? (
            <label className="block text-xs">
              {FIELD_LABELS[edited.field]}
              {edited.field === 'stage' || edited.field === 'assignedActorId' ? (
                <select
                  aria-label="Proposed value"
                  className="block w-full rounded border bg-background p-2"
                  value={edited.value ?? ''}
                  onChange={(event) => setEdited({ ...edited, value: event.target.value || null })}
                >
                  {proposal.leadUpdateContext?.choices.map((choice) => (
                    <option
                      key={choice.value ?? ''}
                      value={choice.value ?? ''}
                      disabled={choice.needs !== undefined}
                    >
                      {choice.needs === undefined
                        ? choice.label
                        : `${choice.label} — ${STAGE_NEED_LABELS[choice.needs]}`}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  aria-label="Proposed value"
                  value={edited.value ?? ''}
                  maxLength={edited.field === 'phone' ? 40 : 160}
                  onChange={(event) => setEdited({ ...edited, value: event.target.value })}
                />
              )}
            </label>
          ) : edited.kind === 'task' ? (
            <>
              <label className="block text-xs">
                Task title
                <Input
                  aria-label="Task title"
                  value={edited.title}
                  maxLength={200}
                  onChange={(event) => setEdited({ ...edited, title: event.target.value })}
                />
              </label>
              <label className="block text-xs">
                Due date
                <Input
                  type="date"
                  aria-label="Task due date"
                  value={edited.dueDate ?? ''}
                  onChange={(event) =>
                    setEdited({ ...edited, dueDate: event.target.value || null })
                  }
                />
              </label>
              <label className="block text-xs">
                Assigned to
                <select
                  aria-label="Task assignee"
                  className="block w-full rounded border bg-background p-2"
                  value={edited.assignee}
                  onChange={(event) => setEdited({ ...edited, assignee: event.target.value })}
                >
                  {choices.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : edited.kind === 'task_update' ? (
            <>
              <label className="block text-xs">
                New stage
                <select
                  aria-label="New stage"
                  className="block w-full rounded border bg-background p-2"
                  value={edited.status ?? taskContext?.before ?? ''}
                  onChange={(event) => {
                    const next = leadTaskStatusSchema.safeParse(event.target.value);
                    if (next.success) setEdited({ ...edited, status: next.data });
                  }}
                >
                  {leadTaskStatusSchema.options
                    .filter((option) => proposal.taskEditContext || option !== taskContext?.before)
                    .map((option) => (
                      <option key={option} value={option}>
                        {option === taskContext?.before
                          ? `${TASK_STATUS_LABELS[option]} (no change)`
                          : TASK_STATUS_LABELS[option]}
                      </option>
                    ))}
                </select>
              </label>
              {proposal.taskEditContext ? (
                <>
                  <label className="block text-xs">
                    Task title
                    <Input
                      aria-label="Task title"
                      value={edited.title ?? taskContext?.title ?? ''}
                      maxLength={200}
                      onChange={(event) => setEdited({ ...edited, title: event.target.value })}
                    />
                  </label>
                  <label className="block text-xs">
                    Due date
                    <Input
                      type="date"
                      aria-label="Task due date"
                      value={
                        (edited.dueDate === undefined
                          ? proposal.taskEditContext.dueDate
                          : edited.dueDate) ?? ''
                      }
                      onChange={(event) =>
                        setEdited({ ...edited, dueDate: event.target.value || null })
                      }
                    />
                  </label>
                  <label className="block text-xs">
                    Assigned to
                    <select
                      aria-label="Task assignee"
                      className="block w-full rounded border bg-background p-2"
                      value={edited.assignee ?? ''}
                      onChange={(event) =>
                        setEdited(
                          event.target.value === ''
                            ? (({ assignee: _assignee, ...rest }) => rest)(edited)
                            : { ...edited, assignee: event.target.value },
                        )
                      }
                    >
                      <option value="">{proposal.taskEditContext.assigneeLabel} (no change)</option>
                      {choices.map((choice) => (
                        <option key={choice.value} value={choice.value}>
                          {choice.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              ) : null}
            </>
          ) : edited.kind === 'lead_edit' ? (
            (editContext?.inputs ?? []).map((input) => {
              const value = edited.changes.order?.[input.field];
              return (
                <label key={input.field} className="block text-xs">
                  {input.label}
                  {input.required ? ' (required)' : ''}
                  <Input
                    type={input.kind === 'date' ? 'date' : 'text'}
                    aria-label={input.label}
                    aria-required={input.required}
                    maxLength={120}
                    value={(value === undefined ? input.current : value) ?? ''}
                    onChange={(event) => {
                      const text = event.target.value.trim();
                      setEdited({
                        ...edited,
                        changes: {
                          ...edited.changes,
                          order: {
                            ...edited.changes.order,
                            [input.field]: text === '' ? null : event.target.value,
                          },
                        },
                      });
                    }}
                  />
                </label>
              );
            })
          ) : edited.kind === 'note' || edited.kind === 'email' ? (
            <label className="block text-xs">
              {edited.kind === 'email' ? 'Message' : 'Note'}
              <Textarea
                aria-label={edited.kind === 'email' ? 'Email message' : 'Note text'}
                value={edited.body}
                rows={5}
                maxLength={4000}
                onChange={(event) => setEdited({ ...edited, body: event.target.value })}
              />
            </label>
          ) : null}
          {editError ? <p role="alert">{editError}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" type="submit" disabled={streaming}>
              Update draft
            </Button>
            <Button
              size="sm"
              variant="ghost"
              type="button"
              onClick={() => {
                setEditing(false);
                setEdited(draft);
              }}
            >
              Discard edits
            </Button>
          </div>
        </form>
      ) : (
        <CardBody proposal={proposal} assigneeLabel={assigneeLabel} />
      )}
      {proposal.sideEffects && proposal.sideEffects.length > 0 ? (
        <SideEffects effects={proposal.sideEffects} />
      ) : null}
      {proposal.mentions && proposal.mentions.length > 0 ? (
        <div className="space-y-2 rounded-lg border border-amber-500/60 bg-amber-500/10 p-2.5 text-xs">
          <p className="font-medium">This names other customers: {proposal.mentions.join(', ')}.</p>
          <p>Check that it should, before it goes to this lead.</p>
          {proposal.acknowledgementRequired ? (
            <label htmlFor={acknowledgeId} className="flex items-start gap-2">
              <input
                id={acknowledgeId}
                type="checkbox"
                className="mt-0.5"
                checked={acknowledged}
                disabled={status === 'saving' || status === 'saved'}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              <span>I checked it, and it may name them.</span>
            </label>
          ) : null}
        </div>
      ) : null}
      {missingInputs.length > 0 && status === 'pending' ? (
        <p className="text-xs">
          Enter the {missingInputs.map((input) => input.label.toLowerCase()).join(' and ')} with
          Edit, then Update draft, before you confirm.
        </p>
      ) : null}
      <p
        ref={statusRef}
        role="status"
        tabIndex={-1}
        className="text-xs text-muted-foreground outline-none"
      >
        {status === 'saved'
          ? savedText(draft)
          : status === 'refused'
            ? action.error
            : status === 'cancelled'
              ? (action.error ?? 'Cancelled. Nothing was saved.')
              : status === 'revising'
                ? 'Updating draft…'
                : status === 'saving'
                  ? 'Saving…'
                  : status === 'error'
                    ? action.error
                    : expired
                      ? 'This draft expired. Nothing was saved. Check the lead, then ask for a fresh draft.'
                      : (action.error ??
                        `Nothing is saved until you confirm. Expires ${dateTimeLabel(proposal.expiresAt)}.`)}
      </p>
      {!editing &&
      (status === 'pending' ||
        status === 'error' ||
        status === 'saving' ||
        status === 'revising') ? (
        <div className="flex flex-wrap gap-2">
          <Button
            ref={confirmRef}
            type="button"
            size="sm"
            disabled={status === 'saving' || status === 'revising' || streaming || blocked}
            onClick={() => onConfirm(proposal.acknowledgementRequired === true && acknowledged)}
          >
            {status === 'error' ? 'Retry save' : isEmail ? 'Send' : 'Confirm'}
          </Button>
          {status === 'pending' && editable && !expired ? (
            <Button
              ref={editRef}
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setEdited(draft);
                setEditing(true);
              }}
            >
              Edit
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={status === 'saving' || status === 'revising'}
            onClick={onCancel}
          >
            {status === 'error' ? 'Dismiss' : 'Cancel'}
          </Button>
        </div>
      ) : null}
      {streaming && (status === 'pending' || status === 'error') ? (
        <p className="text-xs text-muted-foreground">
          Wait for the answer to finish, then confirm or edit this draft.
        </p>
      ) : null}
      {kind === 'lead_update' || kind === 'lead_edit' ? (
        <p className="text-xs text-muted-foreground">
          Confirm applies this change using the CRM’s rules and may trigger enabled automations. If
          the lead changes, request a fresh draft.
        </p>
      ) : null}
      {kind === 'task_update' ? (
        <p className="text-xs text-muted-foreground">
          Confirm moves the task as the Tasks page does. If the task changes first, request a fresh
          draft.
        </p>
      ) : null}
      {kind === 'email' ? (
        <p className="text-xs text-muted-foreground">
          Sends from this Site to the customer address on the lead. Queued mail is delivered by the
          email service.
        </p>
      ) : null}
      {kind === 'template_email' ? (
        <p className="text-xs text-muted-foreground">
          The Site’s template, filled in from the lead as shown. If the template or the lead changes
          first, Send is refused and you can ask for a fresh draft.
        </p>
      ) : null}
      {href ? (
        <Link href={href} className="text-xs underline underline-offset-2">
          {kind === 'automation_off' ? 'View automation' : 'View lead'}
        </Link>
      ) : null}
    </section>
  );
}

/** What the card proposes, read-only. */
function CardBody({
  proposal,
  assigneeLabel,
}: {
  proposal: AiActionCard;
  assigneeLabel: (value: string | undefined) => string;
}) {
  const draft = proposal.draft;
  const taskContext = proposal.taskUpdateContext;
  switch (draft.kind) {
    case 'lead_update':
      return (
        <p className="whitespace-pre-wrap break-words rounded-lg bg-muted/60 p-2.5">
          <span className="block text-xs text-muted-foreground">Current</span>
          <span>{proposal.leadUpdateContext?.beforeLabel}</span>
          <span className="mt-2 block text-xs text-muted-foreground">Proposed</span>
          <span>
            {proposal.leadUpdateContext?.choices.find((choice) => choice.value === draft.value)
              ?.label ??
              draft.value ??
              'Unassigned'}
          </span>
        </p>
      );
    case 'task':
      return (
        <>
          <p className="whitespace-pre-wrap break-words rounded-lg bg-muted/60 p-2.5">
            {draft.title}
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Due</dt>
            <dd>{dayLabel(draft.dueDate)}</dd>
            <dt className="text-muted-foreground">Assigned to</dt>
            <dd className="break-words">{assigneeLabel(draft.assignee)}</dd>
          </dl>
        </>
      );
    case 'task_update': {
      const edit = proposal.taskEditContext;
      return (
        <>
          <p className="whitespace-pre-wrap break-words rounded-lg bg-muted/60 p-2.5">
            {taskContext?.title ?? 'Task'}
          </p>
          {edit ? (
            <dl className="space-y-2 text-xs">
              {draft.status !== undefined ? (
                <Change
                  label="Stage"
                  before={taskContext ? TASK_STATUS_LABELS[taskContext.before] : null}
                  after={TASK_STATUS_LABELS[draft.status]}
                />
              ) : null}
              {draft.title !== undefined ? (
                <Change label="Title" before={taskContext?.title ?? null} after={draft.title} />
              ) : null}
              {draft.dueDate !== undefined ? (
                <Change
                  label="Due"
                  before={dayLabel(edit.dueDate)}
                  after={dayLabel(draft.dueDate)}
                />
              ) : null}
              {draft.assignee !== undefined ? (
                <Change
                  label="Assigned to"
                  before={edit.assigneeLabel}
                  after={assigneeLabel(draft.assignee)}
                />
              ) : null}
            </dl>
          ) : (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">Current stage</dt>
              <dd>{taskContext ? TASK_STATUS_LABELS[taskContext.before] : 'Unknown'}</dd>
              <dt className="text-muted-foreground">New stage</dt>
              <dd>{draft.status ? TASK_STATUS_LABELS[draft.status] : 'No change'}</dd>
            </dl>
          )}
        </>
      );
    }
    case 'lead_edit': {
      // T2: exactly the rows the server computed and signed: each one changes,
      // or is a detail the move requires (a courier still to be typed).
      const context = proposal.leadEditContext;
      const required = new Set(
        (context?.inputs ?? [])
          .filter((input) => input.required)
          .map((input) => `order.${input.field}`),
      );
      return (
        <dl className="space-y-2 rounded-lg bg-muted/60 p-2.5 text-xs">
          {context?.rows.map((row) =>
            required.has(row.key) ? (
              <Change
                key={row.key}
                label={`${row.label} (required)`}
                before={row.before}
                after={row.after}
                emptyAfter="To enter with Edit"
              />
            ) : (
              <Change key={row.key} label={row.label} before={row.before} after={row.after} />
            ),
          )}
        </dl>
      );
    }
    case 'template_email':
      return (
        <>
          <p className="font-medium break-words">{proposal.templateEmailContext?.subject}</p>
          <p className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-muted/60 p-2.5">
            {proposal.templateEmailContext?.text}
          </p>
        </>
      );
    case 'lead_archive':
      return (
        <p className="rounded-lg bg-muted/60 p-2.5">
          {draft.archived
            ? 'Archive this lead. It can be restored from the archive.'
            : 'Restore this lead to the inbox.'}
        </p>
      );
    case 'automation_off':
      return (
        <p className="rounded-lg bg-muted/60 p-2.5">
          Switch “{proposal.automationOffContext?.name}” off. Switching it on again is done on the
          Automations page.
        </p>
      );
    case 'email':
      return (
        <>
          <p className="font-medium break-words">{draft.subject}</p>
          <p className="whitespace-pre-wrap break-words rounded-lg bg-muted/60 p-2.5">
            {draft.body}
          </p>
        </>
      );
    case 'note':
      return (
        <p className="whitespace-pre-wrap break-words rounded-lg bg-muted/60 p-2.5">{draft.body}</p>
      );
  }
}
