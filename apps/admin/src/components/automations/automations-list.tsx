'use client';

import { useId, useRef, useState, type JSX } from 'react';
import type {
  Automation,
  AutomationKey,
  AutomationRun,
  ListAutomationsResponse,
} from '@gt-sales/contracts';
import { Button, cn } from '@gt-sales/ui';
import { ChevronDownIcon } from 'lucide-react';
import Link from 'next/link';

import { BackendError, listAutomationRuns, updateAutomation } from '../../lib/api';
import { dateTimeLabel, relativeTime } from '../../lib/dates';
import { errorReason } from '../../lib/use-resource';
import { useStaffSession } from '../staff-session-provider';
import { AutomationRuns } from './automation-runs';
import { useAutomations } from './use-automations';

const OWNER_ONLY = 'Only the site owner can switch automations.';
const SIGNED_OUT = 'You are signed out. Sign in again to continue.';

/** Why a switch did not take, in words staff can act on. */
function toggleError(error: unknown): string {
  if (error instanceof BackendError && error.code === 'permission_denied') return OWNER_ONLY;
  return `The change was not saved. Reason: ${errorReason(error)}.`;
}

type RunsState =
  | { status: 'loading' }
  | { status: 'loaded'; runs: AutomationRun[] }
  | { status: 'failed'; reason: string };

function AutomationRow({
  workspaceSlug,
  automation,
  canManage,
  ownerOnlyNoteId,
  onToggle,
  loadRuns,
}: {
  workspaceSlug: string;
  automation: Automation;
  canManage: boolean;
  ownerOnlyNoteId: string;
  onToggle(key: AutomationKey, enabled: boolean): Promise<string | undefined>;
  loadRuns(key: AutomationKey): Promise<AutomationRun[]>;
}): JSX.Element {
  const labelId = useId();
  const runsId = useId();
  // The value being saved, shown until the backend answers; after that the
  // switch reads the rule as last confirmed (the saved one, or the old one).
  const [saving, setSaving] = useState<boolean>();
  const [notice, setNotice] = useState<string>();
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<RunsState>({ status: 'loading' });
  // Only the newest opening's answer is shown.
  const runsRequest = useRef(0);

  const pending = saving !== undefined;
  const enabled = saving ?? automation.enabled;

  async function toggle() {
    if (!canManage || pending) return;
    const next = !automation.enabled;
    setNotice(undefined);
    setSaving(next);
    const reason = await onToggle(automation.key, next);
    setSaving(undefined);
    if (reason !== undefined) setNotice(reason);
  }

  function toggleRuns() {
    const request = ++runsRequest.current;
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setRuns({ status: 'loading' });
    loadRuns(automation.key).then(
      (loaded) => {
        if (runsRequest.current === request) setRuns({ status: 'loaded', runs: loaded });
      },
      (caught: unknown) => {
        if (runsRequest.current === request) {
          setRuns({ status: 'failed', reason: errorReason(caught) });
        }
      },
    );
  }

  return (
    <li className="flex flex-col gap-3 px-4 py-3">
      <div className="flex items-start gap-3">
        <p id={labelId} className="mr-auto text-sm font-medium">
          {automation.label}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={automation.label}
            aria-describedby={canManage ? undefined : ownerOnlyNoteId}
            aria-disabled={pending || undefined}
            disabled={!canManage}
            onClick={() => void toggle()}
            className={cn(
              'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
              enabled ? 'bg-primary' : 'bg-input',
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'pointer-events-none block size-5 rounded-full bg-background shadow transition-transform',
                enabled ? 'translate-x-5' : 'translate-x-0',
              )}
            />
          </button>
          <span aria-hidden="true" className="w-6 text-sm text-muted-foreground">
            {enabled ? 'On' : 'Off'}
          </span>
        </div>
      </div>

      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <div className="flex gap-2">
          <dt className="text-muted-foreground">Last run</dt>
          <dd>
            {automation.lastRunAt === null ? (
              'Never'
            ) : (
              <time dateTime={automation.lastRunAt} title={dateTimeLabel(automation.lastRunAt)}>
                {relativeTime(automation.lastRunAt)}
              </time>
            )}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted-foreground">Emails queued</dt>
          <dd>{automation.runCount}</dd>
        </div>
      </dl>

      {notice ? (
        <p role="alert" className="text-sm text-destructive">
          {notice}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-4">
        <Link
          className="text-sm font-medium underline"
          href={`/w/${workspaceSlug}/settings/email?template=${automation.action.template}`}
          aria-describedby={labelId}
        >
          Edit the email
        </Link>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-expanded={open}
          aria-controls={runsId}
          aria-describedby={labelId}
          onClick={toggleRuns}
        >
          Recent runs
          <ChevronDownIcon
            aria-hidden="true"
            className={cn('transition-transform', open ? 'rotate-180' : '')}
          />
        </Button>
      </div>

      <div id={runsId} hidden={!open}>
        {!open ? null : runs.status === 'loading' ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading the recent runs…
          </p>
        ) : runs.status === 'failed' ? (
          <p role="alert" className="text-sm text-destructive">
            The recent runs could not be loaded. Reason: {runs.reason}.
          </p>
        ) : (
          <AutomationRuns workspaceSlug={workspaceSlug} runs={runs.runs} />
        )}
      </div>
    </li>
  );
}

/**
 * The site's built-in rules, one row each: the rule, its on/off switch, when it
 * last ran, how many emails it has queued, a link to its email and its recent
 * runs, loaded when opened. Only members with `canManage` (the owner) can use
 * the switches; everyone else reads the page.
 */
export function AutomationsList({
  workspaceSlug,
  data,
  onToggle,
  loadRuns,
}: {
  workspaceSlug: string;
  data: ListAutomationsResponse;
  onToggle(key: AutomationKey, enabled: boolean): Promise<string | undefined>;
  loadRuns(key: AutomationKey): Promise<AutomationRun[]>;
}): JSX.Element {
  const ownerOnlyNoteId = useId();
  return (
    <div className="flex flex-col gap-4">
      {data.hasSender ? null : (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          Switch an email on once Settings → Email is saved; until then every run is skipped.
        </p>
      )}
      {data.canManage ? null : (
        <p id={ownerOnlyNoteId} className="text-sm text-muted-foreground">
          {OWNER_ONLY}
        </p>
      )}
      <ul aria-label="Automations" className="divide-y rounded-md border">
        {data.automations.map((automation) => (
          <AutomationRow
            key={automation.key}
            workspaceSlug={workspaceSlug}
            automation={automation}
            canManage={data.canManage}
            ownerOnlyNoteId={ownerOnlyNoteId}
            onToggle={onToggle}
            loadRuns={loadRuns}
          />
        ))}
      </ul>
    </div>
  );
}

/** The Automations page's content for one site: its rules, loaded and wired to the backend. */
export function SiteAutomations({ workspaceSlug }: { workspaceSlug: string }): JSX.Element {
  const staff = useStaffSession();
  const workspaceId = staff.workspaces.find((item) => item.slug === workspaceSlug)?.id;
  const accessToken = staff.accessToken;
  const { data, reload, replace, error } = useAutomations(workspaceId);

  async function onToggle(key: AutomationKey, enabled: boolean): Promise<string | undefined> {
    if (!accessToken || !workspaceId) return SIGNED_OUT;
    try {
      const { automation } = await updateAutomation(accessToken, workspaceId, key, { enabled });
      replace(automation);
      return undefined;
    } catch (caught) {
      return toggleError(caught);
    }
  }

  async function loadRuns(key: AutomationKey): Promise<AutomationRun[]> {
    if (!accessToken || !workspaceId) throw new Error('signed out');
    return (await listAutomationRuns(accessToken, workspaceId, key)).runs;
  }

  if (!data) {
    return error ? (
      <div className="flex flex-col items-start gap-2">
        <p role="alert" className="text-sm text-destructive">
          The automations could not be loaded. Reason: {error}.
        </p>
        <Button type="button" size="sm" variant="outline" onClick={() => void reload()}>
          Try again
        </Button>
      </div>
    ) : (
      <p className="text-sm text-muted-foreground" aria-busy="true">
        Loading the automations…
      </p>
    );
  }

  return (
    <AutomationsList
      workspaceSlug={workspaceSlug}
      data={data}
      onToggle={onToggle}
      loadRuns={loadRuns}
    />
  );
}
