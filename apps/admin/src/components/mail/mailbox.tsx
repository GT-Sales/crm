'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { leadTypeLabel, type MailboxItem } from '@gt-sales/contracts';
import { Badge, Button, cn, Input, Label, Textarea } from '@gt-sales/ui';
import {
  ArrowLeftIcon,
  ArrowUpRightIcon,
  BotIcon,
  MailIcon,
  PenLineIcon,
  ReplyIcon,
  SendIcon,
  SparklesIcon,
  XIcon,
} from 'lucide-react';

import { emailLeadCustomer, getStaffLeads, listMailbox } from '../../lib/api';
import { dateTimeLabel, relativeTime } from '../../lib/dates';
import { describeError } from '../../lib/error-text';
import { LEAD_WORK_SAVED } from '../../lib/lead-work-events';
import { initials } from '../../lib/people';
import { errorReason, useResource } from '../../lib/use-resource';
import { useOptionalAssistant } from '../ai/assistant-provider';
import { LoadingSkeleton } from '../crm/loading-skeleton';
import { leadDisplayName } from '../leads/lead-display';
import { MAIL_STATUS_BADGE, mailSender, mailTitle } from '../leads/lead-mail';
import { useLeadWorkspace } from '../leads/use-lead-workspace';

const LEAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEARCH_MIN = 2;
const SEARCH_DELAY_MS = 250;

/** The customer a conversation is with: a lead of this site. */
interface Person {
  leadId: string;
  name: string;
  leadType?: string;
}

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

function Avatar({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary"
    >
      {initials(name) || '?'}
    </span>
  );
}

/** "New email": find the customer to write to among the site's leads. */
function FindCustomer({
  accessToken,
  workspaceId,
  onPick,
  onCancel,
}: {
  accessToken: string;
  workspaceId: string;
  onPick: (person: Person) => void;
  onCancel: () => void;
}) {
  const inputId = useId();
  const [term, setTerm] = useState('');
  const [found, setFound] = useState<(Person & { email?: string })[]>();
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    const text = term.trim();
    if (text.length < SEARCH_MIN) {
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
              leadType: lead.leadType,
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
  }, [term, accessToken, workspaceId]);

  return (
    <div className="flex flex-col gap-2 border-b p-3">
      <div className="flex items-center gap-2">
        <Label htmlFor={inputId} className="mr-auto">
          Write to
        </Label>
        <Button type="button" size="sm" variant="ghost" aria-label="Close" onClick={onCancel}>
          <XIcon aria-hidden="true" className="size-4" />
        </Button>
      </div>
      <Input
        id={inputId}
        value={term}
        autoFocus
        autoComplete="off"
        placeholder="Name, email, phone or order number"
        onChange={(event) => setTerm(event.target.value)}
      />
      {found ? (
        found.length === 0 ? (
          <p className="text-sm text-muted-foreground">No customer matches.</p>
        ) : (
          <ul aria-label="Customers found" className="divide-y rounded-md border">
            {found.map((person) => (
              <li key={person.leadId}>
                <button
                  type="button"
                  onClick={() => onPick(person)}
                  className="flex w-full flex-col px-3 py-2 text-left text-sm hover:bg-muted/40"
                >
                  <span className="font-medium">{person.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {person.email ?? 'No email address'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

/** The writing box under a conversation, with Ask AI to draft the mail. */
function Reply({
  accessToken,
  workspaceId,
  person,
  onSent,
}: {
  accessToken: string;
  workspaceId: string;
  person: Person;
  onSent: () => void;
}) {
  const formId = useId();
  const assistant = useOptionalAssistant();
  const aiReady =
    assistant?.capabilities.status === 'ready' && assistant.capabilities.data.available;
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string>();
  const [asking, setAsking] = useState(false);
  const [brief, setBrief] = useState('');

  async function send(event: FormEvent) {
    event.preventDefault();
    if (sending || !subject.trim() || !body.trim()) return;
    setSending(true);
    setMessage(undefined);
    try {
      await emailLeadCustomer(accessToken, workspaceId, person.leadId, {
        subject: subject.trim(),
        body: body.trim(),
      });
      setSubject('');
      setBody('');
      onSent();
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
    } finally {
      setSending(false);
    }
  }

  function askAi(event: FormEvent) {
    event.preventDefault();
    const wanted = brief.trim();
    if (!assistant || !wanted) return;
    // Ask AI already knows the customer: the page's address names the lead.
    assistant.open();
    assistant.send(`Write an email to this customer (${person.name}). ${wanted}`);
    setBrief('');
    setAsking(false);
  }

  return (
    <div className="border-t bg-background p-3">
      {asking ? (
        <form
          onSubmit={askAi}
          aria-label="Write with AI"
          className="mb-3 flex flex-col gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3"
        >
          <Label htmlFor={`${formId}-brief`}>What should the email say?</Label>
          <Textarea
            id={`${formId}-brief`}
            value={brief}
            rows={2}
            autoFocus
            maxLength={600}
            placeholder="For example: tell them the SIM was mailed today and arrives in 3 to 5 days"
            onChange={(event) => setBrief(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Ask AI writes a draft in its panel. You can edit it there and press Send; nothing goes
            out until you do.
          </p>
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={!brief.trim()}>
              <SparklesIcon aria-hidden="true" className="size-3.5" />
              Write the draft
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAsking(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      <form
        onSubmit={(event) => void send(event)}
        aria-label="New email"
        className="flex flex-col gap-2"
      >
        <Label htmlFor={`${formId}-subject`} className="sr-only">
          Subject
        </Label>
        <Input
          id={`${formId}-subject`}
          value={subject}
          maxLength={150}
          placeholder="Subject"
          onChange={(event) => setSubject(event.target.value)}
        />
        <Label htmlFor={`${formId}-body`} className="sr-only">
          Message
        </Label>
        <Textarea
          id={`${formId}-body`}
          value={body}
          rows={4}
          maxLength={3500}
          placeholder={`Write to ${person.name}…`}
          onChange={(event) => setBody(event.target.value)}
        />
        {message ? (
          <p role="alert" className="text-sm text-destructive">
            {message}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {aiReady && !asking ? (
            <Button type="button" size="sm" variant="outline" onClick={() => setAsking(true)}>
              <SparklesIcon aria-hidden="true" className="size-3.5 text-primary" />
              Write with AI
            </Button>
          ) : null}
          <span className="mr-auto text-xs text-muted-foreground">
            Sent from this site’s own sender, within a minute.
          </span>
          <Button type="submit" size="sm" disabled={sending || !subject.trim() || !body.trim()}>
            <SendIcon aria-hidden="true" className="size-3.5" />
            {sending ? 'Sending…' : 'Send'}
          </Button>
        </div>
      </form>
    </div>
  );
}

/** One customer's mails, oldest at the top like a conversation, the writing box under them. */
function Conversation({
  accessToken,
  workspaceId,
  workspaceSlug,
  person,
  version,
  onSent,
  onBack,
}: {
  accessToken: string;
  workspaceId: string;
  workspaceSlug: string;
  person: Person;
  /** Bumped when a mail to this site was sent elsewhere (Ask AI, the lead page). */
  version: number;
  onSent: () => void;
  onBack: () => void;
}) {
  const { members } = useLeadWorkspace(workspaceSlug);
  const load = useMemo(
    () => () => listMailbox(accessToken, workspaceId, { leadId: person.leadId }),
    // `version` asks again without changing the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accessToken, workspaceId, person.leadId, version],
  );
  const thread = useResource(load);
  const endRef = useRef<HTMLDivElement>(null);
  const mails = useMemo(() => [...(thread.data?.items ?? [])].reverse(), [thread.data]);
  const newest = mails[mails.length - 1]?.id;
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [newest]);
  const leadType = person.leadType ?? mails[0]?.lead.leadType;
  // A conversation opened by its link has no row to read the name from: the mails carry it.
  const name = mails[0]?.lead.name ?? person.name;
  const total = thread.data?.page.total ?? 0;

  // A mail leaves within a minute: look again, so "Sending" does not sit there
  // inviting a second send. A few looks, not a poll.
  const reloadThread = thread.reload;
  const looks = useRef(0);
  const waiting = mails.some((mail) => mail.mailStatus === 'queued');
  useEffect(() => {
    if (!waiting || looks.current >= 3) return;
    const timer = window.setTimeout(() => {
      looks.current += 1;
      void reloadThread();
    }, 75_000);
    return () => window.clearTimeout(timer);
  }, [waiting, reloadThread, thread.data]);

  return (
    <section aria-label={`Emails to ${name}`} className="flex min-h-0 min-w-0 flex-col">
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label="Back to the list"
          className="lg:hidden"
          onClick={onBack}
        >
          <ArrowLeftIcon aria-hidden="true" className="size-4" />
        </Button>
        <Avatar name={name} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold">{name}</h2>
          {leadType ? (
            <p className="text-xs text-muted-foreground">{leadTypeLabel(leadType)}</p>
          ) : null}
        </div>
        <Button asChild size="sm" variant="outline">
          <Link href={`/w/${workspaceSlug}/leads/${person.leadId}`}>
            Open lead
            <ArrowUpRightIcon aria-hidden="true" className="size-3.5" />
          </Link>
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-muted/20 p-4">
        {thread.error && !thread.data ? (
          <p role="alert" className="text-sm text-destructive">
            {describeError(thread.failure, 'load the emails')}
          </p>
        ) : !thread.data ? (
          <LoadingSkeleton label="Loading emails…" variant="list" rows={2} />
        ) : mails.length === 0 ? (
          <p className="m-auto text-sm text-muted-foreground">
            No emails to {name} yet. Write the first one below.
          </p>
        ) : (
          <ol aria-label="Emails" className="flex flex-col gap-3">
            {total > mails.length ? (
              <li className="text-center text-xs text-muted-foreground">
                These are the newest {mails.length} of {total} emails. Open the lead to read the
                older ones.
              </li>
            ) : null}
            {mails.map((mail) => (
              <li
                key={mail.id}
                data-direction={mail.direction}
                className={cn(
                  'rounded-xl border bg-card p-4 text-sm',
                  // The customer's own words stand apart from the site's.
                  mail.direction === 'in' && 'border-primary/40 bg-primary/5',
                )}
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium break-words">{mailTitle(mail)}</p>
                    <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                      {mail.direction === 'in' ? (
                        <ReplyIcon aria-hidden="true" className="size-3.5 text-primary" />
                      ) : mail.automation ? (
                        <BotIcon aria-hidden="true" className="size-3.5" />
                      ) : null}
                      {mail.direction === 'in'
                        ? `${name} replied${mail.otherSender ? ' from another address' : ''}`
                        : mailSender(mail, members)}{' '}
                      · <time dateTime={mail.createdAt}>{dateTimeLabel(mail.createdAt)}</time>
                    </p>
                  </div>
                  <StatusBadge item={mail} />
                </div>
                {mail.text ? (
                  <p className="mt-3 break-words whitespace-pre-wrap">{mail.text}</p>
                ) : (
                  <p className="mt-3 text-muted-foreground">
                    The words of this email were not kept: it was sent before the CRM saved email
                    text, or the customer’s data has been erased.
                  </p>
                )}
                {mail.textCut ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    This is the start of a long email; the rest was not kept.
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
        <div ref={endRef} />
      </div>

      <Reply
        // A different customer is a fresh, empty box.
        key={person.leadId}
        accessToken={accessToken}
        workspaceId={workspaceId}
        person={{ ...person, name }}
        onSent={onSent}
      />
    </section>
  );
}

/**
 * Mail: the site's sent mail as conversations. The customers written to on the
 * left (their latest mail each); the chosen customer's mails on the right, with
 * a writing box under them, the customer's replies among them when the site
 * receives them (else they go to its reply-to mailbox). The chosen customer is `?lead=` in the address, which is
 * also how Ask AI knows whom a draft is for.
 */
export function Mailbox({ workspaceSlug }: { workspaceSlug: string }) {
  const { workspaceId, accessToken } = useLeadWorkspace(workspaceSlug);
  const router = useRouter();
  const pathname = usePathname();
  const queried = useSearchParams().get('lead');
  const leadId = queried !== null && LEAD_ID.test(queried) ? queried : undefined;
  const [page, setPage] = useState(1);
  const [finding, setFinding] = useState(false);
  /** A customer picked by search, who may have no mail yet and so no row in the list. */
  const [picked, setPicked] = useState<Person>();
  const [version, setVersion] = useState(0);
  const load = useMemo(
    () =>
      accessToken && workspaceId
        ? () => listMailbox(accessToken, workspaceId, { page })
        : undefined,
    [accessToken, workspaceId, page],
  );
  const people = useResource(load);
  const reloadPeople = people.reload;

  // A mail sent from Ask AI or a lead panel shows here without a refresh.
  useEffect(() => {
    const saved = () => {
      setVersion((current) => current + 1);
      void reloadPeople();
    };
    window.addEventListener(LEAD_WORK_SAVED, saved);
    return () => window.removeEventListener(LEAD_WORK_SAVED, saved);
  }, [reloadPeople]);

  // The list got shorter (leads archived) while a later page was open: go back to the first.
  const emptyPage = people.data !== undefined && people.data.items.length === 0 && page > 1;
  useEffect(() => {
    if (emptyPage) setPage(1);
  }, [emptyPage]);

  if (!accessToken || !workspaceId) return null;
  if (people.error && !people.data) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {people.error === 'permission_denied'
          ? "Your role doesn't show customer emails. Ask the owner if you need to read them."
          : describeError(people.failure, 'load the mail')}
      </p>
    );
  }
  if (!people.data) return <LoadingSkeleton label="Loading mail…" variant="list" rows={6} />;

  const { items } = people.data;
  const pages = Math.max(1, Math.ceil(people.data.page.total / people.data.page.pageSize));
  const choose = (next: string | undefined) =>
    router.replace(next ? `${pathname}?lead=${next}` : pathname, { scroll: false });
  const row = items.find((item) => item.lead.id === leadId);
  const person: Person | undefined =
    leadId === undefined
      ? undefined
      : row
        ? {
            leadId,
            name: row.lead.name ?? 'Unnamed customer',
            leadType: row.lead.leadType,
          }
        : picked?.leadId === leadId
          ? picked
          : { leadId, name: 'Customer' };

  return (
    <div className="grid h-[calc(100dvh-13rem)] min-h-[28rem] overflow-hidden rounded-2xl border bg-card lg:grid-cols-[20rem_minmax(0,1fr)]">
      <aside
        aria-label="Customers"
        className={cn('flex min-h-0 flex-col lg:border-r', person && 'hidden lg:flex')}
      >
        <div className="flex items-center gap-2 border-b px-3 py-2.5">
          <span className="mr-auto text-sm font-medium">
            Sent
            <span className="ml-1.5 font-normal text-muted-foreground">
              {people.data.page.total}
            </span>
          </span>
          <Button type="button" size="sm" onClick={() => setFinding(true)}>
            <PenLineIcon aria-hidden="true" className="size-3.5" />
            New email
          </Button>
        </div>
        {finding ? (
          <FindCustomer
            accessToken={accessToken}
            workspaceId={workspaceId}
            onCancel={() => setFinding(false)}
            onPick={(found) => {
              setPicked(found);
              setFinding(false);
              choose(found.leadId);
            }}
          />
        ) : null}
        {people.error ? (
          <p role="alert" className="px-3 py-2 text-sm text-destructive">
            {describeError(people.failure, 'refresh the mail')}
          </p>
        ) : null}
        {items.length === 0 ? (
          <div className="m-auto flex flex-col items-center gap-2 p-6 text-center">
            <MailIcon className="size-6 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">
              No emails have been sent to customers yet.
            </p>
          </div>
        ) : (
          <ul aria-label="Customers written to" className="min-h-0 flex-1 divide-y overflow-y-auto">
            {items.map((item) => {
              const name = item.lead.name ?? 'Unnamed customer';
              const active = item.lead.id === leadId;
              return (
                <li key={item.lead.id}>
                  <button
                    type="button"
                    aria-current={active ? 'true' : undefined}
                    onClick={() => choose(item.lead.id)}
                    className={cn(
                      'flex w-full items-start gap-3 px-3 py-3 text-left hover:bg-muted/40',
                      active && 'bg-primary/5',
                    )}
                  >
                    <Avatar name={name} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
                        <time
                          dateTime={item.createdAt}
                          title={dateTimeLabel(item.createdAt)}
                          className="shrink-0 text-xs text-muted-foreground"
                        >
                          {relativeTime(item.createdAt)}
                        </time>
                      </span>
                      <span className="flex items-center gap-2">
                        {item.direction === 'in' ? (
                          <ReplyIcon
                            aria-label="Replied"
                            className="size-3.5 shrink-0 text-primary"
                          />
                        ) : null}
                        <span
                          className={cn(
                            'min-w-0 flex-1 truncate text-sm',
                            // The customer had the last word: it is waiting to be read.
                            item.direction === 'in' && 'font-semibold',
                          )}
                        >
                          {mailTitle(item)}
                        </span>
                        {(item.mails ?? 1) > 1 ? (
                          <span
                            title={`${item.mails} emails`}
                            className="shrink-0 rounded-full bg-muted px-1.5 text-xs text-muted-foreground tabular-nums"
                          >
                            {item.mails}
                          </span>
                        ) : null}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {snippet(item.text) || MAIL_STATUS_BADGE[item.mailStatus ?? 'sent'].label}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {pages > 1 ? (
          <div className="flex items-center gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              Previous
            </Button>
            <span className="mx-auto">
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
      </aside>

      {person ? (
        <Conversation
          // Another customer starts from an empty conversation, not the last one's mails.
          key={person.leadId}
          accessToken={accessToken}
          workspaceId={workspaceId}
          workspaceSlug={workspaceSlug}
          person={person}
          version={version}
          onBack={() => choose(undefined)}
          onSent={() => {
            setVersion((current) => current + 1);
            setPage(1);
            void reloadPeople();
          }}
        />
      ) : (
        <div className="hidden flex-col items-center justify-center gap-2 p-6 text-center lg:flex">
          <MailIcon className="size-7 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">
            Choose a customer to read the emails sent to them, or press New email.
          </p>
          <p className="text-xs text-muted-foreground">
            {people.data.repliesEnabled
              ? 'When a customer replies to one of these emails, the reply appears in their conversation.'
              : 'Customer replies go to this site’s reply-to mailbox, not here.'}
          </p>
        </div>
      )}
    </div>
  );
}
