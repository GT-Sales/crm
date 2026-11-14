'use client';

import { useId, useState, type FormEvent } from 'react';
import {
  emailTemplateLabel,
  type AssignableMember,
  type LeadActivity,
  type LeadMailStatus,
} from '@gt-sales/contracts';
import { Badge, Button, Input, Label, Textarea, cn } from '@gt-sales/ui';
import { BotIcon, ChevronDownIcon, MailIcon, PenLineIcon, ReplyIcon } from 'lucide-react';

import { dateTimeLabel, relativeTime } from '../../lib/dates';
import { actorName } from '../../lib/people';

type SystemActivity = Extract<LeadActivity, { kind: 'system' }>;

/** The mails among a lead's timeline entries (sent, and the customer's replies), newest first as the timeline is. */
export function sentMails(activities: readonly LeadActivity[]): SystemActivity[] {
  return activities.filter(
    (entry): entry is SystemActivity =>
      entry.kind === 'system' &&
      (entry.event === 'customer_emailed' || entry.event === 'customer_replied'),
  );
}

export const MAIL_STATUS_BADGE: Record<
  LeadMailStatus,
  { label: string; title: string; className: string }
> = {
  queued: {
    label: 'Sending',
    title: 'Waiting to go out; mails leave within a minute.',
    className: 'text-muted-foreground',
  },
  sent: { label: 'Sent', title: 'Handed to the mail provider.', className: '' },
  delivered: {
    label: 'Delivered',
    title: 'The customer’s mail server accepted it.',
    className: 'border-emerald-600/40 text-emerald-700 dark:text-emerald-400',
  },
  bounced: {
    label: 'Bounced',
    title: 'The address refused it. Check the customer’s email address.',
    className: 'border-destructive/50 text-destructive',
  },
  complained: {
    label: 'Marked as spam',
    title: 'The customer marked it as spam; the site no longer emails this address.',
    className: 'border-destructive/50 text-destructive',
  },
  failed: {
    label: 'Not sent',
    title: 'It did not go out. The owner can retry it in Settings → Background jobs.',
    className: 'border-destructive/50 text-destructive',
  },
  uncertain: {
    label: 'Unconfirmed',
    title:
      'The mail provider did not confirm it. The owner can check it in Settings → Background jobs.',
    className: 'border-amber-600/40 text-amber-700 dark:text-amber-400',
  },
  skipped: {
    label: 'Not sent',
    title: 'Not sent: this address is on the site’s do-not-email list.',
    className: 'border-destructive/50 text-destructive',
  },
};

/** What a mail is called when it kept no subject: the template it came from. */
/** What both mail lists read off a mail: the lead's own tab and the site's Mail page. */
export type MailSummary = Pick<
  SystemActivity,
  'actorId' | 'viaAi' | 'automation' | 'automationName' | 'template' | 'templateName' | 'subject'
>;

export function mailTitle(mail: MailSummary): string {
  if (mail.subject) return mail.subject;
  return mail.template
    ? `${emailTemplateLabel(mail.template, mail.templateName)} email`
    : 'Email to the customer';
}

export function mailSender(mail: MailSummary, members: readonly AssignableMember[]): string {
  if (mail.automation) return `Automation${mail.automationName ? `: ${mail.automationName}` : ''}`;
  const who = actorName(mail.actorId, members);
  return mail.viaAi ? `${who}, with Ask AI` : who;
}

/**
 * A lead's Mail tab: write to the customer, and read every mail the CRM sent
 * them. Replies do not arrive here; they go to the site's reply-to mailbox.
 */
export function LeadMail({
  activities,
  members,
  customerEmail,
  canSend,
  cannotSendReason,
  repliesEnabled = false,
  onSend,
}: {
  activities: readonly LeadActivity[];
  members: readonly AssignableMember[];
  /** The address a new mail goes to; undefined when the lead has none. */
  customerEmail: string | undefined;
  canSend: boolean;
  /** Why this person cannot write from here, said in place of the form. */
  cannotSendReason?: string;
  /** Replies to this site's mail come back to the CRM. */
  repliesEnabled?: boolean;
  /** Queues the mail; resolves once it is on the list, rejects with words to show. */
  onSend: (mail: { subject: string; body: string }) => Promise<void>;
}) {
  const mails = sentMails(activities);
  const formId = useId();
  const [writing, setWriting] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string>();
  const [open, setOpen] = useState<string>();

  async function send(event: FormEvent) {
    event.preventDefault();
    if (sending || !subject.trim() || !body.trim()) return;
    setSending(true);
    setMessage(undefined);
    try {
      await onSend({ subject: subject.trim(), body: body.trim() });
      setSubject('');
      setBody('');
      setWriting(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The email could not be sent.');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <h2 className="mr-auto text-sm font-medium">
          Emails with the customer
          {mails.length > 0 ? (
            <span className="ml-1.5 font-normal text-muted-foreground">{mails.length}</span>
          ) : null}
        </h2>
        {canSend && !writing ? (
          <Button type="button" size="sm" onClick={() => setWriting(true)}>
            <PenLineIcon aria-hidden="true" className="size-3.5" />
            New email
          </Button>
        ) : null}
      </div>

      {!canSend && cannotSendReason ? (
        <p className="text-sm text-muted-foreground">{cannotSendReason}</p>
      ) : null}

      {canSend && writing ? (
        <form
          onSubmit={(event) => void send(event)}
          aria-label="New email"
          className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3"
        >
          <p className="text-xs text-muted-foreground">
            To <span className="font-medium text-foreground">{customerEmail}</span>, from this
            site’s own sender, in the site’s email design.
          </p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${formId}-subject`}>Subject</Label>
            <Input
              id={`${formId}-subject`}
              value={subject}
              maxLength={150}
              required
              autoFocus
              onChange={(event) => setSubject(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${formId}-body`}>Message</Label>
            <Textarea
              id={`${formId}-body`}
              value={body}
              rows={7}
              maxLength={3500}
              required
              onChange={(event) => setBody(event.target.value)}
            />
          </div>
          {message ? (
            <p role="alert" className="text-sm text-destructive">
              {message}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={sending || !subject.trim() || !body.trim()}>
              {sending ? 'Sending…' : 'Send email'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={sending}
              onClick={() => {
                setWriting(false);
                setMessage(undefined);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      {mails.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No emails have been sent to this customer yet.
        </p>
      ) : (
        <ol aria-label="Emails sent" className="flex flex-col divide-y rounded-lg border">
          {mails.map((mail) => {
            const status = mail.mailStatus ? MAIL_STATUS_BADGE[mail.mailStatus] : undefined;
            const isOpen = open === mail.id;
            const hasText = mail.text !== undefined && mail.text.length > 0;
            return (
              <li key={mail.id} className="min-w-0">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => setOpen(isOpen ? undefined : mail.id)}
                  className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left hover:bg-muted/40"
                >
                  <span className="mt-0.5 text-muted-foreground [&_svg]:size-4">
                    {mail.event === 'customer_replied' ? (
                      <ReplyIcon aria-hidden="true" className="text-primary" />
                    ) : mail.automation ? (
                      <BotIcon aria-hidden="true" />
                    ) : (
                      <MailIcon aria-hidden="true" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 truncate text-sm font-medium">
                        {mailTitle(mail)}
                      </span>
                      {status ? (
                        <Badge
                          variant="outline"
                          title={status.title}
                          className={cn('shrink-0 font-normal', status.className)}
                        >
                          {status.label}
                        </Badge>
                      ) : null}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {mail.event === 'customer_replied'
                        ? mail.otherSender
                          ? 'A reply from another address'
                          : 'The customer replied'
                        : mailSender(mail, members)}{' '}
                      ·{' '}
                      <time dateTime={mail.createdAt} title={dateTimeLabel(mail.createdAt)}>
                        {relativeTime(mail.createdAt)}
                      </time>
                    </span>
                  </span>
                  <ChevronDownIcon
                    aria-hidden="true"
                    className={cn(
                      'mt-1 size-4 shrink-0 text-muted-foreground transition-transform',
                      isOpen && 'rotate-180',
                    )}
                  />
                </button>
                {isOpen ? (
                  <div className="border-t bg-muted/20 px-3 py-3 text-sm">
                    {hasText ? (
                      <>
                        <p className="break-words whitespace-pre-wrap">{mail.text}</p>
                        {mail.textCut ? (
                          <p className="mt-2 text-xs text-muted-foreground">
                            This is the start of a long email; the rest was not kept.
                          </p>
                        ) : null}
                      </>
                    ) : (
                      <p className="text-muted-foreground">
                        {mail.subject
                          ? 'This email had no text.'
                          : 'The words of this email were not kept: it was sent before the Mail tab existed, or the customer’s data has been erased.'}
                      </p>
                    )}
                    {status ? (
                      <p className="mt-2 text-xs text-muted-foreground">{status.title}</p>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}

      <p className="text-xs text-muted-foreground">
        {repliesEnabled
          ? 'When the customer replies to one of these emails, the reply appears here.'
          : 'Replies from the customer go to this site’s reply-to mailbox, not here.'}
      </p>
    </div>
  );
}
