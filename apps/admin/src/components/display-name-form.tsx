'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Badge, Button, Input, Label } from '@gt-sales/ui';
import { Check, Mail, ShieldCheck, User } from 'lucide-react';

import { updateStaffProfile } from '../lib/api';
import { ROLE_LABELS } from '../lib/people';
import { describeError } from '../lib/error-text';
import { useLeadWorkspace } from './leads/use-lead-workspace';
import { useStaffSession } from './staff-session-provider';

function profileInitials(name: string, email: string | undefined): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ''}${parts[parts.length - 1]?.[0] ?? ''}`.toUpperCase();
  }
  if (parts.length === 1 && parts[0]) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  if (email && email.length > 0) {
    return email.slice(0, 2).toUpperCase();
  }
  return 'ME';
}

/**
 * The name colleagues see on assignments, tasks and the timeline, alongside the
 * signed-in member's verified email address and site access summary.
 */
export function DisplayNameForm({ workspaceSlug }: { workspaceSlug: string }) {
  const staff = useStaffSession();
  const { accessToken, members, reloadMembers } = useLeadWorkspace(workspaceSlug);
  const workspace = staff.workspaces.find((item) => item.slug === workspaceSlug);
  const current = members.find((member) => member.isSelf)?.displayName ?? '';
  const [name, setName] = useState(current);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    setName(current);
  }, [current]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!accessToken || !trimmed) return;
    setSaving(true);
    setMessage(undefined);
    try {
      const result = await updateStaffProfile(accessToken, trimmed);
      setMessage(
        `Saved. Colleagues now see “${result.displayName}” on ${result.memberships} site${
          result.memberships === 1 ? '' : 's'
        }.`,
      );
      await reloadMembers();
    } catch (error) {
      setMessage(describeError(error, 'save your name'));
    } finally {
      setSaving(false);
    }
  }

  const initials = profileInitials(name || current, staff.email);
  const roles = workspace?.roles ?? [];

  return (
    <div className="flex flex-col gap-6">
      <section
        aria-labelledby="display-name-heading"
        className="overflow-hidden rounded-xl border border-border/80 bg-card/30"
      >
        <form onSubmit={(event) => void submit(event)}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-5 py-4">
            <div className="flex items-center gap-3">
              <div
                aria-hidden="true"
                className="flex size-10 shrink-0 items-center justify-center rounded-full border border-border/70 bg-muted/50 text-xs font-semibold text-foreground"
              >
                {initials}
              </div>
              <div>
                <h2 id="display-name-heading" className="text-sm font-medium text-foreground">
                  Your name
                </h2>
                <p className="text-xs text-muted-foreground">
                  {current
                    ? 'Shown to colleagues on assignments, tasks and the timeline, on every site.'
                    : 'Colleagues see your role until you set a name. It applies on every site.'}
                </p>
              </div>
            </div>

            <Button
              type="submit"
              size="sm"
              disabled={saving || !name.trim() || name.trim() === current}
              className="gap-1.5"
            >
              <Check className="size-3.5" aria-hidden="true" />
              {saving ? 'Saving…' : 'Save name'}
            </Button>
          </div>

          <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="display-name" className="text-xs font-medium text-foreground">
                Display name
              </Label>
              <div className="relative flex items-center">
                <User
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 size-4 text-muted-foreground"
                />
                <Input
                  id="display-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={80}
                  placeholder="e.g. Takib"
                  autoComplete="name"
                  className="pl-9"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Visible to your teammates across all {staff.workspaces.length || 1} site
                {staff.workspaces.length === 1 ? '' : 's'}.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="profile-email" className="text-xs font-medium text-foreground">
                  Email address
                </Label>
                {staff.email ? (
                  <Badge variant="outline" className="px-1.5 py-0 text-[11px] font-normal">
                    Verified
                  </Badge>
                ) : null}
              </div>
              <div className="relative flex items-center">
                <Mail
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 size-4 text-muted-foreground"
                />
                <Input
                  id="profile-email"
                  type="email"
                  value={staff.email ?? 'Signed-in staff account'}
                  readOnly
                  aria-readonly="true"
                  className="bg-muted/20 pl-9 text-muted-foreground"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Used for signing in and receiving staff notifications.
              </p>
            </div>
          </div>

          {message ? (
            <div className="border-t border-border/70 bg-muted/10 px-5 py-3">
              <p role="status" className="text-xs text-muted-foreground">
                {message}
              </p>
            </div>
          ) : null}
        </form>
      </section>

      <section
        aria-labelledby="site-access-heading"
        className="overflow-hidden rounded-xl border border-border/80 bg-card/30"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="size-4 text-muted-foreground" aria-hidden="true" />
            <div>
              <h2 id="site-access-heading" className="text-sm font-medium text-foreground">
                Site access
              </h2>
              <p className="text-xs text-muted-foreground">
                Your permissions on {workspace?.name ?? workspaceSlug}.
              </p>
            </div>
          </div>
          <span className="text-xs text-muted-foreground">
            {roles.includes('owner') ? 'Full site access' : 'Role-based access'}
          </span>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 text-sm">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Assigned roles</span>
            <div className="flex flex-wrap items-center gap-1.5">
              {roles.length > 0 ? (
                roles.map((role) => (
                  <Badge key={role} variant="secondary">
                    {ROLE_LABELS[role]}
                  </Badge>
                ))
              ) : (
                <span className="text-xs text-muted-foreground">Viewer</span>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-1 sm:text-right">
            <span className="text-xs font-medium text-muted-foreground">Active sites</span>
            <span className="text-xs text-foreground">
              {staff.workspaces.map((item) => item.name).join(', ') || workspaceSlug}
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}
