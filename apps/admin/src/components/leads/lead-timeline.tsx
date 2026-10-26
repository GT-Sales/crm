'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import {
  leadStageLabel,
  type AssignableMember,
  type LeadActivity,
  type LeadDetail,
} from '@gt-sales/contracts';
import { Button, Textarea } from '@gt-sales/ui';
import {
  ArrowRightIcon,
  InboxIcon,
  PencilIcon,
  RotateCcwIcon,
  StickyNoteIcon,
  Trash2Icon,
  UserIcon,
} from 'lucide-react';

import { addLeadNote } from '../../lib/api';
import { dateTimeLabel, relativeTime } from '../../lib/dates';
import { actorName, memberName } from '../../lib/people';
import { errorReason } from '../../lib/use-resource';

const FIELD_LABELS = { fullName: 'name', email: 'email', phone: 'phone' } as const;

function personName(actorId: string | null, members: readonly AssignableMember[]): string {
  if (actorId === null) return 'nobody';
  const member = members.find((entry) => entry.actorId === actorId);
  if (!member) return 'a former teammate';
  return member.isSelf ? 'you' : memberName(member);
}

function describe(
  activity: LeadActivity,
  leadType: string,
  members: readonly AssignableMember[],
): { icon: ReactNode; text: ReactNode } {
  switch (activity.kind) {
    case 'note':
      return { icon: <StickyNoteIcon />, text: 'added a note' };
    case 'status_change':
      return {
        icon: <ArrowRightIcon />,
        text: (
          <>
            moved this from <strong>{leadStageLabel(leadType, activity.from)}</strong> to{' '}
            <strong>{leadStageLabel(leadType, activity.to)}</strong>
          </>
        ),
      };
    case 'assignment':
      if (activity.to === null) {
        return { icon: <UserIcon />, text: <>unassigned {personName(activity.from, members)}</> };
      }
      if (activity.to === activity.actorId) return { icon: <UserIcon />, text: 'took this lead' };
      return {
        icon: <UserIcon />,
        text: (
          <>
            assigned this to <strong>{personName(activity.to, members)}</strong>
          </>
        ),
      };
    case 'edit':
      return {
        icon: <PencilIcon />,
        text: `corrected the ${activity.fields.map((field) => FIELD_LABELS[field]).join(', ')}`,
      };
    case 'system':
      if (activity.event === 'trashed')
        return { icon: <Trash2Icon />, text: 'moved this to the trash' };
      if (activity.event === 'restored') return { icon: <RotateCcwIcon />, text: 'restored this' };
      return { icon: <InboxIcon />, text: 'recorded a change' };
  }
}

/**
 * The lead's history, newest first: notes, stage changes, assignments,
 * corrections and the trash, ending with the submission itself. Staff who
 * manage leads write notes at the top.
 */
export function LeadTimeline({
  lead,
  activities,
  members,
  canWrite,
  accessToken,
  onNoteAdded,
}: {
  lead: LeadDetail;
  activities: readonly LeadActivity[];
  members: readonly AssignableMember[];
  canWrite: boolean;
  accessToken: string;
  onNoteAdded(activity: LeadActivity): void;
}) {
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const body = draft.trim();
    if (!body || saving) return;
    setSaving(true);
    setMessage(undefined);
    try {
      const result = await addLeadNote(accessToken, lead.workspaceId, lead.id, body);
      onNoteAdded(result.activity);
      setDraft('');
    } catch (error) {
      setMessage(`The note was not saved. Reason: ${errorReason(error)}.`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="timeline-heading" className="flex flex-col gap-4">
      <h2 id="timeline-heading" className="text-base font-semibold">
        Timeline
      </h2>
      {canWrite ? (
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-2">
          <label htmlFor="lead-note" className="sr-only">
            Add a note
          </label>
          <Textarea
            id="lead-note"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit();
            }}
            placeholder="Add a note: what was said, what happens next…"
            maxLength={4000}
            rows={3}
          />
          <div className="flex items-center gap-3">
            <Button type="submit" size="sm" disabled={saving || draft.trim() === ''}>
              {saving ? 'Saving…' : 'Add note'}
            </Button>
            <span className="text-xs text-muted-foreground">Ctrl or ⌘ + Enter</span>
            {message ? (
              <span role="alert" className="text-sm text-rose-300">
                {message}
              </span>
            ) : null}
          </div>
        </form>
      ) : null}

      <ol className="flex flex-col">
        {activities.map((activity) => {
          const { icon, text } = describe(activity, lead.leadType, members);
          return (
            <li key={activity.id} className="relative flex gap-3 pb-5 last:pb-0">
              <span
                aria-hidden="true"
                className="flex size-7 shrink-0 items-center justify-center rounded-full border bg-muted text-muted-foreground [&_svg]:size-3.5"
              >
                {icon}
              </span>
              <div className="min-w-0 flex-1 pt-1 text-sm">
                <p>
                  <span className="font-medium">{actorName(activity.actorId, members)}</span>{' '}
                  <span className="text-muted-foreground">{text}</span>{' '}
                  <time
                    dateTime={activity.createdAt}
                    title={dateTimeLabel(activity.createdAt)}
                    className="text-xs text-muted-foreground"
                  >
                    · {relativeTime(activity.createdAt)}
                  </time>
                </p>
                {activity.kind === 'note' ? (
                  <p className="mt-2 rounded-md border bg-card px-3 py-2 whitespace-pre-wrap">
                    {activity.body}
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
        <li className="flex gap-3">
          <span
            aria-hidden="true"
            className="flex size-7 shrink-0 items-center justify-center rounded-full border bg-muted text-muted-foreground [&_svg]:size-3.5"
          >
            <InboxIcon />
          </span>
          <p className="pt-1 text-sm">
            <span className="font-medium">Website</span>{' '}
            <span className="text-muted-foreground">
              sent this {lead.status === 'submitted' ? 'lead' : 'draft'}
            </span>{' '}
            <time
              dateTime={lead.createdAt}
              title={dateTimeLabel(lead.createdAt)}
              className="text-xs text-muted-foreground"
            >
              · {relativeTime(lead.createdAt)}
            </time>
          </p>
        </li>
      </ol>
    </section>
  );
}
