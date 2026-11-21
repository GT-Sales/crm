'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { websiteScopeNames, type WebsiteScopeName } from '@gt-sales/types';
import { leadTypeCatalog, leadTypeLabel, type ServiceCredentialSummary } from '@gt-sales/contracts';
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
  createServiceCredential,
  listServiceCredentials,
  revokeServiceCredential,
  updateServiceCredential,
} from '../lib/api';
import { describeError } from '../lib/error-text';
import { useStaffSession } from './staff-session-provider';

/** What a scope lets the website do, for the scopes whose name alone does not say. */
const SCOPE_LABELS: Partial<Record<WebsiteScopeName, string>> = {
  tracking: 'Order tracking',
};

const DEFAULT_SCOPES: readonly WebsiteScopeName[] = ['leads:write', 'uploads:customer'];

/** Every registered lead type, in catalogue order: what a key may be permitted to send. */
const LEAD_TYPES: readonly string[] = Object.keys(leadTypeCatalog);

/** A key's lead types in words; a key without a list (made before they existed) is not limited. */
function leadTypesLine(credential: ServiceCredentialSummary): string {
  return credential.leadTypes
    ? `Lead types: ${credential.leadTypes.map(leadTypeLabel).join(', ')}`
    : 'Lead types: not limited (any type)';
}

/** The lead types in catalogue order, whatever order they were ticked in. */
function inCatalogueOrder(leadTypes: readonly string[]): string[] {
  return LEAD_TYPES.filter((leadType) => leadTypes.includes(leadType));
}

function sameLeadTypes(a: readonly string[], b: readonly string[] | null | undefined): boolean {
  return b != null && a.length === b.length && a.every((leadType) => b.includes(leadType));
}

/**
 * The lead types of one existing key, as checkboxes with Save and Cancel. A
 * key that is not limited starts with every type ticked, since that is what it
 * accepts today; saving then limits it to the ticked ones.
 */
function LeadTypesEditor({
  credential,
  onSave,
  onCancel,
}: {
  credential: ServiceCredentialSummary;
  /** Saves the list; resolves to an error sentence when it could not be saved. */
  onSave(leadTypes: string[]): Promise<string | undefined>;
  onCancel(): void;
}) {
  const [selected, setSelected] = useState<readonly string[]>(
    credential.leadTypes ? inCatalogueOrder(credential.leadTypes) : LEAD_TYPES,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const none = selected.length === 0;
  const unchanged = sameLeadTypes(selected, credential.leadTypes);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (none || unchanged || saving) return;
    setSaving(true);
    setError(undefined);
    const failure = await onSave([...selected]);
    // On success the row replaces this editor, so there is nothing left to update.
    if (failure === undefined) return;
    setError(failure);
    setSaving(false);
  }

  return (
    <form onSubmit={save} className="flex w-full flex-col gap-2.5 pt-1">
      <fieldset className="space-y-2">
        <legend className="text-xs font-medium text-muted-foreground">
          Lead types key {credential.id} may send
        </legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {LEAD_TYPES.map((leadType) => {
            const checked = selected.includes(leadType);
            return (
              <label
                key={leadType}
                className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-xs transition-colors ${
                  checked
                    ? 'border-foreground/30 bg-muted/60 text-foreground'
                    : 'border-border/70 bg-background/40 text-muted-foreground hover:bg-muted/30 hover:text-foreground'
                }`}
              >
                <input
                  type="checkbox"
                  className="size-3.5 rounded border-border accent-primary"
                  checked={checked}
                  disabled={saving}
                  onChange={() =>
                    setSelected((current) =>
                      current.includes(leadType)
                        ? current.filter((item) => item !== leadType)
                        : inCatalogueOrder([...current, leadType]),
                    )
                  }
                />
                <span className="font-medium text-foreground">{leadTypeLabel(leadType)}</span>
              </label>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          {none
            ? 'Choose at least one lead type.'
            : 'A lead of any other type is refused and nothing is saved. The key’s secret stays the same.'}
        </p>
      </fieldset>
      {error === undefined ? null : (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={none || unchanged || saving}>
          {saving ? 'Saving…' : 'Save lead types'}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function ServiceCredentialsManager({ workspaceSlug }: { workspaceSlug: string }) {
  const staff = useStaffSession();
  const workspace = staff.workspaces.find((item) => item.slug === workspaceSlug);
  const workspaceId = workspace?.id;
  const isOwner = workspace?.roles.includes('owner') ?? false;

  const [credentials, setCredentials] = useState<ServiceCredentialSummary[]>([]);
  const [selectedScopes, setSelectedScopes] = useState<readonly WebsiteScopeName[]>(DEFAULT_SCOPES);
  // None chosen to start with: a key is permitted only what the owner ticks (#84).
  const [selectedLeadTypes, setSelectedLeadTypes] = useState<readonly string[]>([]);
  const [issuedSecret, setIssuedSecret] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ServiceCredentialSummary>();
  /** The key whose lead types are being changed, if any. */
  const [editingId, setEditingId] = useState<string>();

  const accessToken = staff.accessToken;

  const refresh = useCallback(async () => {
    if (!accessToken || !workspaceId) return;
    try {
      const result = await listServiceCredentials(accessToken, workspaceId);
      setCredentials(result.credentials);
    } catch (error) {
      setMessage(describeError(error, 'load the website keys'));
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

  function toggleLeadType(leadType: string) {
    setSelectedLeadTypes((current) =>
      current.includes(leadType)
        ? current.filter((item) => item !== leadType)
        : LEAD_TYPES.filter((item) => item === leadType || current.includes(item)),
    );
  }

  const incomplete = selectedScopes.length === 0 || selectedLeadTypes.length === 0;

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessToken || !workspaceId || incomplete || busy) return;
    setBusy(true);
    setMessage(undefined);
    setIssuedSecret(undefined);
    try {
      const result = await createServiceCredential(accessToken, workspaceId, {
        scopes: [...selectedScopes],
        leadTypes: [...selectedLeadTypes],
      });
      setIssuedSecret(result.secret);
      setMessage('Store this secret now — it is shown once and cannot be retrieved again.');
      await refresh();
    } catch (error) {
      setMessage(describeError(error, 'create the key'));
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
      setMessage(describeError(error, 'revoke the key'));
    } finally {
      setBusy(false);
    }
  }

  /** Saves a key's lead types; the error sentence when it could not be saved. */
  async function saveLeadTypes(credentialId: string, leadTypes: string[]) {
    if (!accessToken || !workspaceId) return undefined;
    try {
      const result = await updateServiceCredential(accessToken, workspaceId, credentialId, {
        leadTypes,
      });
      setCredentials((current) =>
        current.map((item) => (item.id === credentialId ? result.credential : item)),
      );
      setEditingId(undefined);
      return undefined;
    } catch (error) {
      return describeError(error, 'change the key’s lead types');
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
          <Button type="submit" size="sm" disabled={busy || incomplete}>
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
          <fieldset className="mt-5 space-y-2.5">
            <legend className="text-xs font-medium text-muted-foreground">
              Lead types this key may send
            </legend>
            <p className="text-xs text-muted-foreground">
              A lead of any other type is refused and nothing is saved. Choose at least one.
            </p>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
              {LEAD_TYPES.map((leadType) => {
                const checked = selectedLeadTypes.includes(leadType);
                return (
                  <label
                    key={leadType}
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
                      onChange={() => toggleLeadType(leadType)}
                    />
                    <span className="font-medium text-foreground">{leadTypeLabel(leadType)}</span>
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
                  <span className="text-xs text-muted-foreground">{leadTypesLine(credential)}</span>
                  {credential.revokedAt ? (
                    <span className="text-xs text-muted-foreground">
                      Revoked {new Date(credential.revokedAt).toISOString()}
                    </span>
                  ) : null}
                </span>
                {credential.revokedAt ? null : (
                  <span className="flex flex-wrap gap-2">
                    {editingId === credential.id ? null : (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        aria-label={`Edit lead types of key ${credential.id}`}
                        onClick={() => setEditingId(credential.id)}
                      >
                        Edit lead types
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => setRevokeTarget(credential)}
                    >
                      Revoke
                    </Button>
                  </span>
                )}
                {editingId === credential.id && !credential.revokedAt ? (
                  <LeadTypesEditor
                    key={credential.id}
                    credential={credential}
                    onSave={(leadTypes) => saveLeadTypes(credential.id, leadTypes)}
                    onCancel={() => setEditingId(undefined)}
                  />
                ) : null}
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
