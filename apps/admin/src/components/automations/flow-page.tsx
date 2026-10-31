'use client';

import { useCallback, useId, useMemo, useState, type JSX } from 'react';
import {
  automationKeySchema,
  type AutomationKey,
  type FlowCatalogResponse,
  type FlowDetailResponse,
  type FlowRun,
} from '@gt-sales/contracts';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@gt-sales/ui';
import Link from 'next/link';

import {
  archiveAutomation,
  getAutomation,
  getAutomationCatalog,
  listAutomationRuns,
  restoreAutomation,
  updateAutomation,
} from '../../lib/api';
import { useResource } from '../../lib/use-resource';
import { useStaffSession } from '../staff-session-provider';
import { AutomationRuns } from './automation-runs';
import { FlowSwitch, NEEDS_INTEGRATIONS, StatusChip, changeError } from './automations-list';
import { FlowListView } from './flow-list-view';
import { namesFromCatalog, namesFromCode, type FlowNames } from './flow-words';

const SIGNED_OUT = 'You are signed out. Sign in again to continue.';

interface FlowPageData {
  detail: FlowDetailResponse;
  catalog: FlowCatalogResponse | undefined;
  runs: FlowRun[];
}

/** What the page shows where the active definition would be, when there is none to show. */
function NoDefinition({ detail }: { detail: FlowDetailResponse }): JSX.Element {
  const text =
    detail.active !== null
      ? 'This version can no longer be read. Check the flow for what changed.'
      : detail.draft?.definition?.trigger
        ? 'Not activated yet.'
        : 'No trigger yet.';
  return <p className="text-sm text-muted-foreground">{text}</p>;
}

/** Archive (or Restore) a custom flow, after asking. */
function ArchiveControl({
  detail,
  onArchive,
  onRestore,
}: {
  detail: FlowDetailResponse;
  onArchive(): Promise<string | undefined>;
  onRestore(): Promise<string | undefined>;
}): JSX.Element {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const { name, archived } = detail.automation;

  async function run(action: () => Promise<string | undefined>) {
    setBusy(true);
    setMessage(undefined);
    const refusal = await action();
    setBusy(false);
    if (refusal !== undefined) setMessage(refusal);
    else setAsking(false);
  }

  return (
    <div className="flex flex-col gap-2">
      {archived ? (
        <div>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void run(onRestore)}
          >
            Restore
          </Button>
        </div>
      ) : (
        <div>
          <Button type="button" variant="outline" onClick={() => setAsking(true)}>
            Archive
          </Button>
        </div>
      )}
      {message && !asking ? (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      ) : null}
      <Dialog open={asking} onOpenChange={(open) => !open && setAsking(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive {name}?</DialogTitle>
            <DialogDescription>
              The flow is switched off first: its waiting runs are cancelled and it sends nothing
              more. You can restore it later; it comes back off.
            </DialogDescription>
          </DialogHeader>
          {message ? (
            <p role="alert" className="text-sm text-destructive">
              {message}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setAsking(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => void run(onArchive)}
            >
              {busy ? 'Archiving…' : 'Archive'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * One flow, read-only (Step A): its name, "Built in" for the six, its switch,
 * which version is active, its status chip, the active definition as a list
 * (the draft is only mentioned: the editor arrives in a later release), its
 * latest runs, and for a custom flow Archive or Restore.
 */
export function FlowPage({
  workspaceSlug,
  flowKey,
}: {
  workspaceSlug: string;
  flowKey: string;
}): JSX.Element {
  const staff = useStaffSession();
  const workspaceId = staff.workspaces.find((item) => item.slug === workspaceSlug)?.id;
  const accessToken = staff.accessToken;
  const permissionNoteId = useId();
  const parsedKey = automationKeySchema.safeParse(flowKey);
  const key: AutomationKey | undefined = parsedKey.success ? parsedKey.data : undefined;

  const load = useMemo(
    () =>
      accessToken && workspaceId && key
        ? async (): Promise<FlowPageData> => {
            const [detail, catalog, runs] = await Promise.all([
              getAutomation(accessToken, workspaceId, key),
              // The names are a nicety: the page still opens without them.
              getAutomationCatalog(accessToken, workspaceId).catch(() => undefined),
              listAutomationRuns(accessToken, workspaceId, key),
            ]);
            return { detail, catalog, runs: runs.runs };
          }
        : undefined,
    [accessToken, workspaceId, key],
  );
  const { data, error, reload, mutate } = useResource(load);
  const names: FlowNames = useMemo(
    () => (data?.catalog ? namesFromCatalog(data.catalog) : namesFromCode()),
    [data?.catalog],
  );

  const replaceDetail = useCallback(
    (detail: FlowDetailResponse) => mutate((current) => ({ ...current, detail })),
    [mutate],
  );

  async function onToggle(_key: AutomationKey, enabled: boolean): Promise<string | undefined> {
    if (!accessToken || !workspaceId || !key) return SIGNED_OUT;
    try {
      const { automation } = await updateAutomation(accessToken, workspaceId, key, { enabled });
      mutate((current) => ({ ...current, detail: { ...current.detail, automation } }));
      return undefined;
    } catch (caught) {
      return changeError(caught);
    }
  }

  async function onArchive(): Promise<string | undefined> {
    if (!accessToken || !workspaceId || !key) return SIGNED_OUT;
    try {
      replaceDetail(await archiveAutomation(accessToken, workspaceId, key));
      return undefined;
    } catch (caught) {
      return changeError(caught, 'The flow was not archived');
    }
  }

  async function onRestore(): Promise<string | undefined> {
    if (!accessToken || !workspaceId || !key) return SIGNED_OUT;
    try {
      replaceDetail(await restoreAutomation(accessToken, workspaceId, key));
      return undefined;
    } catch (caught) {
      return changeError(caught, 'The flow was not restored');
    }
  }

  const back = (
    <Link className="text-sm underline" href={`/w/${workspaceSlug}/automations`}>
      All automations
    </Link>
  );

  if (!key) {
    return (
      <div className="flex flex-col gap-3">
        {back}
        <p role="alert" className="text-sm text-destructive">
          There is no such automation on this site.
        </p>
      </div>
    );
  }

  if (!data) {
    return error ? (
      <div className="flex flex-col items-start gap-2">
        {back}
        <p role="alert" className="text-sm text-destructive">
          The automation could not be loaded. Reason: {error}.
        </p>
        <Button type="button" size="sm" variant="outline" onClick={() => void reload()}>
          Try again
        </Button>
      </div>
    ) : (
      <p className="text-sm text-muted-foreground" aria-busy="true">
        Loading the automation…
      </p>
    );
  }

  const { detail } = data;
  const flow = detail.automation;
  return (
    <div className="flex flex-col gap-6">
      {back}
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold">{flow.name}</h1>
          {flow.origin === 'builtin' ? <Badge variant="secondary">Built in</Badge> : null}
          {flow.archived ? <Badge variant="outline">Archived</Badge> : null}
        </div>
        {flow.description ? (
          <p className="text-sm text-muted-foreground">{flow.description}</p>
        ) : null}
        <div className="flex flex-wrap items-start gap-4">
          <FlowSwitch
            flow={flow}
            canManage={detail.canManage && !flow.archived}
            permissionNoteId={permissionNoteId}
            onToggle={onToggle}
          />
          <p className="text-sm">
            {flow.activeVersion === null
              ? 'Not activated'
              : `Active, version ${flow.activeVersion}`}
          </p>
          <StatusChip flow={flow} hideNotActivated />
        </div>
        {detail.canManage ? null : (
          <p id={permissionNoteId} className="text-sm text-muted-foreground">
            {NEEDS_INTEGRATIONS}
          </p>
        )}
      </header>

      {detail.draft ? (
        <p className="rounded-md border p-3 text-sm text-muted-foreground">
          There are draft changes; the editor arrives in a later release.
        </p>
      ) : null}

      <section aria-labelledby="flow-definition-heading" className="flex flex-col gap-3">
        <h2 id="flow-definition-heading" className="text-base font-semibold">
          What it does
        </h2>
        {detail.active?.definition ? (
          <FlowListView definition={detail.active.definition} names={names} />
        ) : (
          <NoDefinition detail={detail} />
        )}
      </section>

      <section aria-labelledby="flow-runs-heading" className="flex flex-col gap-3">
        <h2 id="flow-runs-heading" className="text-base font-semibold">
          Recent runs
        </h2>
        <AutomationRuns workspaceSlug={workspaceSlug} runs={data.runs} />
      </section>

      {flow.origin === 'custom' && detail.canManage ? (
        <ArchiveControl detail={detail} onArchive={onArchive} onRestore={onRestore} />
      ) : null}
    </div>
  );
}
