'use client';

import { useState, type FormEvent } from 'react';
import { staffRoleNames, type StaffRoleName } from '@gt-sales/types';
import { Button, Input, Label } from '@gt-sales/ui';

import { BackendError, inviteStaff } from '../lib/api';
import { useStaffSession } from './staff-session-provider';

export function StaffInviteForm({ workspaceSlug }: { workspaceSlug: string }) {
  const staff = useStaffSession();
  const workspace = staff.workspaces.find((item) => item.slug === workspaceSlug);
  const [email, setEmail] = useState('');
  const [selectedRoles, setSelectedRoles] = useState<readonly StaffRoleName[]>(['viewer']);
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (!workspace?.roles.includes('owner')) return null;

  function toggleRole(role: StaffRoleName) {
    setSelectedRoles((current) =>
      current.includes(role) ? current.filter((item) => item !== role) : [...current, role],
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!staff.accessToken || !workspace || selectedRoles.length === 0 || busy) return;
    setBusy(true);
    setMessage(undefined);
    try {
      await inviteStaff(staff.accessToken, workspace.id, { email, roles: [...selectedRoles] });
      setEmail('');
      setMessage('Invitation is pending. The recipient can now accept it from the sign-in page.');
    } catch (error) {
      const reason = error instanceof BackendError ? error.code : 'internal_error';
      setMessage(`Invitation was not created. Reason: ${reason}.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex max-w-lg flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="invite-email">Staff email</Label>
        <Input
          id="invite-email"
          type="email"
          autoComplete="email"
          maxLength={254}
          required
          disabled={busy}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Roles</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {staffRoleNames.map((role) => (
            <label key={role} className="flex items-center gap-2 text-sm capitalize">
              <input
                type="checkbox"
                checked={selectedRoles.includes(role)}
                onChange={() => toggleRole(role)}
              />
              {role}
            </label>
          ))}
        </div>
      </fieldset>
      <Button type="submit" disabled={busy || selectedRoles.length === 0}>
        {busy ? 'Creating…' : 'Create invitation'}
      </Button>
      {message ? (
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {message}
        </p>
      ) : null}
    </form>
  );
}
