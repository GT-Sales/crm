'use client';

import Link from 'next/link';
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { leadTypeLabel, type MailboxItem } from '@gt-sales/contracts';
import { Badge, Button, Card, CardContent, cn, Input, Label, Textarea } from '@gt-sales/ui';
import { ArrowUpRightIcon, BotIcon, MailIcon, PenLineIcon, SendIcon, XIcon } from 'lucide-react';

import { emailLeadCustomer, getStaffLeads, listMailbox } from '../../lib/api';
import { dateTimeLabel, relativeTime } from '../../lib/dates';
import { describeError } from '../../lib/error-text';
import { errorReason, useResource } from '../../lib/use-resource';
import { LoadingSkeleton } from '../crm/loading-skeleton';
import { leadDisplayName } from '../leads/lead-display';
import { MAIL_STATUS_BADGE, mailSender, mailTitle } from '../leads/lead-mail';
import { useLeadWorkspace } from '../leads/use-lead-workspace';

/** The start of a mail's text on one line, for the list. */
function snippet(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
}

function StatusBadge({ item }: { item: MailboxItem }) {
  const status = item.mailStatus ? MAIL_STATUS_BADGE[item.mailStatus] : undefined;
  if (!status) return null;
  return (
    <Badge
      variant="outline"
      title={status.title}
      className={cn('shrink-0 font-normal', status.className)}
    >
      {status.label}
    </Badge>
  );
}

/** The customer a new mail is for: a lead of this site. */
interface Recipient {
  leadId: string;
  name: string;
  /** Known when picked from the search; a mail goes to the lead's own address either way. */
  email?: string;
}

const SEARCH_MIN = 2;
const SEARCH_DELAY_MS = 250;

/**
 * Write to a customer from the Mail page: pick the lead, then the same subject
 * and message the lead's own Mail tab takes. It is sent to the lead's address.
 */
function Compose({
  accessToken,
  workspaceId,
  initial,
  onSent,
  onCancel,
}: {
  accessToken: string;
  workspaceId: string;
  initial?: Recipient;
  onSent: (mailId: string) => void;
  onCancel: () => void;
}) {
  const formId = useId();
  const [to, setTo] = useState<Recipient | undefined>(initial);
  const [term, setTerm] = useState('');
  const [found, setFound] = useState<Recipient[]>();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string>();
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    const text = term.trim();
    if (to || text.length < SEARCH_MIN) {
      setFound(undefined);
      return;
    }
    const timer = setTimeout(() => {
      getStaffLeads(accessToken, workspaceId, {
        q: text.slice(0, 100),
        view: 'active',
        pageSize: 6,
      }).then(
        (page) => {
          if (generation.current !== current) return;
          setFound(
            page.leads.map((lead) => ({
              leadId: lead.id,
              name: leadDisplayName(lead.contact),
              ...(lead.contact.email ? { email: lead.contact.email } : {}),
            })),
          );
        },
        () => {
          if (generation.current === current) setFound([]);
        },
      );
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [term, to, accessToken, workspaceId]);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (sending || !to || !subject.trim() || !body.trim()) return;
    setSending(true);
    setMessage(undefined);
    try {
      const result = await emailLeadCustomer(accessToken, workspaceId, to.leadId, {
        subject: subject.trim(),
        body: body.trim(),
      });
      onSent(result.activity.id);
    } catch (error) {
      const reason = errorReason(error);
      setMessage(
        reason === 'conflict'
          ? 'This customer has no usable email address. Add one on the lead first.'
          : reason === 'feature_not_ready'
            ? 'Emailing customers is not set up for this site yet. Ask the owner to set up Settings → Email.'
            : reason === 'permission_denied'
              ? "Your role can't email customers. It needs the Leads role."
              : reason === 'lead_trashed'
                ? 'This lead is archived. Restore it to email the customer.'
                : describeError(error, 'send the email'),
      );
      setSending(false);
    }
  }

  return (
    <Card aria-label="New email">
      <CardContent>
        <form onSubmit={(event) => void send(event)} className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <h2 className="mr-auto text-base font-semibold">New email</h2>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label="Close"
              disabled={sending}
              onClick={onCancel}
            >
              <XIcon aria-hidden="true" className="size-4" />
            </Button>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${formId}-to`}>To</Label>
            {to ? (
              <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{to.name}</span>
                  {to.email ? <span className="text-muted-foreground"> · {to.email}</span> : null}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={sending}
                  onClick={() => {
                    setTo(undefined);
                    setTerm('');
                  }}
                >
                  Change
                </Button>
              </div>
            ) : (
              <>
                <Input
                  id={`${formId}-to`}
                  value={term}
                  autoFocus
                  autoComplete="off"
                  placeholder="Search a customer by name, email, phone or order number"
                  onChange={(event) => setTerm(event.target.value)}
                />
                {found ? (
                  found.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No customer matches.</p>
                  ) : (
                    <ul aria-label="Customers found" className="divide-y rounded-md border">
                      {found.map((lead) => (
                        <li key={lead.leadId}>
                          <button
                            type="button"
                            onClick={() => setTo(lead)}
                            className="flex w-full flex-col px-3 py-2 text-left text-sm hover:bg-muted/40"
                          >
                            <span className="font-medium">{lead.name}</span>
                            <span className="text-xs text-muted-foreground">
                              {lead.email ?? 'No email address'}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )
                ) : null}
              </>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${formId}-subject`}>Subject</Label>
            <Input
              id={`${formId}-subject`}
              value={subject}
              maxLength={150}
              required
              onChange={(event) => setSubject(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${formId}-body`}>Message</Label>
            <Textarea
              id={`${formId}-body`}
              value={body}
              rows={9}
              maxLength={3500}
              required
              onChange={(event) => setBody(event.target.value)}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Sent from this site’s own sender, in the site’s email design, within a minute.
          </p>
          {message ? (
            <p role="alert" className="text-sm text-destructive">
              {message}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={sending || !to || !subject.trim() || !body.trim()}
            >
              {sending ? 'Sending…' : 'Send email'}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={sending} onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * Mail: the site's sent box. The list on the left, the chosen mail beside it
 * (under it on a narrow screen). Replies are not here: they go to the site's
 * reply-to mailbox.
 */
export function Mailbox({ workspaceSlug }: { workspaceSlug: string }) {
  const { workspaceId, accessToken, members } = useLeadWorkspace(workspaceSlug);
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string>();
  /** The new-email form: open with no customer chosen, or for one. */
  const [writing, setWriting] = useState<{ to?: Recipient }>();
  const load = useMemo(
    () =>
      accessToken && workspaceId
        ? () => listMailbox(accessToken, workspaceId, { page })
        : undefined,
    [accessToken, workspaceId, page],
  );
  const box = useResource(load);

  if (!accessToken || !workspaceId) return null;
  if (box.error && !box.data) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {box.error === 'permission_denied'
          ? "Your role doesn't show customer emails. Ask the owner if you need to read them."
          : describeError(box.failure, 'load the mail')}
      </p>
    );
  }
  if (!box.data) return <LoadingSkeleton label="Loading mail…" variant="list" rows={6} />;

  const { items } = box.data;
  const total = box.data.page.total;
  const pages = Math.max(1, Math.ceil(total / box.data.page.pageSize));
  const open = items.find((item) => item.id === openId) ?? items[0];

  const composeForm = writing ? (
    <Compose
      // A different customer is a fresh form.
      key={writing.to?.leadId ?? 'new'}
      accessToken={accessToken}
      workspaceId={workspaceId}
      {...(writing.to ? { initial: writing.to } : {})}
      onCancel={() => setWriting(undefined)}
      onSent={(mailId) => {
        setWriting(undefined);
        setOpenId(mailId);
        setPage(1);
        box.reload();
      }}
    />
  ) : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 border-b">
        <span className="-mb-px flex items-center gap-2 border-b-2 border-primary px-3 py-2 text-sm font-medium">
          <SendIcon aria-hidden="true" className="size-3.5" />
          Sent
          <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums">{total}</span>
        </span>
        <span className="ml-auto hidden pb-2 text-xs text-muted-foreground md:inline">
          Customer replies go to this site’s reply-to mailbox, not here.
        </span>
        <Button type="button" size="sm" className="mb-2" onClick={() => setWriting({})}>
          <PenLineIcon aria-hidden="true" className="size-3.5" />
          New email
        </Button>
      </div>

      {box.error ? (
        <p role="alert" className="text-sm text-destructive">
          {describeError(box.failure, 'refresh the mail')}
        </p>
      ) : null}

      {items.length === 0 && writing ? composeForm : null}
      {items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <MailIcon className="size-6 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">
              No emails have been sent to customers yet.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <Card className="py-0">
            <CardContent className="p-0">
              <ul aria-label="Sent emails" className="divide-y">
                {items.map((item) => {
                  const active = item.id === open?.id;
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        aria-current={active ? 'true' : undefined}
                        onClick={() => setOpenId(item.id)}
                        className={cn(
                          'flex w-full flex-col gap-0.5 px-4 py-3 text-left hover:bg-muted/40',
                          active && 'bg-primary/5',
                        )}
                      >
                        <span className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">
                            {item.lead.name ?? 'Unnamed customer'}
                          </span>
                          <time
                            dateTime={item.createdAt}
                            title={dateTimeLabel(item.createdAt)}
                            className="shrink-0 text-xs text-muted-foreground"
                          >
                            {relativeTime(item.createdAt)}
                          </time>
                        </span>
                        <span className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-sm">{mailTitle(item)}</span>
                          <StatusBadge item={item} />
                        </span>
                        {snippet(item.text) ? (
                          <span className="truncate text-xs text-muted-foreground">
                            {snippet(item.text)}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>

          {writing ? (
            composeForm
          ) : open ? (
            <Card aria-label="Email" className="lg:sticky lg:top-20">
              <CardContent className="flex flex-col gap-4">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <h2 className="text-base font-semibold break-words">{mailTitle(open)}</h2>
                    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                      <span>
                        To{' '}
                        <span className="font-medium text-foreground">
                          {open.lead.name ?? 'Unnamed customer'}
                        </span>
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{leadTypeLabel(open.lead.leadType)}</span>
                    </p>
                    <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                      {open.automation ? <BotIcon aria-hidden="true" className="size-3.5" /> : null}
                      {mailSender(open, members)} · {dateTimeLabel(open.createdAt)}
                    </p>
                  </div>
                  <StatusBadge item={open} />
                </div>
                <div className="border-t pt-4 text-sm">
                  {open.text ? (
                    <>
                      <p className="break-words whitespace-pre-wrap">{open.text}</p>
                      {open.textCut ? (
                        <p className="mt-2 text-xs text-muted-foreground">
                          This is the start of a long email; the rest was not kept.
                        </p>
                      ) : null}
                    </>
                  ) : (
                    <p className="text-muted-foreground">
                      The words of this email were not kept: it was sent before the CRM saved email
                      text, or the customer’s data has been erased.
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    onClick={() =>
                      setWriting({
                        to: {
                          leadId: open.lead.id,
                          name: open.lead.name ?? 'Unnamed customer',
                        },
                      })
                    }
                  >
                    <PenLineIcon aria-hidden="true" className="size-3.5" />
                    Write to this customer
                  </Button>
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/w/${workspaceSlug}/leads/${open.lead.id}`}>
                      Open lead
                      <ArrowUpRightIcon aria-hidden="true" className="size-3.5" />
                    </Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : null}
        </div>
      )}

      {pages > 1 ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          >
            Previous
          </Button>
          <span>
            Page {page} of {pages}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={page >= pages}
            onClick={() => setPage(page + 1)}
          >
            Next
          </Button>
        </div>
      ) : null}
    </div>
  );
}
