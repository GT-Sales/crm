'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { leadTypeLabel, type MailboxItem } from '@gt-sales/contracts';
import { Badge, Button, Card, CardContent, cn } from '@gt-sales/ui';
import { ArrowUpRightIcon, BotIcon, MailIcon, SendIcon } from 'lucide-react';

import { listMailbox } from '../../lib/api';
import { dateTimeLabel, relativeTime } from '../../lib/dates';
import { describeError } from '../../lib/error-text';
import { useResource } from '../../lib/use-resource';
import { LoadingSkeleton } from '../crm/loading-skeleton';
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

/**
 * Mail: the site's sent box. The list on the left, the chosen mail beside it
 * (under it on a narrow screen). Replies are not here: they go to the site's
 * reply-to mailbox.
 */
export function Mailbox({ workspaceSlug }: { workspaceSlug: string }) {
  const { workspaceId, accessToken, members } = useLeadWorkspace(workspaceSlug);
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string>();
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

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 border-b">
        <span className="-mb-px flex items-center gap-2 border-b-2 border-primary px-3 py-2 text-sm font-medium">
          <SendIcon aria-hidden="true" className="size-3.5" />
          Sent
          <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums">{total}</span>
        </span>
        <span className="ml-auto pb-2 text-xs text-muted-foreground">
          Customer replies go to this site’s reply-to mailbox, not here.
        </span>
      </div>

      {box.error ? (
        <p role="alert" className="text-sm text-destructive">
          {describeError(box.failure, 'refresh the mail')}
        </p>
      ) : null}

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

          {open ? (
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
                <div>
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
