'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import {
  leadStageLabel,
  leadTypeLabel,
  type DocumentReviewQueueItem,
  type DocumentReviewQueueStatus,
} from '@gt-sales/contracts';
import { Badge, Button, Card, CardContent, cn } from '@gt-sales/ui';
import { FileCheck2Icon } from 'lucide-react';

import { listDocumentReviewQueue } from '../../lib/api';
import { describeError } from '../../lib/error-text';
import { useResource } from '../../lib/use-resource';
import { LoadingSkeleton } from '../crm/loading-skeleton';
import { DocumentRow } from '../leads/lead-documents';
import { useStaffSession } from '../staff-session-provider';

const TABS: { status: DocumentReviewQueueStatus; label: string; empty: string }[] = [
  {
    status: 'to_review',
    label: 'To review',
    empty: 'Nothing to review. New uploads show up here as customers send them.',
  },
  {
    status: 'rejected',
    label: 'Rejected',
    empty: 'No rejected documents waiting on a customer.',
  },
];

/**
 * Documents → the site's review queue: the current customer files on active
 * leads that no one has reviewed yet, and those rejected and waiting for a new
 * upload. Files a lead's plan requires come first, since an order cannot move
 * on without them. Each row reviews in place; the lead opens beside it.
 */
export function DocumentReviewQueue({ workspaceSlug }: { workspaceSlug: string }) {
  const { accessToken, workspaces } = useStaffSession();
  const workspaceId = workspaces.find((entry) => entry.slug === workspaceSlug)?.id;
  const [status, setStatus] = useState<DocumentReviewQueueStatus>('to_review');
  const [page, setPage] = useState(1);
  const load = useMemo(
    () =>
      accessToken && workspaceId
        ? () => listDocumentReviewQueue(accessToken, workspaceId, { status, page })
        : undefined,
    [accessToken, workspaceId, status, page],
  );
  const queue = useResource(load);

  if (!accessToken || !workspaceId) return null;
  if (queue.error && !queue.data) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {queue.error === 'permission_denied'
          ? "Your role doesn't show customer documents. Ask the owner if you need to review them."
          : describeError(queue.failure, 'load the documents')}
      </p>
    );
  }
  if (!queue.data) return <LoadingSkeleton label="Loading documents…" variant="list" />;

  const { items, counts, access } = queue.data;
  const tab = TABS.find((entry) => entry.status === status) ?? TABS[0];
  const pages = Math.max(1, Math.ceil(queue.data.page.total / queue.data.page.pageSize));

  return (
    <div className="flex flex-col gap-4">
      <div role="tablist" aria-label="Document states" className="flex gap-1 border-b">
        {TABS.map((entry) => {
          const count = entry.status === 'to_review' ? counts.toReview : counts.rejected;
          const active = entry.status === status;
          return (
            <button
              key={entry.status}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => {
                setStatus(entry.status);
                setPage(1);
              }}
              className={cn(
                '-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm transition-colors',
                active
                  ? 'border-primary font-medium text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {entry.label}
              <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums">{count}</span>
            </button>
          );
        })}
      </div>

      {queue.error ? (
        <p role="alert" className="text-sm text-destructive">
          {describeError(queue.failure, 'refresh the documents')}
        </p>
      ) : null}

      {items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <FileCheck2Icon className="size-6 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">{tab?.empty}</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul aria-label={`${tab?.label ?? 'Documents'} documents`} className="divide-y">
              {items.map((item) => (
                <QueueRow
                  key={item.document.id}
                  item={item}
                  workspaceSlug={workspaceSlug}
                  workspaceId={workspaceId}
                  accessToken={accessToken}
                  canReview={access.review}
                  canDownload={access.download}
                  onReviewed={queue.reload}
                />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {!access.review || !access.download ? (
        <p className="text-xs text-muted-foreground">
          {!access.review ? 'Approving and rejecting needs the Orders role. ' : ''}
          {!access.download
            ? 'Opening documents needs the document download permission, which an owner can grant.'
            : ''}
        </p>
      ) : null}

      {pages > 1 ? (
        <nav aria-label="Pages" className="flex items-center gap-2 text-sm">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((value) => value - 1)}
          >
            Previous
          </Button>
          <span className="text-muted-foreground">
            Page {page} of {pages}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page >= pages}
            onClick={() => setPage((value) => value + 1)}
          >
            Next
          </Button>
        </nav>
      ) : null}
    </div>
  );
}

function QueueRow({
  item,
  workspaceSlug,
  workspaceId,
  accessToken,
  canReview,
  canDownload,
  onReviewed,
}: {
  item: DocumentReviewQueueItem;
  workspaceSlug: string;
  workspaceId: string;
  accessToken: string;
  canReview: boolean;
  canDownload: boolean;
  onReviewed(): Promise<void>;
}) {
  const name = item.lead.name ?? item.lead.externalRef ?? 'Unnamed lead';
  return (
    <li className="flex flex-col gap-1 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Link
          href={`/w/${workspaceSlug}/leads/${item.lead.id}`}
          className="font-medium text-foreground hover:underline"
        >
          {name}
        </Link>
        <span className="text-xs text-muted-foreground">
          {[
            item.lead.externalRef,
            leadTypeLabel(item.lead.leadType),
            leadStageLabel(item.lead.leadType, item.lead.stage),
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        {item.required ? (
          <Badge
            variant="outline"
            className="border-amber-500/40 bg-amber-500/10 font-normal text-amber-900 dark:text-amber-100"
          >
            Required by plan
          </Badge>
        ) : null}
      </div>
      <ul className="contents">
        <DocumentRow
          accessToken={accessToken}
          workspaceId={workspaceId}
          document={item.document}
          canDownload={canDownload}
          canReview={canReview}
          subject={name}
          onReviewed={onReviewed}
        />
      </ul>
    </li>
  );
}
