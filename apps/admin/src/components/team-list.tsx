'use client';

import { useMemo, useState } from 'react';
import type { AssignableMember } from '@gt-sales/contracts';
import { staffRoleNames, type StaffRoleName } from '@gt-sales/types';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from '@gt-sales/ui';
import { Search, ShieldCheck } from 'lucide-react';

import { listWorkspaceMembers, revokeStaff } from '../lib/api';
import { memberName, ROLE_LABELS } from '../lib/people';
import { errorReason, useResource } from '../lib/use-resource';
import { useStaffSession } from './staff-session-provider';
import { LoadingSkeleton } from './crm/loading-skeleton';

function memberInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'TM';
  if (parts.length === 1) return (parts[0]?.slice(0, 2) ?? 'TM').toUpperCase();
  return `${parts[0]?.[0] ?? ''}${parts[parts.length - 1]?.[0] ?? ''}`.toUpperCase();
}

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
  const [searchQuery, setSearchQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<'all' | StaffRoleName>('all');

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

  const filteredMembers = useMemo(() => {
    const members = team.data?.members ?? [];
    const normalizedSearch = searchQuery.trim().toLowerCase();
    return members.filter((member) => {
      if (roleFilter !== 'all' && !member.roles.includes(roleFilter)) return false;
      if (!normalizedSearch) return true;
      const name = memberName(member).toLowerCase();
      const roleLabels = member.roles
        .map((role) => ROLE_LABELS[role])
        .join(', ')
        .toLowerCase();
      return name.includes(normalizedSearch) || roleLabels.includes(normalizedSearch);
    });
  }, [team.data?.members, searchQuery, roleFilter]);

  return (
    <section aria-labelledby="team-heading" className="flex flex-col gap-4">
      <div className="flex items-center justify-between border-b border-border/70">
        <div className="flex items-center gap-6">
          <div className="border-b-2 border-foreground pb-2.5">
            <h2 id="team-heading" className="text-sm font-medium text-foreground">
              Team Members
            </h2>
          </div>
        </div>
        <p className="hidden pb-2.5 text-xs text-muted-foreground sm:block">
          Everyone with access to this site, under the name they set for themselves.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative min-w-[180px] flex-1">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            aria-label="Filter team members"
            placeholder="Filter..."
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            className="pl-9"
          />
        </div>
        <select
          aria-label="Filter by role"
          value={roleFilter}
          onChange={(event) => {
            const value = event.target.value;
            const matched = staffRoleNames.find((role) => role === value);
            setRoleFilter(matched ?? 'all');
          }}
          className="h-9 rounded-md border border-input bg-background px-3 text-xs font-medium text-foreground shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="all">All Team Roles</option>
          {staffRoleNames.map((role) => (
            <option key={role} value={role}>
              {ROLE_LABELS[role]}
            </option>
          ))}
        </select>
      </div>

      {team.error ? (
        <p role="alert" className="text-sm text-rose-700 dark:text-rose-300">
          The team could not be loaded. Reason: {team.error}.
        </p>
      ) : !team.data ? (
        <LoadingSkeleton label="Loading the team…" variant="list" />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border/80 bg-card/30">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border/70 bg-muted/20 px-4 py-2.5 text-xs font-medium text-muted-foreground sm:grid-cols-[minmax(0,1.4fr)_minmax(120px,1fr)_auto_auto]">
            <span>Members ({filteredMembers.length})</span>
            <span className="hidden sm:block">Role</span>
            <span className="hidden sm:block">Status</span>
            <span className="text-right">Access</span>
          </div>

          <ul aria-label="Team" className="divide-y divide-border/70">
            {filteredMembers.map((member) => {
              const name = memberName(member);
              const rolesLabel = member.roles.map((role) => ROLE_LABELS[role]).join(', ');
              return (
                <li
                  key={member.membershipId}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-muted/20 sm:grid-cols-[minmax(0,1.4fr)_minmax(120px,1fr)_auto_auto]"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <div
                      aria-hidden="true"
                      className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border/70 bg-muted/50 text-xs font-semibold text-foreground"
                    >
                      {memberInitials(name)}
                    </div>
                    <div className="flex min-w-0 flex-col">
                      <span className="flex flex-wrap items-center gap-2 font-medium text-foreground">
                        <span className="truncate">{name}</span>
                        {member.isSelf ? (
                          <Badge variant="outline" className="px-1.5 py-0 text-[11px] font-normal">
                            You
                          </Badge>
                        ) : null}
                      </span>
                      {member.isSelf && staff.email ? (
                        <span className="truncate text-xs text-muted-foreground">
                          {staff.email}
                        </span>
                      ) : null}
                      <span className="truncate text-xs text-muted-foreground sm:hidden">
                        {rolesLabel}
                      </span>
                    </div>
                  </div>

                  <div className="hidden min-w-0 text-xs text-muted-foreground sm:block">
                    {rolesLabel}
                  </div>

                  <div className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
                    <ShieldCheck className="size-4 text-muted-foreground" aria-hidden="true" />
                    <span>Active</span>
                  </div>

                  <div className="flex items-center justify-end gap-2">
                    {isOwner && !member.isSelf ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        aria-label={`Remove ${name}`}
                        onClick={() => setRemoveTarget(member)}
                      >
                        Remove
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {member.roles.includes('owner') ? 'Full access' : 'Role access'}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
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
