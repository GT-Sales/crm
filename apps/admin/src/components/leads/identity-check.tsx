'use client';

import { useEffect, useState } from 'react';
import type { LeadIdentity } from '@gt-sales/contracts';
import { Button, Card, CardContent } from '@gt-sales/ui';

import { createFileDownloadLink, revealLeadIdentity } from '../../lib/api';
import { dateTimeLabel, relativeTime } from '../../lib/dates';
import { downloadNavigation } from '../../lib/file-links';
import { describeError } from '../../lib/error-text';
import { errorReason } from '../../lib/use-resource';

/** How long a revealed SIN stays on screen before it is masked again. */
export const REVEAL_SECONDS = 60;

const ID_LABELS: Record<LeadIdentity['idType'], string> = {
  drivers_licence: "Driver's licence",
  sin: 'SIN',
};

/** `123456789` → `123 456 789`, as the customer typed it. */
function formatSin(digits: string): string {
  return digits.replace(/(\d{3})(?=\d)/g, '$1 ');
}

function revealFailure(error: unknown): string {
  const code = errorReason(error);
  if (code === 'permission_denied')
    return 'Only an owner can reveal a SIN. Ask the owner to do it.';
  if (code === 'identity_not_found') {
    return 'This SIN is no longer on the lead. Reload the page to see the latest.';
  }
  return describeError(error, 'reveal the SIN');
}

function downloadFailure(error: unknown): string {
  const code = errorReason(error);
  if (code === 'permission_denied') {
    return "You don't have permission to download photos. Ask the owner to give your role the document download permission.";
  }
  if (code === 'file_not_available') {
    return 'The photo is not available yet. Wait a minute and reload the page.';
  }
  return describeError(error, 'download the photo');
}

/**
 * The identity the customer gave for the credit check: a SIN masked to its
 * last three digits (an owner may reveal it for a minute, and every reveal is
 * recorded) or a licence photo to download. Nothing shows when there is none.
 */
export function IdentityCheck({
  accessToken,
  workspaceId,
  leadId,
  identities,
  canReveal,
}: {
  accessToken: string;
  workspaceId: string;
  leadId: string;
  identities: readonly LeadIdentity[];
  canReveal: boolean;
}) {
  if (identities.length === 0) return null;
  return (
    <Card>
      <CardContent className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">ID check</h2>
        <ul className="flex flex-col divide-y" aria-label="ID check">
          {identities.map((identity) => (
            <IdentityRow
              key={identity.id}
              accessToken={accessToken}
              workspaceId={workspaceId}
              leadId={leadId}
              identity={identity}
              canReveal={canReveal}
            />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function IdentityRow({
  accessToken,
  workspaceId,
  leadId,
  identity,
  canReveal,
}: {
  accessToken: string;
  workspaceId: string;
  leadId: string;
  identity: LeadIdentity;
  canReveal: boolean;
}) {
  const [revealed, setRevealed] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();

  // A revealed number masks itself again; it is never kept anywhere else.
  useEffect(() => {
    if (revealed === undefined) return;
    const timer = setTimeout(() => setRevealed(undefined), REVEAL_SECONDS * 1000);
    return () => clearTimeout(timer);
  }, [revealed]);

  async function reveal() {
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await revealLeadIdentity(accessToken, workspaceId, leadId, identity.id);
      setRevealed(result.sin);
    } catch (error) {
      setMessage(revealFailure(error));
    } finally {
      setBusy(false);
    }
  }

  async function download(fileId: string) {
    setBusy(true);
    setMessage(undefined);
    try {
      const link = await createFileDownloadLink(accessToken, workspaceId, fileId);
      downloadNavigation.open(link.url);
    } catch (error) {
      setMessage(downloadFailure(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-col gap-1 py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{ID_LABELS[identity.idType]}</span>
        <time
          dateTime={identity.createdAt}
          title={dateTimeLabel(identity.createdAt)}
          className="text-xs text-muted-foreground"
        >
          Received {relativeTime(identity.createdAt)}
        </time>
      </div>
      {identity.idType === 'sin' ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex flex-col">
            <span className="font-mono" aria-label="SIN">
              {revealed !== undefined ? formatSin(revealed) : identity.sinMasked}
            </span>
            {identity.dateOfBirth ? (
              <span className="text-xs text-muted-foreground">Born {identity.dateOfBirth}</span>
            ) : null}
          </span>
          {canReveal ? (
            revealed !== undefined ? (
              <Button variant="outline" size="sm" onClick={() => setRevealed(undefined)}>
                Hide
              </Button>
            ) : (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void reveal()}>
                Reveal
              </Button>
            )
          ) : null}
        </div>
      ) : identity.fileId ? (
        <div>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void download(identity.fileId!)}
          >
            Download photo
          </Button>
        </div>
      ) : null}
      {canReveal && identity.idType === 'sin' ? (
        <p className="text-xs text-muted-foreground">
          Revealing is recorded and hides again after a minute.
        </p>
      ) : null}
      {message ? (
        <p role="alert" className="text-xs text-destructive">
          {message}
        </p>
      ) : null}
    </li>
  );
}
