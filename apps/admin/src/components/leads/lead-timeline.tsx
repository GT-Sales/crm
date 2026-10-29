'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import {
  LEGACY_IMPORT_ACTOR_ID,
  leadStageLabel,
  type AssignableMember,
  type LeadActivity,
  type LeadDetail,
  type PropertyCatalog,
} from '@gt-sales/contracts';
import { Button, Textarea } from '@gt-sales/ui';
import {
  ArrowRightIcon,
  CheckIcon,
  EyeIcon,
  FilePenLineIcon,
  InboxIcon,
  MailIcon,
  PencilIcon,
  RotateCcwIcon,
  StickyNoteIcon,
  Trash2Icon,
  UserIcon,
  XIcon,
} from 'lucide-react';

import { addLeadNote } from '../../lib/api';
import { dateTimeLabel, relativeTime } from '../../lib/dates';
import { actorName, memberName } from '../../lib/people';
import { errorReason } from '../../lib/use-resource';
import { documentLabel } from './lead-documents';
import { fieldLabel } from './lead-fields';

const CONTACT_LABELS: Record<string, string> = { fullName: 'name', email: 'email', phone: 'phone' };

type SystemActivity = Extract<LeadActivity, { kind: 'system' }>;

/** `asked to change the phone, arrival in canada and sent a new passport (request #12)`. */
export function changeRequestText(
  activity: SystemActivity,
  leadType: string,
  catalog?: PropertyCatalog,
): string {
  const fields = (activity.fields ?? []).map(
    (field) => CONTACT_LABELS[field] ?? fieldLabel(leadType, field, catalog),
  );
  const documents = (activity.documents ?? []).map((document) =>
    documentLabel(document).toLowerCase(),
  );
  const parts: string[] = [];
  if (fields.length > 0) parts.push(`asked to change the ${fields.join(', ')}`);
  if (documents.length > 0) {
    parts.push(`${fields.length > 0 ? 'and sent' : 'sent'} a new ${documents.join(' and ')}`);
  }
  const what = parts.length > 0 ? parts.join(' ') : 'asked to change their order';
  return activity.requestNo ? `${what} (request #${activity.requestNo})` : what;
}

/**
 * The newest change request the customer made that the old admin has not
 * decided yet, if any (activities come newest first).
 */
export function pendingChangeRequest(
  activities: readonly LeadActivity[],
): SystemActivity | undefined {
  const decided = new Set(
    activities.flatMap((activity) =>
      activity.kind === 'system' &&
      (activity.event === 'change_approved' || activity.event === 'change_rejected')
        ? [activity.requestNo]
        : [],
    ),
  );
  return activities.find(
    (activity): activity is SystemActivity =>
      activity.kind === 'system' &&
      activity.event === 'change_requested' &&
      activity.requestNo !== undefined &&
      !decided.has(activity.requestNo),
  );
}

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
  catalog: PropertyCatalog | undefined,
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
        text: `corrected the ${activity.fields
          .map((field) => CONTACT_LABELS[field] ?? fieldLabel(leadType, field, catalog))
          .join(', ')}`,
      };
    case 'system':
      if (activity.event === 'trashed')
        return { icon: <Trash2Icon />, text: 'moved this to the trash' };
      if (activity.event === 'restored') return { icon: <RotateCcwIcon />, text: 'restored this' };
      if (activity.event === 'opened') return { icon: <EyeIcon />, text: 'opened this' };
      if (activity.event === 'change_requested') {
        return {
          icon: <FilePenLineIcon />,
          text: changeRequestText(activity, leadType, catalog),
        };
      }
      if (activity.event === 'change_approved' || activity.event === 'change_rejected') {
        const approved = activity.event === 'change_approved';
        return {
          icon: approved ? <CheckIcon /> : <XIcon />,
          text: `${approved ? 'approved' : 'rejected'} the customer’s change request${
            activity.requestNo ? ` #${activity.requestNo}` : ''
          }`,
        };
      }
      if (activity.event === 'customer_emailed') {
        return {
          icon: <MailIcon />,
          text:
            activity.template === 'sim_number_ready'
              ? 'emailed the customer their SIM number'
              : 'emailed the customer',
        };
      }
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
  catalog,
  onNoteAdded,
}: {
  lead: LeadDetail;
  activities: readonly LeadActivity[];
  members: readonly AssignableMember[];
  canWrite: boolean;
  accessToken: string;
  /** The site's catalogue, so a correction names custom properties by label. */
  catalog?: PropertyCatalog;
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
        {/* An open carried over from the old admin tells staff nothing. */}
        {activities
          .filter(
            (activity) =>
              !(
                activity.kind === 'system' &&
                activity.event === 'opened' &&
                activity.actorId === LEGACY_IMPORT_ACTOR_ID
              ),
          )
          .map((activity) => {
            const { icon, text } = describe(activity, lead.leadType, members, catalog);
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
                    <span className="font-medium">
                      {/* The customer asked, through the website; the import only carried it over. */}
                      {activity.kind === 'system' && activity.event === 'change_requested'
                        ? 'Customer'
                        : actorName(activity.actorId, members)}
                    </span>{' '}
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
