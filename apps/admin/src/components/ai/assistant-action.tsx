'use client';

import Link from 'next/link';
import { useState } from 'react';
import { aiActionDraftSchema, type AiActionDraft, type AiStageMoveNeed } from '@gt-sales/contracts';
import { Button, Input, Textarea } from '@gt-sales/ui';
import { useOptionalAssistant, type AiActionView } from './assistant-provider';
import { safeInternalHref } from './assistant-sources';
import { dateTimeLabel } from '../../lib/dates';

/** Why a stage cannot be chosen on the card: it is completed on the lead page first. */
const STAGE_NEED_LABELS: Record<AiStageMoveNeed, string> = {
  dispatch_details: 'needs dispatch details on the lead page',
  activation_details: 'needs an activation date on the lead page',
  documents: 'needs documents approved on the lead page',
};

export function AssistantAction({
  action,
  onConfirm,
  onCancel,
  onRevise,
}: {
  action: AiActionView;
  onConfirm(): void;
  onCancel(): void;
  onRevise(draft: AiActionDraft): void;
}) {
  const { proposal, status } = action;
  // UI-9: while an answer streams the provider ignores Confirm and Revise, so
  // the buttons say so instead of doing nothing.
  const streaming = useOptionalAssistant()?.streaming ?? false;
  const draft = proposal.draft;
  const isNote = draft.kind === 'note';
  const isLeadUpdate = draft.kind === 'lead_update';
  const fieldLabel =
    draft.kind === 'lead_update'
      ? {
          stage: 'Stage',
          assignedActorId: 'Assigned to',
          fullName: 'Customer name',
          phone: 'Phone',
        }[draft.field]
      : '';
  const isEmail = draft.kind === 'email';
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState<AiActionDraft>(draft);
  const [editError, setEditError] = useState('');
  const href = safeInternalHref(proposal.leadHref);
  const due =
    draft.kind === 'task' && draft.dueDate
      ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(
          new Date(`${draft.dueDate}T12:00:00Z`),
        )
      : 'No due date';
  return (
    <section
      aria-label={
        isLeadUpdate
          ? 'Confirm lead update'
          : isNote
            ? 'Confirm note'
            : isEmail
              ? 'Review email'
              : 'Confirm task'
      }
      className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-3 text-sm"
    >
      <div>
        <h3 className="font-semibold">
          {isLeadUpdate
            ? `Update ${fieldLabel.toLowerCase()}`
            : isNote
              ? 'Add a note'
              : isEmail
                ? 'Email the lead’s customer'
                : 'Create a follow-up task'}
        </h3>
        <p className="mt-1 break-words text-xs text-muted-foreground">
          {proposal.siteName} · {proposal.leadLabel}
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
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = aiActionDraftSchema.safeParse(edited);
            if (!parsed.success) {
              setEditError('Check the text and calendar date. All fields must fit their limits.');
              return;
            }
            setEditError('');
            setEditing(false);
            onRevise(parsed.data);
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
              {fieldLabel}
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
                  onChange={(event) =>
                    setEdited({ ...edited, assignee: event.target.value === 'me' ? 'me' : 'none' })
                  }
                >
                  <option value="me">You</option>
                  <option value="none">Unassigned</option>
                </select>
              </label>
            </>
          ) : (
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
          )}
          {editError ? <p role="alert">{editError}</p> : null}
          <div className="flex gap-2">
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
        <>
          {isEmail ? (
            <p className="font-medium break-words">{draft.kind === 'email' ? draft.subject : ''}</p>
          ) : null}
          <p className="whitespace-pre-wrap break-words rounded-lg bg-muted/60 p-2.5">
            {draft.kind === 'lead_update' ? (
              <>
                <span className="block text-xs text-muted-foreground">Current</span>
                <span>{proposal.leadUpdateContext?.beforeLabel}</span>
                <span className="mt-2 block text-xs text-muted-foreground">Proposed</span>
                <span>
                  {proposal.leadUpdateContext?.choices.find(
                    (choice) => choice.value === draft.value,
                  )?.label ??
                    draft.value ??
                    'Unassigned'}
                </span>
              </>
            ) : draft.kind === 'task' ? (
              draft.title
            ) : (
              draft.body
            )}
          </p>
          {draft.kind === 'task' ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">Due</dt>
              <dd>{due}</dd>
              <dt className="text-muted-foreground">Assigned to</dt>
              <dd>{draft.assignee === 'me' ? 'You' : 'Unassigned'}</dd>
            </dl>
          ) : null}
        </>
      )}
      <p role="status" className="text-xs text-muted-foreground">
        {status === 'saved'
          ? isLeadUpdate
            ? 'Lead updated.'
            : isNote
              ? 'Note added.'
              : isEmail
                ? 'Email queued for delivery.'
                : 'Task created.'
          : status === 'cancelled'
            ? (action.error ?? 'Cancelled. Nothing was saved.')
            : status === 'revising'
              ? 'Updating draft…'
              : status === 'saving'
                ? 'Saving…'
                : status === 'error'
                  ? action.error
                  : (action.error ??
                    `Nothing is saved until you confirm. Expires ${dateTimeLabel(proposal.expiresAt)}.`)}
      </p>
      {!editing &&
      (status === 'pending' ||
        status === 'error' ||
        status === 'saving' ||
        status === 'revising') ? (
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            disabled={status === 'saving' || status === 'revising' || streaming}
            onClick={onConfirm}
          >
            {status === 'error' ? 'Retry save' : isEmail ? 'Send' : 'Confirm'}
          </Button>
          {status === 'pending' ? (
            <Button
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
      {isLeadUpdate ? (
        <p className="text-xs text-muted-foreground">
          Confirm applies this change using the CRM’s rules and may trigger enabled automations. If
          the lead changes, request a fresh draft.
        </p>
      ) : null}
      {isEmail ? (
        <p className="text-xs text-muted-foreground">
          Sends from this Site to the customer address on the lead. Queued mail is delivered by the
          email service.
        </p>
      ) : null}
      {href ? (
        <Link href={href} className="text-xs underline underline-offset-2">
          View lead
        </Link>
      ) : null}
    </section>
  );
}
