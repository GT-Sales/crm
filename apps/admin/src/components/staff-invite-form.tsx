'use client';

import { useState, type FormEvent } from 'react';
import { staffRoleNames, type StaffRoleName } from '@gt-sales/types';
import { Button, Input, Label } from '@gt-sales/ui';
import { Mail, Plus, Trash2, UserPlus } from 'lucide-react';

import { BackendError, inviteStaff } from '../lib/api';
import { ROLE_LABELS } from '../lib/people';
import { useStaffSession } from './staff-session-provider';

interface InviteRow {
  id: number;
  email: string;
  roles: readonly StaffRoleName[];
}

export function StaffInviteForm({ workspaceSlug }: { workspaceSlug: string }) {
  const staff = useStaffSession();
  const workspace = staff.workspaces.find((item) => item.slug === workspaceSlug);
  const [rows, setRows] = useState<readonly InviteRow[]>([{ id: 1, email: '', roles: ['viewer'] }]);
  const [nextId, setNextId] = useState(2);
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (!workspace?.roles.includes('owner')) return null;

  function updateRowEmail(id: number, email: string) {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, email } : row)));
  }

  function updatePrimaryRole(id: number, role: StaffRoleName) {
    setRows((current) =>
      current.map((row) => {
        if (row.id !== id) return row;
        const extras = row.roles.slice(1).filter((item) => item !== role);
        return { ...row, roles: [role, ...extras] };
      }),
    );
  }

  function toggleExtraRole(id: number, role: StaffRoleName) {
    setRows((current) =>
      current.map((row) => {
        if (row.id !== id) return row;
        const exists = row.roles.includes(role);
        if (exists && row.roles.length === 1) return row;
        return {
          ...row,
          roles: exists ? row.roles.filter((item) => item !== role) : [...row.roles, role],
        };
      }),
    );
  }

  function addRow() {
    setRows((current) => [...current, { id: nextId, email: '', roles: ['viewer'] }]);
    setNextId((value) => value + 1);
  }

  function removeRow(id: number) {
    setRows((current) => (current.length > 1 ? current.filter((row) => row.id !== id) : current));
  }

  const activeRows = rows.filter((row) => row.email.trim().length > 0 && row.roles.length > 0);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!staff.accessToken || !workspace || activeRows.length === 0 || busy) return;
    setBusy(true);
    setMessage(undefined);
    try {
      for (const row of activeRows) {
        await inviteStaff(staff.accessToken, workspace.id, {
          email: row.email.trim(),
          roles: [...row.roles],
        });
      }
      setRows([{ id: nextId, email: '', roles: ['viewer'] }]);
      setNextId((value) => value + 1);
      setMessage(
        activeRows.length === 1
          ? 'Invitation is pending. The recipient can now accept it from the sign-in page.'
          : `${activeRows.length} invitations are pending. The recipients can now accept them from the sign-in page.`,
      );
    } catch (error) {
      const reason = error instanceof BackendError ? error.code : 'internal_error';
      setMessage(`Invitation was not created. Reason: ${reason}.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      aria-labelledby="invite-heading"
      className="overflow-hidden rounded-xl border border-border/80 bg-card/30"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-5 py-3.5">
        <div>
          <h2 id="invite-heading" className="text-sm font-medium text-foreground">
            Invite new members by email address
          </h2>
          <p className="text-xs text-muted-foreground">
            Choose the roles they need to work on this site.
          </p>
        </div>
        <Button
          type="submit"
          size="sm"
          aria-label="Create invitation"
          disabled={busy || activeRows.length === 0}
          className="gap-1.5"
        >
          <UserPlus className="size-3.5" aria-hidden="true" />
          {busy ? 'Creating…' : 'Invite'}
        </Button>
      </div>

      <div className="flex flex-col gap-4 p-5">
        {rows.map((row, index) => {
          const emailId = index === 0 ? 'invite-email' : `invite-email-${row.id}`;
          const roleId = `invite-role-${row.id}`;
          const primaryRole: StaffRoleName = row.roles[0] ?? 'viewer';
          return (
            <div key={row.id} className="flex flex-col gap-2.5">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,240px)]">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={emailId} className="text-xs font-medium text-foreground">
                    {index === 0 ? 'Staff email' : `Staff email ${index + 1}`}
                  </Label>
                  <div className="relative flex items-center">
                    <Mail
                      aria-hidden="true"
                      className="pointer-events-none absolute left-3 size-4 text-muted-foreground"
                    />
                    <Input
                      id={emailId}
                      type="email"
                      autoComplete="email"
                      placeholder="jane@example.com"
                      maxLength={254}
                      required={index === 0}
                      disabled={busy}
                      value={row.email}
                      onChange={(event) => updateRowEmail(row.id, event.target.value)}
                      className="pl-9"
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={roleId} className="text-xs font-medium text-foreground">
                    Role
                  </Label>
                  <div className="flex items-center gap-2">
                    <select
                      id={roleId}
                      disabled={busy}
                      value={primaryRole}
                      onChange={(event) => {
                        const chosen = staffRoleNames.find((item) => item === event.target.value);
                        if (chosen) updatePrimaryRole(row.id, chosen);
                      }}
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {staffRoleNames.map((role) => (
                        <option key={role} value={role}>
                          {ROLE_LABELS[role]}
                        </option>
                      ))}
                    </select>
                    {rows.length > 1 ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={busy}
                        aria-label={`Remove invite row ${index + 1}`}
                        onClick={() => removeRow(row.id)}
                        className="size-9 shrink-0 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="size-4" aria-hidden="true" />
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>

              <fieldset className="flex flex-wrap items-center gap-2">
                <legend className="sr-only">Additional roles</legend>
                {staffRoleNames.map((role) => {
                  const active = row.roles.includes(role);
                  return (
                    <label
                      key={role}
                      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors ${
                        active
                          ? 'border-primary/50 bg-primary/10 font-medium text-foreground'
                          : 'border-border/70 bg-background/40 text-muted-foreground hover:bg-muted/40'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={active}
                        disabled={busy}
                        onChange={() => toggleExtraRole(row.id, role)}
                        className="size-3 accent-primary"
                      />
                      {ROLE_LABELS[role]}
                    </label>
                  );
                })}
              </fieldset>
            </div>
          );
        })}

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || rows.length >= 10}
            onClick={addRow}
            className="gap-1.5"
          >
            <Plus className="size-3.5" aria-hidden="true" />
            Add more
          </Button>
          {message ? (
            <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
              {message}
            </p>
          ) : null}
        </div>
      </div>
    </form>
  );
}
