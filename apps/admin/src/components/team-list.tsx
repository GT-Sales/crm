'use client';

import { useMemo, useState } from 'react';
import type { AssignableMember } from '@gt-sales/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@gt-sales/ui';

import { listWorkspaceMembers, revokeStaff } from '../lib/api';
import { memberName, ROLE_LABELS } from '../lib/people';
import { errorReason, useResource } from '../lib/use-resource';
import { useStaffSession } from './staff-session-provider';

/**
 * Who works on this site: each active member under the name they chose, with
 * their roles, so the owner can see who has not set a name yet. Names only,
 * never emails: every role can read this list. The owner can also remove
 * someone's access; the backend refuses removing yourself, so the button is
 * not offered there, and past work stays on the leads.
 */
export function TeamList({ workspaceSlug }: { workspaceSlug: string }) {
  const staff = useStaffSession();
  const workspace = staff.workspaces.find((item) => item.slug === workspaceSlug);
  const isOwner = workspace?.roles.includes('owner') ?? false;
  const { accessToken } = staff;
  const workspaceId = workspace?.id;
  const load = useMemo(
    () =>
      accessToken && workspaceId ? () => listWorkspaceMembers(accessToken, workspaceId) : undefined,
    [accessToken, workspaceId],
  );
  const team = useResource(load);
  const [removeTarget, setRemoveTarget] = useState<AssignableMember>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();

  async function remove(member: AssignableMember) {
    if (!accessToken || !workspaceId) return;
    setBusy(true);
    setMessage(undefined);
    try {
      await revokeStaff(accessToken, workspaceId, member.membershipId);
      team.mutate((current) => ({
        ...current,
        members: current.members.filter((entry) => entry.membershipId !== member.membershipId),
      }));
      setMessage(`${memberName(member)} no longer has access to this site.`);
    } catch (error) {
      setMessage(`${memberName(member)} still has access. Reason: ${errorReason(error)}.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="team-heading" className="flex max-w-lg flex-col gap-3">
      <div>
        <h2 id="team-heading" className="text-base font-semibold">
          Team
        </h2>
        <p className="text-sm text-muted-foreground">
          Everyone with access to this site, under the name they set for themselves.
        </p>
      </div>
      {team.error ? (
        <p role="alert" className="text-sm text-rose-300">
          The team could not be loaded. Reason: {team.error}.
        </p>
      ) : !team.data ? (
        <p className="text-sm text-muted-foreground" aria-busy="true">
          Loading the team…
        </p>
      ) : (
        <ul aria-label="Team" className="divide-y rounded-md border">
          {team.data.members.map((member) => (
            <li
              key={member.membershipId}
              className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
            >
              <div className="flex min-w-0 flex-col">
                <span className="font-medium">
                  {memberName(member)}
                  {member.isSelf ? (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">You</span>
                  ) : null}
                </span>
                <span className="text-xs text-muted-foreground">
                  {member.roles.map((role) => ROLE_LABELS[role]).join(', ')}
                </span>
              </div>
              {isOwner && !member.isSelf ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  aria-label={`Remove ${memberName(member)}`}
                  onClick={() => setRemoveTarget(member)}
                >
                  Remove
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {message ? (
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {message}
        </p>
      ) : null}
      <Dialog
        open={removeTarget !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove access</DialogTitle>
            <DialogDescription>
              {removeTarget ? memberName(removeTarget) : 'This person'} will lose access to this
              site at their next request. Their notes, tasks and changes stay on the leads. To give
              access back, invite them again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRemoveTarget(undefined)}>
              Close
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                if (!removeTarget) return;
                const target = removeTarget;
                setRemoveTarget(undefined);
                await remove(target);
              }}
            >
              Remove access
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
