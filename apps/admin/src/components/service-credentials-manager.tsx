'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { websiteScopeNames, type WebsiteScopeName } from '@gt-sales/types';
import type { ServiceCredentialSummary } from '@gt-sales/contracts';
import {
  Badge,
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

/** What a scope lets the website do, for the scopes whose name alone does not say. */
const SCOPE_LABELS: Partial<Record<WebsiteScopeName, string>> = {
  tracking: 'Order tracking',
};

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

  const activeCount = credentials.filter((c) => !c.revokedAt).length;

  return (
    <section className="flex flex-col gap-6">
      <form
        onSubmit={create}
        className="overflow-hidden rounded-xl border border-border/80 bg-card/30"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-5 py-3.5">
          <div>
            <h2 className="text-sm font-medium text-foreground">Website service credentials</h2>
            <p className="text-xs text-muted-foreground">
              A storefront authenticates to the backend with a scoped, revocable credential. The
              workspace is derived from the credential, never from the request.
            </p>
          </div>
          <Button type="submit" size="sm" disabled={busy || selectedScopes.length === 0}>
            {busy ? 'Working…' : 'Issue credential'}
          </Button>
        </div>

        <div className="p-5">
          <fieldset className="space-y-2.5">
            <legend className="text-xs font-medium text-muted-foreground">Scopes</legend>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
              {websiteScopeNames.map((scope) => {
                const checked = selectedScopes.includes(scope);
                return (
                  <label
                    key={scope}
                    className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-3.5 py-2.5 text-xs transition-colors ${
                      checked
                        ? 'border-foreground/30 bg-muted/60 text-foreground'
                        : 'border-border/70 bg-background/40 text-muted-foreground hover:bg-muted/30 hover:text-foreground'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="size-3.5 rounded border-border accent-primary"
                      checked={checked}
                      onChange={() => toggleScope(scope)}
                    />
                    <span className="flex flex-col gap-0.5">
                      {SCOPE_LABELS[scope] ? (
                        <span className="font-medium text-foreground">{SCOPE_LABELS[scope]}</span>
                      ) : null}
                      <code className="font-mono text-[11px]">{scope}</code>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        </div>
      </form>

      {issuedSecret ? (
        <div className="flex flex-col gap-2.5 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="issued-secret" className="text-xs font-semibold text-foreground">
              New credential secret (shown once)
            </Label>
            <Badge variant="outline" className="text-[11px]">
              One-time secret
            </Badge>
          </div>
          <code
            id="issued-secret"
            className="block break-all rounded-lg border border-border/70 bg-background/80 p-3 font-mono text-xs text-foreground"
            data-testid="issued-secret"
          >
            {issuedSecret}
          </code>
        </div>
      ) : null}

      {message ? (
        <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
          {message}
        </p>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-border/80 bg-card/30">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium text-foreground">Existing credentials</h3>
            <Badge variant="secondary" className="text-xs font-normal">
              {activeCount} active
            </Badge>
          </div>
          <span className="text-xs text-muted-foreground">{credentials.length} total</span>
        </div>

        {credentials.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">
            No credentials issued yet.
          </p>
        ) : (
          <ul className="divide-y divide-border/70">
            {credentials.map((credential) => (
              <li
                key={credential.id}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 text-sm transition-colors hover:bg-muted/20"
              >
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <code className="font-mono text-xs text-foreground">{credential.id}</code>
                    <Badge
                      variant={credential.revokedAt ? 'secondary' : 'outline'}
                      className="text-[11px] font-normal"
                    >
                      {credential.revokedAt ? 'revoked' : 'active'}
                    </Badge>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {credential.scopes.join(', ')}
                  </span>
                  {credential.revokedAt ? (
                    <span className="text-xs text-muted-foreground">
                      Revoked {new Date(credential.revokedAt).toISOString()}
                    </span>
                  ) : null}
                </span>
                {credential.revokedAt ? null : (
                  <Button
                    type="button"
                    size="sm"
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
