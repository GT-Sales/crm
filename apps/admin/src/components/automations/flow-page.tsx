'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type JSX } from 'react';
import {
  EMPTY_FLOW_DRAFT,
  automationKeySchema,
  flowDefinitionSchemaFor,
  flowDraftSchemaFor,
  walkDraftSteps,
  type AutomationKey,
  type FlowCatalogResponse,
  type FlowDefinition,
  type FlowDetailResponse,
  type FlowDraft,
  type FlowDraftStep,
  type FlowDraftTrigger,
  type FlowIssue,
  type FlowOverlapWarning,
  type FlowRun,
  type FlowStepKind,
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
  BackendError,
  activateAutomation,
  archiveAutomation,
  discardAutomationDraft,
  getAutomation,
  getAutomationCatalog,
  getAutomationVersion,
  listAutomationRuns,
  listAutomations,
  resetAutomation,
  restoreAutomation,
  saveAutomationDraft,
  updateAutomation,
} from '../../lib/api';
import { useResource } from '../../lib/use-resource';
import { useStaffSession } from '../staff-session-provider';
import { AutomationRuns } from './automation-runs';
import { FlowSwitch, NEEDS_INTEGRATIONS, StatusChip, changeError } from './automations-list';
import {
  definitionToDraft,
  findStepById,
  insertStepAt,
  removeStepById,
  updateStepById,
} from './canvas/draft-mutations';
import { FlowCanvas } from './canvas/flow-canvas';
import { StepSidePanel } from './canvas/step-side-panel';
import { FlowListView } from './flow-list-view';
import { namesFromCatalog, namesFromCode, type FlowNames } from './flow-words';

const SIGNED_OUT = 'You are signed out. Sign in again to continue.';
const AUTOSAVE_DELAY_MS = 600;
export const NEEDS_LEADS_FOR_ACTIVATION =
  'Activating a flow that changes leads or creates tasks needs the Leads role (the owner has it).';
export const CONFLICT_RELOAD_MESSAGE =
  'Someone else changed this flow. Reload to see their changes.';

interface FlowPageData {
  detail: FlowDetailResponse;
  catalog: FlowCatalogResponse | undefined;
  runs: FlowRun[];
  runsNextBefore: string | null;
  warnings: FlowOverlapWarning[];
}

type SaveStatus = 'idle' | 'unsaved' | 'saving' | 'saved' | 'conflict' | 'error';

function hasLeadChangingDraftStep(steps: readonly FlowDraftStep[]): boolean {
  let found = false;
  walkDraftSteps(steps, (step) => {
    if (step.kind === 'assign_lead' || step.kind === 'update_lead' || step.kind === 'create_task') {
      found = true;
    }
  });
  return found;
}

function initialDraftFromDetail(detail: FlowDetailResponse): FlowDraft {
  if (detail.draft?.definition) return definitionToDraft(detail.draft.definition);
  if (detail.active?.definition) return definitionToDraft(detail.active.definition);
  return EMPTY_FLOW_DRAFT;
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
 * One automation flow's page (Step B): its visual canvas editor with a
 * right-hand side panel, an accessible "List view" toggle, version controls
 * (Save draft, Activate, Discard draft, Reset to default for built-ins,
 * historical version viewer), and the Runs tab with expandable step-by-step
 * outcomes.
 */
export function FlowPage({
  workspaceSlug,
  flowKey,
}: {
  workspaceSlug: string;
  flowKey: string;
}): JSX.Element {
  const staff = useStaffSession();
  const workspace = staff.workspaces.find((item) => item.slug === workspaceSlug);
  const workspaceId = workspace?.id;
  const accessToken = staff.accessToken;
  const canManageLeads =
    workspace?.roles.some((role) => role === 'owner' || role === 'leads') ?? false;

  const permissionNoteId = useId();
  const activateReasonId = useId();
  const parsedKey = automationKeySchema.safeParse(flowKey);
  const key: AutomationKey | undefined = parsedKey.success ? parsedKey.data : undefined;

  const load = useMemo(
    () =>
      accessToken && workspaceId && key
        ? async (): Promise<FlowPageData> => {
            const [detail, catalog, runsPage, list] = await Promise.all([
              getAutomation(accessToken, workspaceId, key),
              getAutomationCatalog(accessToken, workspaceId).catch(() => undefined),
              listAutomationRuns(accessToken, workspaceId, key),
              typeof listAutomations === 'function'
                ? listAutomations(accessToken, workspaceId).catch(() => undefined)
                : Promise.resolve(undefined),
            ]);
            const warnings = (list?.warnings ?? []).filter((warning) =>
              warning.flows.some((flow) => flow.key === key),
            );
            return {
              detail,
              catalog,
              runs: runsPage.runs,
              runsNextBefore: runsPage.nextBefore,
              warnings,
            };
          }
        : undefined,
    [accessToken, workspaceId, key],
  );
  const { data, error, reload, mutate } = useResource(load);
  const names: FlowNames = useMemo(
    () => (data?.catalog ? namesFromCatalog(data.catalog) : namesFromCode()),
    [data?.catalog],
  );

  const [activeTab, setActiveTab] = useState<'flow' | 'runs'>('flow');
  const [viewMode, setViewMode] = useState<'canvas' | 'list'>('canvas');
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [localDraft, setLocalDraft] = useState<FlowDraft>();
  const [isDirty, setIsDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [saveErrorText, setSaveErrorText] = useState<string>();
  const [infoNotice, setInfoNotice] = useState<string>();
  const [confirmingActivate, setConfirmingActivate] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [viewingHistoryVersion, setViewingHistoryVersion] = useState<{
    version: number;
    definition: FlowDefinition | FlowDraft | null;
  }>();
  const [loadingMoreRuns, setLoadingMoreRuns] = useState(false);

  const revisionRef = useRef<number>(0);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!data?.detail) return;
    revisionRef.current = data.detail.revision;
    if (!isDirty) {
      setLocalDraft(initialDraftFromDetail(data.detail));
    }
  }, [data?.detail, isDirty]);

  useEffect(
    () => () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    },
    [],
  );

  const replaceDetail = useCallback(
    (detail: FlowDetailResponse, resetLocal = false) => {
      revisionRef.current = detail.revision;
      mutate((current) => ({ ...current, detail }));
      if (resetLocal) {
        setLocalDraft(initialDraftFromDetail(detail));
        setIsDirty(false);
      }
    },
    [mutate],
  );

  const persistDraft = useCallback(
    async (draftToSave: FlowDraft): Promise<FlowDetailResponse | undefined> => {
      if (!accessToken || !workspaceId || !key || typeof saveAutomationDraft !== 'function') {
        return undefined;
      }
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
      setSaveStatus('saving');
      setSaveErrorText(undefined);
      try {
        const updated = await saveAutomationDraft(accessToken, workspaceId, key, {
          expectedRevision: revisionRef.current,
          definition: draftToSave,
        });
        revisionRef.current = updated.revision;
        mutate((current) => ({ ...current, detail: updated }));
        setIsDirty(false);
        setSaveStatus('saved');
        return updated;
      } catch (caught) {
        if (caught instanceof BackendError && caught.code === 'version_conflict') {
          setSaveStatus('conflict');
          setSaveErrorText(CONFLICT_RELOAD_MESSAGE);
          return undefined;
        }
        setSaveStatus('error');
        setSaveErrorText(changeError(caught, 'The draft was not saved'));
        return undefined;
      }
    },
    [accessToken, workspaceId, key, mutate],
  );

  function scheduleAutosave(nextDraft: FlowDraft) {
    setLocalDraft(nextDraft);
    setIsDirty(true);
    setSaveStatus('unsaved');
    setSaveErrorText(undefined);
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      void persistDraft(nextDraft);
    }, AUTOSAVE_DELAY_MS);
  }

  function closePanelAndFocusNode(nodeId: string | undefined) {
    setSelectedNodeId(undefined);
    if (!nodeId) return;
    setTimeout(() => {
      const el = document.querySelector<HTMLElement>(`[data-node-id="${nodeId}"]`);
      el?.focus();
    }, 0);
  }

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
      replaceDetail(await archiveAutomation(accessToken, workspaceId, key), true);
      return undefined;
    } catch (caught) {
      return changeError(caught, 'The flow was not archived');
    }
  }

  async function onRestore(): Promise<string | undefined> {
    if (!accessToken || !workspaceId || !key) return SIGNED_OUT;
    try {
      replaceDetail(await restoreAutomation(accessToken, workspaceId, key), true);
      return undefined;
    } catch (caught) {
      return changeError(caught, 'The flow was not restored');
    }
  }

  async function handleActivate(): Promise<void> {
    if (!accessToken || !workspaceId || !key || !data) return;
    const draftToActivate = localDraft ?? initialDraftFromDetail(data.detail);
    setActionBusy(true);
    setActionError(undefined);
    try {
      if ((isDirty || data.detail.draft === null) && typeof saveAutomationDraft === 'function') {
        const saved = await persistDraft(draftToActivate);
        if (!saved) {
          setActionBusy(false);
          return;
        }
      }
      const activated = await activateAutomation(accessToken, workspaceId, key, {
        expectedRevision: revisionRef.current,
      });
      replaceDetail(activated, true);
      setSaveStatus('saved');
      setConfirmingActivate(false);
    } catch (caught) {
      if (caught instanceof BackendError && caught.code === 'version_conflict') {
        setActionError(CONFLICT_RELOAD_MESSAGE);
      } else {
        setActionError(changeError(caught, 'The flow was not activated'));
      }
    } finally {
      setActionBusy(false);
    }
  }

  async function handleDiscardDraft(): Promise<void> {
    if (!accessToken || !workspaceId || !key || !data) return;
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    setActionBusy(true);
    setActionError(undefined);
    try {
      if (data.detail.draft !== null && typeof discardAutomationDraft === 'function') {
        const updated = await discardAutomationDraft(accessToken, workspaceId, key);
        replaceDetail(updated, true);
      } else {
        setLocalDraft(initialDraftFromDetail(data.detail));
        setIsDirty(false);
      }
      setSaveStatus('idle');
      setSelectedNodeId(undefined);
    } catch (caught) {
      setActionError(changeError(caught, 'The draft was not discarded'));
    } finally {
      setActionBusy(false);
    }
  }

  async function handleResetBuiltIn(): Promise<void> {
    if (!accessToken || !workspaceId || !key) return;
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    setActionBusy(true);
    setActionError(undefined);
    try {
      const updated = await resetAutomation(accessToken, workspaceId, key);
      replaceDetail(updated, true);
      setSaveStatus('saved');
      setSelectedNodeId(undefined);
    } catch (caught) {
      setActionError(changeError(caught, 'The flow was not reset'));
    } finally {
      setActionBusy(false);
    }
  }

  async function handleSelectVersion(value: string): Promise<void> {
    if (value === 'editor' || !accessToken || !workspaceId || !key) {
      setViewingHistoryVersion(undefined);
      return;
    }
    const verNum = Number(value);
    if (!Number.isFinite(verNum)) return;
    try {
      const response = await getAutomationVersion(accessToken, workspaceId, key, verNum);
      const parsed = flowDraftSchemaFor('builtin').safeParse(response.version.definition);
      setViewingHistoryVersion({
        version: verNum,
        definition: parsed.success ? parsed.data : null,
      });
      setSelectedNodeId(undefined);
    } catch (caught) {
      setActionError(changeError(caught, 'The version could not be loaded'));
    }
  }

  async function handleLoadMoreRuns(): Promise<void> {
    if (!accessToken || !workspaceId || !key || !data?.runsNextBefore) return;
    setLoadingMoreRuns(true);
    try {
      const page = await listAutomationRuns(accessToken, workspaceId, key, {
        before: data.runsNextBefore,
      });
      mutate((current) => ({
        ...current,
        runs: [...current.runs, ...page.runs],
        runsNextBefore: page.nextBefore,
      }));
    } catch (caught) {
      setActionError(changeError(caught, 'More runs could not be loaded'));
    } finally {
      setLoadingMoreRuns(false);
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
  const canEdit = detail.canManage && !flow.archived && viewingHistoryVersion === undefined;
  const workingDraft = localDraft ?? initialDraftFromDetail(detail);

  const displayedDefinition: FlowDefinition | FlowDraft | null = viewingHistoryVersion
    ? viewingHistoryVersion.definition
    : canEdit
      ? workingDraft
      : (detail.active?.definition ?? detail.draft?.definition ?? null);

  const currentIssues: readonly FlowIssue[] = viewingHistoryVersion
    ? []
    : (detail.draft?.issues ?? (flow.needsAttention ? [flow.needsAttention] : []));

  const validForActivation = flowDefinitionSchemaFor(flow.origin).safeParse(workingDraft).success;
  const needsLeadsPermission = hasLeadChangingDraftStep(workingDraft.steps) && !canManageLeads;
  const hasSiteIssues = (detail.draft?.issues.length ?? 0) > 0 && !isDirty;
  const activateDisabled =
    !canEdit || actionBusy || needsLeadsPermission || !validForActivation || hasSiteIssues;
  const activateDisabledReason = !detail.canManage
    ? NEEDS_INTEGRATIONS
    : needsLeadsPermission
      ? NEEDS_LEADS_FOR_ACTIVATION
      : !validForActivation
        ? 'Complete the trigger and every step before activating.'
        : hasSiteIssues
          ? 'Fix the items marked Needs attention before activating.'
          : undefined;

  const selectedStepInfo =
    selectedNodeId && selectedNodeId !== 'trigger' && displayedDefinition
      ? findStepById(displayedDefinition.steps, selectedNodeId)
      : undefined;

  const selectedIssues: FlowIssue[] = !selectedNodeId
    ? []
    : selectedNodeId === 'trigger'
      ? currentIssues.filter(
          (issue) =>
            issue.path === '' ||
            issue.path === 'steps' ||
            issue.path === 'trigger' ||
            issue.path.startsWith('trigger.'),
        )
      : selectedStepInfo
        ? currentIssues.filter(
            (issue) =>
              issue.path === selectedStepInfo.path ||
              issue.path.startsWith(`${selectedStepInfo.path}.`),
          )
        : [];

  const uncorruptedDefinition =
    detail.active === null ||
    detail.active.definition !== null ||
    (detail.draft !== null && detail.draft.definition !== null) ||
    isDirty;

  return (
    <div className="flex flex-col gap-6">
      {back}

      {data.warnings.map((warning) => (
        <p
          key={`${warning.event.kind}:${warning.event.leadType}:${
            warning.event.kind === 'stage_entered' ? warning.event.stage : ''
          }`}
          role="status"
          className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
        >
          {warning.message}
        </p>
      ))}

      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold">{flow.name}</h1>
          {flow.origin === 'builtin' ? <Badge variant="secondary">Built in</Badge> : null}
          {flow.archived ? <Badge variant="outline">Archived</Badge> : null}
          {viewingHistoryVersion ? (
            <Badge variant="outline">Viewing version {viewingHistoryVersion.version}</Badge>
          ) : detail.draft !== null || isDirty ? (
            <Badge variant="outline">Viewing draft</Badge>
          ) : flow.activeVersion !== null ? (
            <Badge variant="outline">Viewing active</Badge>
          ) : null}
        </div>
        {flow.description ? (
          <p className="text-sm text-muted-foreground">{flow.description}</p>
        ) : null}
        <div className="flex flex-wrap items-start gap-4">
          <FlowSwitch
            flow={flow}
            canManage={detail.canManage}
            permissionNoteId={permissionNoteId}
            onToggle={onToggle}
          />
          <p className="text-sm">
            {flow.activeVersion === null
              ? 'Not activated'
              : `Active, version ${flow.activeVersion}`}
          </p>
          <StatusChip flow={flow} hideNotActivated />
          {saveStatus === 'unsaved' ? (
            <span role="status" className="text-xs text-muted-foreground">
              Unsaved changes
            </span>
          ) : saveStatus === 'saving' ? (
            <span role="status" className="text-xs text-muted-foreground">
              Saving…
            </span>
          ) : saveStatus === 'saved' ? (
            <span role="status" className="text-xs text-muted-foreground">
              Saved
            </span>
          ) : null}
        </div>
        {detail.canManage ? null : (
          <p id={permissionNoteId} className="text-sm text-muted-foreground">
            {NEEDS_INTEGRATIONS}
          </p>
        )}
      </header>

      {saveErrorText ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <p role="alert" className="text-sm text-destructive">
            {saveErrorText}
          </p>
          {saveStatus === 'conflict' ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setIsDirty(false);
                setSaveStatus('idle');
                setSaveErrorText(undefined);
                void reload();
              }}
            >
              Reload
            </Button>
          ) : null}
        </div>
      ) : null}

      {actionError ? (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      ) : null}

      {infoNotice ? (
        <p
          role="status"
          className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
        >
          {infoNotice}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-2">
        <div role="tablist" aria-label="Flow sections" className="flex items-center gap-1">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'flow'}
            onClick={() => setActiveTab('flow')}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              activeTab === 'flow'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            Flow
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'runs'}
            onClick={() => setActiveTab('runs')}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              activeTab === 'runs'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            Runs ({data.runs.length})
          </button>
        </div>

        {activeTab === 'flow' ? (
          <div className="flex flex-wrap items-center gap-2">
            <div
              role="group"
              aria-label="Editor view"
              className="flex items-center rounded-md border p-0.5"
            >
              <Button
                type="button"
                size="sm"
                variant={viewMode === 'canvas' ? 'secondary' : 'ghost'}
                aria-pressed={viewMode === 'canvas'}
                onClick={() => setViewMode('canvas')}
              >
                Canvas view
              </Button>
              <Button
                type="button"
                size="sm"
                variant={viewMode === 'list' ? 'secondary' : 'ghost'}
                aria-pressed={viewMode === 'list'}
                onClick={() => setViewMode('list')}
              >
                List view
              </Button>
            </div>

            {detail.versions.length > 0 ? (
              <select
                aria-label="View version"
                value={viewingHistoryVersion ? String(viewingHistoryVersion.version) : 'editor'}
                onChange={(event) => void handleSelectVersion(event.target.value)}
                className="h-8 rounded-md border bg-background px-2 text-xs"
              >
                <option value="editor">
                  {detail.draft !== null || isDirty
                    ? 'Current draft'
                    : `Active (v${flow.activeVersion ?? 1})`}
                </option>
                {detail.versions.map((ver) => (
                  <option key={ver.version} value={String(ver.version)}>
                    Version {ver.version} ({ver.status})
                  </option>
                ))}
              </select>
            ) : null}

            {canEdit ? (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={saveStatus === 'saving' || actionBusy}
                  onClick={() => void persistDraft(workingDraft)}
                >
                  Save draft
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={activateDisabled}
                  aria-describedby={activateDisabledReason ? activateReasonId : undefined}
                  onClick={() => setConfirmingActivate(true)}
                >
                  Activate
                </Button>
                {detail.draft !== null || isDirty ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={actionBusy}
                    onClick={() => void handleDiscardDraft()}
                  >
                    Discard draft
                  </Button>
                ) : null}
                {flow.origin === 'builtin' ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={actionBusy}
                    onClick={() => void handleResetBuiltIn()}
                  >
                    Reset to default
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      {activeTab === 'flow' && canEdit && activateDisabledReason ? (
        <p id={activateReasonId} className="text-xs text-muted-foreground">
          {activateDisabledReason}
        </p>
      ) : null}

      {activeTab === 'flow' ? (
        <section aria-labelledby="flow-definition-heading" className="flex flex-col gap-3">
          <h2 id="flow-definition-heading" className="text-base font-semibold">
            What it does
          </h2>
          {!uncorruptedDefinition || displayedDefinition === null ? (
            <NoDefinition detail={detail} />
          ) : viewMode === 'list' ? (
            displayedDefinition.trigger === null && displayedDefinition.steps.length === 0 ? (
              <NoDefinition detail={detail} />
            ) : (
              <FlowListView definition={displayedDefinition} names={names} />
            )
          ) : (
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
              <div className="min-w-0 flex-1">
                {displayedDefinition.trigger === null && displayedDefinition.steps.length === 0 ? (
                  <p className="mb-2 text-sm text-muted-foreground">No trigger yet.</p>
                ) : null}
                <FlowCanvas
                  definition={displayedDefinition}
                  issues={currentIssues}
                  names={names}
                  readOnly={!canEdit}
                  selectedId={selectedNodeId}
                  onSelectNode={(id) => setSelectedNodeId(id)}
                  onAddStep={(sequencePath, index, kind: FlowStepKind) => {
                    if (!canEdit) return;
                    const inserted = insertStepAt(workingDraft, sequencePath, index, kind);
                    if (inserted.movedToYesCount > 0) {
                      setInfoNotice(
                        `Moved ${inserted.movedToYesCount} following step${
                          inserted.movedToYesCount === 1 ? '' : 's'
                        } into the Yes branch (If/else is always the last step of its path).`,
                      );
                    } else {
                      setInfoNotice(undefined);
                    }
                    scheduleAutosave(inserted.draft);
                    setSelectedNodeId(inserted.stepId);
                  }}
                />
              </div>

              {selectedNodeId && (selectedNodeId === 'trigger' || selectedStepInfo) ? (
                <StepSidePanel
                  workspaceSlug={workspaceSlug}
                  selectedId={selectedNodeId}
                  trigger={displayedDefinition.trigger}
                  step={selectedStepInfo?.step}
                  issues={selectedIssues}
                  catalog={data.catalog}
                  readOnly={!canEdit}
                  onUpdateTrigger={(nextTrigger: FlowDraftTrigger) => {
                    if (!canEdit) return;
                    scheduleAutosave({ ...workingDraft, trigger: nextTrigger });
                  }}
                  onUpdateStep={(stepId, updater) => {
                    if (!canEdit) return;
                    scheduleAutosave(updateStepById(workingDraft, stepId, updater));
                  }}
                  onRemoveStep={(stepId) => {
                    if (!canEdit) return;
                    scheduleAutosave(removeStepById(workingDraft, stepId));
                    closePanelAndFocusNode('trigger');
                  }}
                  onClose={() => closePanelAndFocusNode(selectedNodeId)}
                />
              ) : null}
            </div>
          )}
        </section>
      ) : null}

      <section aria-labelledby="flow-runs-heading" className="flex flex-col gap-3">
        <h2 id="flow-runs-heading" className="text-base font-semibold">
          Recent runs
        </h2>
        <AutomationRuns
          workspaceSlug={workspaceSlug}
          runs={data.runs}
          definition={detail.active?.definition ?? workingDraft}
          names={names}
          nextBefore={data.runsNextBefore}
          loadingMore={loadingMoreRuns}
          onLoadMore={handleLoadMoreRuns}
        />
      </section>

      {flow.origin === 'custom' && detail.canManage ? (
        <ArchiveControl detail={detail} onArchive={onArchive} onRestore={onRestore} />
      ) : null}

      <Dialog
        open={confirmingActivate}
        onOpenChange={(open) => !open && setConfirmingActivate(false)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Activate {flow.name}?</DialogTitle>
            <DialogDescription>
              This publishes your draft as the active version of {flow.name}.
            </DialogDescription>
          </DialogHeader>
          {actionError ? (
            <p role="alert" className="text-sm text-destructive">
              {actionError}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={actionBusy}
              onClick={() => setConfirmingActivate(false)}
            >
              Cancel
            </Button>
            <Button type="button" disabled={actionBusy} onClick={() => void handleActivate()}>
              {actionBusy ? 'Activating…' : 'Activate'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
