'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { websiteScopeNames, type WebsiteScopeName } from '@gt-sales/types';
import type { ServiceCredentialSummary } from '@gt-sales/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
} from '@gt-sales/ui';

import {
  BackendError,
  createServiceCredential,
  listServiceCredentials,
  revokeServiceCredential,
} from '../lib/api';
import { useStaffSession } from './staff-session-provider';

const DEFAULT_SCOPES: readonly WebsiteScopeName[] = ['leads:write', 'uploads:customer'];

export function ServiceCredentialsManager({ workspaceSlug }: { workspaceSlug: string }) {
  const staff = useStaffSession();
  const workspace = staff.workspaces.find((item) => item.slug === workspaceSlug);
  const workspaceId = workspace?.id;
  const isOwner = workspace?.roles.includes('owner') ?? false;

  const [credentials, setCredentials] = useState<ServiceCredentialSummary[]>([]);
  const [selectedScopes, setSelectedScopes] = useState<readonly WebsiteScopeName[]>(DEFAULT_SCOPES);
  const [issuedSecret, setIssuedSecret] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ServiceCredentialSummary>();

  const accessToken = staff.accessToken;

  const refresh = useCallback(async () => {
    if (!accessToken || !workspaceId) return;
    try {
      const result = await listServiceCredentials(accessToken, workspaceId);
      setCredentials(result.credentials);
    } catch (error) {
      setMessage(
        `Could not load credentials. Reason: ${error instanceof BackendError ? error.code : 'internal_error'}.`,
      );
    }
  }, [accessToken, workspaceId]);

  useEffect(() => {
    if (isOwner) void refresh();
  }, [isOwner, refresh]);

  if (!isOwner) return null;

  function toggleScope(scope: WebsiteScopeName) {
    setSelectedScopes((current) =>
      current.includes(scope) ? current.filter((item) => item !== scope) : [...current, scope],
    );
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessToken || !workspaceId || selectedScopes.length === 0 || busy) return;
    setBusy(true);
    setMessage(undefined);
    setIssuedSecret(undefined);
    try {
      const result = await createServiceCredential(accessToken, workspaceId, {
        scopes: [...selectedScopes],
      });
      setIssuedSecret(result.secret);
      setMessage('Store this secret now — it is shown once and cannot be retrieved again.');
      await refresh();
    } catch (error) {
      setMessage(
        `Credential was not created. Reason: ${error instanceof BackendError ? error.code : 'internal_error'}.`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function revoke(credentialId: string) {
    if (!accessToken || !workspaceId || busy) return;
    setBusy(true);
    setMessage(undefined);
    try {
      await revokeServiceCredential(accessToken, workspaceId, credentialId);
      await refresh();
    } catch (error) {
      setMessage(
        `Credential was not revoked. Reason: ${error instanceof BackendError ? error.code : 'internal_error'}.`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex max-w-2xl flex-col gap-6">
      <div>
        <h2 className="text-base font-semibold">Website service credentials</h2>
        <p className="text-sm text-muted-foreground">
          A storefront authenticates to the backend with a scoped, revocable credential. The
          workspace is derived from the credential, never from the request.
        </p>
      </div>

      <form onSubmit={create} className="flex flex-col gap-4">
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Scopes</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {websiteScopeNames.map((scope) => (
              <label key={scope} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selectedScopes.includes(scope)}
                  onChange={() => toggleScope(scope)}
                />
                <code>{scope}</code>
              </label>
            ))}
          </div>
        </fieldset>
        <Button type="submit" disabled={busy || selectedScopes.length === 0}>
          {busy ? 'Working…' : 'Issue credential'}
        </Button>
      </form>

      {issuedSecret ? (
        <div className="flex flex-col gap-2 rounded-md border border-destructive/50 p-4">
          <Label htmlFor="issued-secret">New credential secret (shown once)</Label>
          <code
            id="issued-secret"
            className="block break-all rounded bg-muted p-2 text-sm"
            data-testid="issued-secret"
          >
            {issuedSecret}
          </code>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Existing credentials</h3>
        {credentials.length === 0 ? (
          <p className="text-sm text-muted-foreground">No credentials issued yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {credentials.map((credential) => (
              <li
                key={credential.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm"
              >
                <span className="flex flex-col gap-1">
                  <code className="text-xs text-muted-foreground">{credential.id}</code>
                  <span>{credential.scopes.join(', ')}</span>
                  {credential.revokedAt ? (
                    <span className="text-xs text-muted-foreground">
                      Revoked {new Date(credential.revokedAt).toISOString()}
                    </span>
                  ) : null}
                </span>
                {credential.revokedAt ? (
                  <span className="text-xs text-muted-foreground">revoked</span>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setRevokeTarget(credential)}
                  >
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {message ? (
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {message}
        </p>
      ) : null}

      <Dialog
        open={revokeTarget !== undefined}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke credential</DialogTitle>
            <DialogDescription>
              Any storefront using credential {revokeTarget?.id} will stop working immediately. This
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRevokeTarget(undefined)}>
              Close
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                if (!revokeTarget) return;
                const target = revokeTarget.id;
                setRevokeTarget(undefined);
                await revoke(target);
              }}
            >
              Revoke credential
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
