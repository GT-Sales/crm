'use client';

import { useId, useRef, useState, type FormEvent, type JSX } from 'react';
import {
  AUTOMATION_MAX_FLOWS,
  type AutomationKey,
  type FlowListResponse,
  type FlowSummary,
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
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from '@gt-sales/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import {
  BackendError,
  createAutomation,
  listAutomations,
  restoreAutomation,
  updateAutomation,
} from '../../lib/api';
import { dateTimeLabel, relativeTime } from '../../lib/dates';
import { errorReason } from '../../lib/use-resource';
import { useStaffSession } from '../staff-session-provider';
import { describeTrigger, flowStatusChip, namesFromCode } from './flow-words';
import { useAutomations } from './use-automations';

export const NEEDS_INTEGRATIONS = 'This needs the Integrations permission (the owner has it).';
export const ACTIVATE_FIRST = 'Activate the flow first.';
const SIGNED_OUT = 'You are signed out. Sign in again to continue.';
const LIMIT_REACHED = `This site already has ${AUTOMATION_MAX_FLOWS} flows. Archive one first.`;

const names = namesFromCode();

/** Why a change did not take, in words staff can act on. */
export function changeError(error: unknown, what = 'The change was not saved'): string {
  if (error instanceof BackendError && error.code === 'permission_denied') {
    return NEEDS_INTEGRATIONS;
  }
  if (error instanceof BackendError && error.code === 'automation_limit_reached') {
    return LIMIT_REACHED;
  }
  if (error instanceof BackendError && error.code === 'no_active_version') return ACTIVATE_FIRST;
  return `${what}. Reason: ${errorReason(error)}.`;
}

export function StatusChip({
  flow,
  hideNotActivated = false,
}: {
  flow: FlowSummary;
  /** The flow page says "Not activated" beside it already. */
  hideNotActivated?: boolean;
}): JSX.Element | null {
  const chip = flowStatusChip(flow);
  if (!chip || (hideNotActivated && flow.activeVersion === null && !flow.needsAttention)) {
    return null;
  }
  return (
    <Badge
      variant="outline"
      className={cn(
        'whitespace-normal text-left',
        chip.tone === 'warning'
          ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100'
          : '',
      )}
    >
      {chip.label}
    </Badge>
  );
}

/**
 * A flow's labelled on/off switch. It reads the flow as last confirmed and
 * shows the value being saved until the backend answers; without
 * `canManage`, or before the flow has an active version, it is disabled with
 * the note that says why.
 */
export function FlowSwitch({
  flow,
  canManage,
  permissionNoteId,
  onToggle,
}: {
  flow: FlowSummary;
  canManage: boolean;
  permissionNoteId: string;
  onToggle(key: AutomationKey, enabled: boolean): Promise<string | undefined>;
}): JSX.Element {
  const activateNoteId = useId();
  const [saving, setSaving] = useState<boolean>();
  const [notice, setNotice] = useState<string>();
  const pending = saving !== undefined;
  const enabled = saving ?? flow.enabled;
  // Switching off is always possible; on needs an active version.
  const blocked = flow.activeVersion === null && !flow.enabled;
  const disabled = !canManage || blocked;

  async function toggle() {
    if (disabled || pending) return;
    const next = !flow.enabled;
    setNotice(undefined);
    setSaving(next);
    const reason = await onToggle(flow.key, next);
    setSaving(undefined);
    if (reason !== undefined) setNotice(reason);
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={flow.name}
          aria-describedby={!canManage ? permissionNoteId : blocked ? activateNoteId : undefined}
          aria-disabled={pending || undefined}
          disabled={disabled}
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
      {canManage && blocked ? (
        <p id={activateNoteId} className="text-xs text-muted-foreground">
          {ACTIVATE_FIRST}
        </p>
      ) : null}
      {notice ? (
        <p role="alert" className="text-xs text-destructive">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

function BuiltInBadge(): JSX.Element {
  return (
    <Badge variant="secondary" className="ml-2">
      Built in
    </Badge>
  );
}

/** "New flow": a name, then the new flow's page. */
function NewFlow({
  onCreate,
}: {
  onCreate(name: string): Promise<string | undefined>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();
  const fieldId = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setMessage(undefined);
    const refusal = await onCreate(trimmed);
    setSaving(false);
    if (refusal !== undefined) setMessage(refusal);
  }

  return (
    <>
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        New flow
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setMessage(undefined);
        }}
      >
        <DialogContent>
          <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>New flow</DialogTitle>
              <DialogDescription>
                Give the flow a name. It starts empty and off; the editor arrives in a later
                release.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor={fieldId}>Name</Label>
              <Input
                id={fieldId}
                value={name}
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            {message ? (
              <p role="alert" className="text-sm text-destructive">
                {message}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="submit" disabled={saving || name.trim() === ''}>
                {saving ? 'Creating…' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

type ArchivedState =
  | { status: 'closed' }
  | { status: 'loading'; flows: FlowSummary[] }
  | { status: 'loaded'; flows: FlowSummary[]; nextBefore: AutomationKey | null }
  | { status: 'failed'; flows: FlowSummary[]; reason: string };

/** "Archived flows": the archived ones, a page at a time, each with Restore. */
function ArchivedFlows({
  canManage,
  loadPage,
  onRestore,
}: {
  canManage: boolean;
  loadPage(before?: AutomationKey): Promise<FlowListResponse>;
  onRestore(key: AutomationKey): Promise<string | undefined>;
}): JSX.Element {
  const regionId = useId();
  const [state, setState] = useState<ArchivedState>({ status: 'closed' });
  const [notice, setNotice] = useState<string>();
  const request = useRef(0);
  const open = state.status !== 'closed';

  async function load(before: AutomationKey | undefined, kept: FlowSummary[]) {
    const current = ++request.current;
    setState({ status: 'loading', flows: kept });
    try {
      const page = await loadPage(before);
      if (request.current !== current) return;
      setState({
        status: 'loaded',
        flows: [...kept, ...page.automations],
        nextBefore: page.nextBefore,
      });
    } catch (caught) {
      if (request.current !== current) return;
      setState({ status: 'failed', flows: kept, reason: errorReason(caught) });
    }
  }

  function toggle() {
    if (open) {
      request.current += 1;
      setState({ status: 'closed' });
      return;
    }
    void load(undefined, []);
  }

  async function restore(key: AutomationKey) {
    setNotice(undefined);
    const refusal = await onRestore(key);
    if (refusal !== undefined) {
      setNotice(refusal);
      return;
    }
    void load(undefined, []);
  }

  return (
    <section className="flex flex-col gap-2">
      <div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-expanded={open}
          aria-controls={regionId}
          onClick={toggle}
        >
          Archived flows
        </Button>
      </div>
      <div id={regionId} hidden={!open} className="flex flex-col gap-2">
        {state.status === 'closed' ? null : (
          <>
            {notice ? (
              <p role="alert" className="text-sm text-destructive">
                {notice}
              </p>
            ) : null}
            {state.flows.length === 0 && state.status === 'loaded' ? (
              <p className="text-sm text-muted-foreground">No archived flows.</p>
            ) : (
              <ul aria-label="Archived flows" className="divide-y rounded-md border text-sm">
                {state.flows.map((flow) => (
                  <li key={flow.key} className="flex items-center gap-3 px-3 py-2">
                    <span className="mr-auto">{flow.name}</span>
                    {canManage ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        aria-label={`Restore ${flow.name}`}
                        onClick={() => void restore(flow.key)}
                      >
                        Restore
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {state.status === 'loading' ? (
              <p role="status" className="text-sm text-muted-foreground">
                Loading the archived flows…
              </p>
            ) : null}
            {state.status === 'failed' ? (
              <p role="alert" className="text-sm text-destructive">
                The archived flows could not be loaded. Reason: {state.reason}.
              </p>
            ) : null}
            {state.status === 'loaded' && state.nextBefore ? (
              <div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void load(state.nextBefore ?? undefined, state.flows)}
                >
                  Show more
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * The site's flows as a table: the name (a link to its page, "Built in" for
 * the six), when it runs in words, its switch, when it last ran, how many
 * times, and its status chip. Above it, one notice per overlap warning and the
 * no-sender notice; with `canManage`, "New flow"; below, "Archived flows".
 */
export function AutomationsList({
  workspaceSlug,
  data,
  onToggle,
  onCreate,
  loadArchived,
  onRestore,
}: {
  workspaceSlug: string;
  data: FlowListResponse;
  onToggle(key: AutomationKey, enabled: boolean): Promise<string | undefined>;
  onCreate(name: string): Promise<string | undefined>;
  loadArchived(before?: AutomationKey): Promise<FlowListResponse>;
  onRestore(key: AutomationKey): Promise<string | undefined>;
}): JSX.Element {
  const permissionNoteId = useId();
  return (
    <div className="flex flex-col gap-4">
      {data.warnings.map((warning) => (
        <p
          key={`${warning.event.kind}:${warning.event.leadType}:${
            warning.event.kind === 'stage_entered' ? warning.event.stage : ''
          }`}
          className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
        >
          {warning.message}
        </p>
      ))}
      {data.hasSender ? null : (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          Switch an email on once Settings → Email is saved; until then every run is skipped.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {data.canManage ? (
          <NewFlow onCreate={onCreate} />
        ) : (
          <p id={permissionNoteId} className="text-sm text-muted-foreground">
            {NEEDS_INTEGRATIONS}
          </p>
        )}
      </div>
      <Table>
        <caption className="sr-only">Automation flows</caption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Name</TableHead>
            <TableHead scope="col">When</TableHead>
            <TableHead scope="col">On</TableHead>
            <TableHead scope="col">Last run</TableHead>
            <TableHead scope="col">Runs</TableHead>
            <TableHead scope="col">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.automations.map((flow) => (
            <TableRow key={flow.key}>
              <TableCell className="max-w-80 whitespace-normal">
                <Link
                  className="font-medium underline-offset-2 hover:underline"
                  href={`/w/${workspaceSlug}/automations/${flow.key}`}
                >
                  {flow.name}
                </Link>
                {flow.origin === 'builtin' ? <BuiltInBadge /> : null}
              </TableCell>
              <TableCell className="whitespace-normal">
                {flow.trigger ? describeTrigger(flow.trigger, names) : 'No trigger yet'}
              </TableCell>
              <TableCell>
                <FlowSwitch
                  flow={flow}
                  canManage={data.canManage}
                  permissionNoteId={permissionNoteId}
                  onToggle={onToggle}
                />
              </TableCell>
              <TableCell>
                {flow.lastRunAt === null ? (
                  'Never'
                ) : (
                  <time dateTime={flow.lastRunAt} title={dateTimeLabel(flow.lastRunAt)}>
                    {relativeTime(flow.lastRunAt)}
                  </time>
                )}
              </TableCell>
              <TableCell>{flow.runCount}</TableCell>
              <TableCell className="whitespace-normal">
                <StatusChip flow={flow} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ArchivedFlows canManage={data.canManage} loadPage={loadArchived} onRestore={onRestore} />
    </div>
  );
}

/** The Automations page's content for one site: its flows, loaded and wired to the backend. */
export function SiteAutomations({ workspaceSlug }: { workspaceSlug: string }): JSX.Element {
  const staff = useStaffSession();
  const router = useRouter();
  const workspaceId = staff.workspaces.find((item) => item.slug === workspaceSlug)?.id;
  const accessToken = staff.accessToken;
  const { data, reload, replace, error } = useAutomations(workspaceId);

  async function onToggle(key: AutomationKey, enabled: boolean): Promise<string | undefined> {
    if (!accessToken || !workspaceId) return SIGNED_OUT;
    try {
      const { automation } = await updateAutomation(accessToken, workspaceId, key, { enabled });
      replace(automation);
      // The overlap warnings follow what is on.
      void reload();
      return undefined;
    } catch (caught) {
      return changeError(caught);
    }
  }

  async function onCreate(name: string): Promise<string | undefined> {
    if (!accessToken || !workspaceId) return SIGNED_OUT;
    try {
      const created = await createAutomation(accessToken, workspaceId, { name });
      router.push(`/w/${workspaceSlug}/automations/${created.automation.key}`);
      return undefined;
    } catch (caught) {
      return changeError(caught, 'The flow was not created');
    }
  }

  async function loadArchived(before?: AutomationKey): Promise<FlowListResponse> {
    if (!accessToken || !workspaceId) throw new Error('signed out');
    return listAutomations(accessToken, workspaceId, {
      archived: '1',
      ...(before ? { before } : {}),
    });
  }

  async function onRestore(key: AutomationKey): Promise<string | undefined> {
    if (!accessToken || !workspaceId) return SIGNED_OUT;
    try {
      await restoreAutomation(accessToken, workspaceId, key);
      await reload();
      return undefined;
    } catch (caught) {
      return changeError(caught, 'The flow was not restored');
    }
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
      onCreate={onCreate}
      loadArchived={loadArchived}
      onRestore={onRestore}
    />
  );
}
