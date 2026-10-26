'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Button, Input, Label } from '@gt-sales/ui';

import { updateStaffProfile } from '../lib/api';
import { errorReason } from '../lib/use-resource';
import { useLeadWorkspace } from './leads/use-lead-workspace';

/**
 * The name colleagues see on assignments, tasks and the timeline. It is set
 * once and applies on every site the person belongs to; it is never the
 * email address.
 */
export function DisplayNameForm({ workspaceSlug }: { workspaceSlug: string }) {
  const { accessToken, members, reloadMembers } = useLeadWorkspace(workspaceSlug);
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
      setMessage(`Not saved. Reason: ${errorReason(error)}.`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="display-name-heading" className="flex flex-col gap-3">
      <div>
        <h2 id="display-name-heading" className="text-base font-semibold">
          Your name
        </h2>
        <p className="text-sm text-muted-foreground">
          {current
            ? 'Shown to colleagues on assignments, tasks and the timeline, on every site.'
            : 'Colleagues see your role until you set a name. It applies on every site.'}
        </p>
      </div>
      <form onSubmit={(event) => void submit(event)} className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-0 flex-[1_1_16rem] flex-col gap-1.5">
          <Label htmlFor="display-name">Display name</Label>
          <Input
            id="display-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            placeholder="e.g. Takib"
            autoComplete="name"
          />
        </div>
        <Button type="submit" disabled={saving || !name.trim() || name.trim() === current}>
          {saving ? 'Saving…' : 'Save name'}
        </Button>
      </form>
      {message ? (
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      ) : null}
    </section>
  );
}
