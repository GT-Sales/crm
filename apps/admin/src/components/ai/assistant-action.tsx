'use client';

import Link from 'next/link';
import { Button } from '@gt-sales/ui';
import type { AiActionView } from './assistant-provider';
import { safeInternalHref } from './assistant-sources';
import { dateTimeLabel } from '../../lib/dates';

export function AssistantAction({
  action,
  onConfirm,
  onCancel,
}: {
  action: AiActionView;
  onConfirm(): void;
  onCancel(): void;
}) {
  const { proposal, status } = action;
  const draft = proposal.draft;
  const isNote = draft.kind === 'note';
  const href = safeInternalHref(proposal.leadHref);
  const due =
    draft.kind === 'task' && draft.dueDate
      ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(
          new Date(`${draft.dueDate}T12:00:00Z`),
        )
      : 'No due date';
  return (
    <section
      aria-label={isNote ? 'Confirm note' : 'Confirm task'}
      className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-3 text-sm"
    >
      <div>
        <h3 className="font-semibold">{isNote ? 'Add a note' : 'Create a follow-up task'}</h3>
        <p className="mt-1 break-words text-xs text-muted-foreground">
          {proposal.siteName} · {proposal.leadLabel}
        </p>
      </div>
      <p className="whitespace-pre-wrap break-words rounded-lg bg-muted/60 p-2.5">
        {draft.kind === 'note' ? draft.body : draft.title}
      </p>
      {draft.kind === 'task' ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Due</dt>
          <dd>{due}</dd>
          <dt className="text-muted-foreground">Assigned to</dt>
          <dd>{draft.assignee === 'me' ? 'You' : 'Unassigned'}</dd>
        </dl>
      ) : null}
      <p role="status" className="text-xs text-muted-foreground">
        {status === 'saved'
          ? isNote
            ? 'Note added.'
            : 'Task created.'
          : status === 'cancelled'
            ? (action.error ?? 'Cancelled. Nothing was saved.')
            : status === 'saving'
              ? 'Saving…'
              : status === 'error'
                ? action.error
                : `Nothing is saved until you confirm. Expires ${dateTimeLabel(proposal.expiresAt)}.`}
      </p>
      {status === 'pending' || status === 'error' || status === 'saving' ? (
        <div className="flex gap-2">
          <Button type="button" size="sm" disabled={status === 'saving'} onClick={onConfirm}>
            {status === 'error' ? 'Retry save' : 'Confirm'}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={status === 'saving'}
            onClick={onCancel}
          >
            {status === 'error' ? 'Dismiss' : 'Cancel'}
          </Button>
        </div>
      ) : null}
      {href ? (
        <Link href={href} className="text-xs underline underline-offset-2">
          View lead
        </Link>
      ) : null}
    </section>
  );
}
