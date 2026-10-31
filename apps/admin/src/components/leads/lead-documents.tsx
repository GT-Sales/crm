'use client';

import { useState } from 'react';
import type { FileReviewDecision, LeadDocument } from '@gt-sales/contracts';
import { Badge, Button, Card, CardContent, cn } from '@gt-sales/ui';

import { createFileDownloadLink, reviewFile } from '../../lib/api';
import { dateTimeLabel, relativeTime } from '../../lib/dates';
import { downloadNavigation } from '../../lib/file-links';
import { errorReason } from '../../lib/use-resource';

/** Names for each document type, in the order the card lists them. */
const DOCUMENT_LABELS: Readonly<Record<string, string>> = {
  passport: 'Passport',
  visa: 'Visa or approval letter',
  study_permit: 'Study permit',
  work_permit: 'Work permit',
  drivers_licence: "Driver's licence",
  provincial_id: 'Provincial ID',
  sim_photo: 'SIM card photo',
  billing_contract: 'Billing contract',
  business_licence: 'Business licence',
};

const TYPE_ORDER = Object.keys(DOCUMENT_LABELS);

const FORMAT_LABELS: Readonly<Record<LeadDocument['contentType'], string>> = {
  'application/pdf': 'PDF',
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
};

/** `business_licence` → `Business licence`, for a type this version has no name for. */
export function documentLabel(documentType: string): string {
  const known = DOCUMENT_LABELS[documentType];
  if (known) return known;
  const words = documentType.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `820 KB`, `1.2 MB`. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function rank(documentType: string): number {
  const index = TYPE_ORDER.indexOf(documentType);
  return index === -1 ? TYPE_ORDER.length : index;
}

/** The latest review of a document, as its badge reads. */
function reviewBadge(review: LeadDocument['review']): { label: string; className: string } {
  if (review?.decision === 'approved') {
    return {
      label: 'Approved',
      className: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300',
    };
  }
  if (review?.decision === 'rejected') {
    return { label: 'Rejected', className: 'border-rose-500/40 text-rose-700 dark:text-rose-300' };
  }
  return { label: 'Not reviewed', className: 'text-muted-foreground' };
}

export function linkFailure(code: string): string {
  if (code === 'permission_denied') return 'You need the document download permission for this.';
  if (code === 'file_not_available') return 'This document is not available yet.';
  if (code === 'feature_not_ready') return 'Document storage is not set up yet.';
  return `The document could not be opened. Reason: ${code}.`;
}

/**
 * The lead's documents (a passport, an approval letter, a SIM photo…), the
 * current one of each type, each with its latest review: view it in a tab of
 * its own, or download it. Both take the document download permission, and
 * every link is recorded. Staff who review documents (`canReview`) approve or
 * reject each, after which the record is reloaded (`onReviewed`): the review
 * writes a timeline entry and may open a stage move. Nothing shows when the
 * lead has none.
 */
export function LeadDocuments({
  accessToken,
  workspaceId,
  documents,
  canDownload,
  canReview,
  onReviewed,
}: {
  accessToken: string;
  workspaceId: string;
  documents: readonly LeadDocument[];
  canDownload: boolean;
  canReview: boolean;
  onReviewed(): Promise<void>;
}) {
  if (documents.length === 0) return null;
  const ordered = [...documents].sort(
    (a, b) => rank(a.documentType) - rank(b.documentType) || a.createdAt.localeCompare(b.createdAt),
  );
  return (
    <Card>
      <CardContent className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">Documents</h2>
        <ul className="flex flex-col divide-y" aria-label="Documents">
          {ordered.map((document) => (
            <DocumentRow
              key={document.id}
              accessToken={accessToken}
              workspaceId={workspaceId}
              document={document}
              canDownload={canDownload}
              canReview={canReview}
              onReviewed={onReviewed}
            />
          ))}
        </ul>
        {canDownload ? null : (
          <p className="text-xs text-muted-foreground">
            Opening documents needs the document download permission, which an owner can grant.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function DocumentRow({
  accessToken,
  workspaceId,
  document,
  canDownload,
  canReview,
  onReviewed,
}: {
  accessToken: string;
  workspaceId: string;
  document: LeadDocument;
  canDownload: boolean;
  canReview: boolean;
  onReviewed(): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const label = documentLabel(document.documentType);
  const badge = reviewBadge(document.review);

  async function view() {
    setMessage(undefined);
    // Opened now, inside the click: once the link is back, a popup blocker would refuse it.
    const tab = downloadNavigation.openTab();
    if (!tab) {
      setMessage('Your browser blocked the new tab. Allow pop-ups for this site, or download it.');
      return;
    }
    setBusy(true);
    try {
      const link = await createFileDownloadLink(accessToken, workspaceId, document.id, 'inline');
      tab.show(link.url);
    } catch (error) {
      tab.close();
      setMessage(linkFailure(errorReason(error)));
    } finally {
      setBusy(false);
    }
  }

  async function review(decision: FileReviewDecision) {
    setBusy(true);
    setMessage(undefined);
    try {
      await reviewFile(accessToken, workspaceId, document.id, { decision });
    } catch (error) {
      setMessage(`The review was not saved. Reason: ${errorReason(error)}.`);
      setBusy(false);
      return;
    }
    try {
      await onReviewed();
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    setBusy(true);
    setMessage(undefined);
    try {
      const link = await createFileDownloadLink(accessToken, workspaceId, document.id);
      downloadNavigation.open(link.url);
    } catch (error) {
      setMessage(linkFailure(errorReason(error)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-col gap-1 py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-col">
          <span className="flex items-center gap-2">
            <span className="font-medium">{label}</span>
            <Badge variant="outline" className={cn('font-normal', badge.className)}>
              {badge.label}
            </Badge>
          </span>
          <span className="text-xs text-muted-foreground">
            {FORMAT_LABELS[document.contentType]} · {sizeLabel(document.sizeBytes)} ·{' '}
            <time dateTime={document.createdAt} title={dateTimeLabel(document.createdAt)}>
              added {relativeTime(document.createdAt)}
            </time>
          </span>
        </span>
        {canDownload || canReview ? (
          <span className="flex flex-wrap gap-2">
            {canReview ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || document.review?.decision === 'approved'}
                  aria-label={`Approve ${label}`}
                  onClick={() => void review('approved')}
                >
                  Approve
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || document.review?.decision === 'rejected'}
                  aria-label={`Reject ${label}`}
                  onClick={() => void review('rejected')}
                >
                  Reject
                </Button>
              </>
            ) : null}
            {canDownload ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  aria-label={`View ${label}`}
                  onClick={() => void view()}
                >
                  View
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  aria-label={`Download ${label}`}
                  onClick={() => void download()}
                >
                  Download
                </Button>
              </>
            ) : null}
          </span>
        ) : null}
      </div>
      {message ? (
        <p role="alert" className="text-xs text-destructive">
          {message}
        </p>
      ) : null}
    </li>
  );
}
