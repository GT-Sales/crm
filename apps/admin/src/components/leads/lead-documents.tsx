'use client';

import { useState } from 'react';
import type { LeadDocument } from '@gt-sales/contracts';
import { Button, Card, CardContent } from '@gt-sales/ui';

import { createFileDownloadLink } from '../../lib/api';
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

function linkFailure(code: string): string {
  if (code === 'permission_denied') return 'You need the document download permission for this.';
  if (code === 'file_not_available') return 'This document is not available yet.';
  if (code === 'feature_not_ready') return 'Document storage is not set up yet.';
  return `The document could not be opened. Reason: ${code}.`;
}

/**
 * The lead's documents (a passport, an approval letter, a SIM photo…), the
 * current one of each type: view it in a tab of its own, or download it.
 * Both take the document download permission, and every link is recorded.
 * Nothing shows when the lead has none.
 */
export function LeadDocuments({
  accessToken,
  workspaceId,
  documents,
  canDownload,
}: {
  accessToken: string;
  workspaceId: string;
  documents: readonly LeadDocument[];
  canDownload: boolean;
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
}: {
  accessToken: string;
  workspaceId: string;
  document: LeadDocument;
  canDownload: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const label = documentLabel(document.documentType);

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
          <span className="font-medium">{label}</span>
          <span className="text-xs text-muted-foreground">
            {FORMAT_LABELS[document.contentType]} · {sizeLabel(document.sizeBytes)} ·{' '}
            <time dateTime={document.createdAt} title={dateTimeLabel(document.createdAt)}>
              added {relativeTime(document.createdAt)}
            </time>
          </span>
        </span>
        {canDownload ? (
          <span className="flex gap-2">
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
