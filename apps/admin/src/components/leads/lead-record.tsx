'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  allowedStageMoves,
  defaultPropertyLayout,
  leadOrderEditSchema,
  orderStorageKey,
  leadTypeEntry,
  leadTypeLabel,
  stageGates,
  type EmailSkipped,
  type GetWorkspaceLeadResponse,
  type LeadActivity,
  type LeadContactEdit,
  type LeadTask,
  type ResolveChangeRequestResponse,
  type StaffChangeRequest,
  type UpdateWorkspaceLeadRequest,
  type UpdateWorkspaceLeadResponse,
} from '@gt-sales/contracts';
import {
  Button,
  Card,
  CardContent,
  cn,
  Input,
  NativeSelect,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '@gt-sales/ui';
import {
  ArchiveIcon,
  ArrowLeftIcon,
  CopyIcon,
  FilesIcon,
  HistoryIcon,
  HouseIcon,
  ListTodoIcon,
  StickyNoteIcon,
  RotateCcwIcon,
  UserRoundIcon,
} from 'lucide-react';

import {
  approveChangeRequest,
  createFileDownloadLink,
  emailLeadCustomer,
  getStaffLead,
  markLeadOpened,
  rejectChangeRequest,
  setLeadArchived,
  updateStaffLead,
} from '../../lib/api';
import { dateTimeLabel, relativeTime } from '../../lib/dates';
import { downloadNavigation } from '../../lib/file-links';
import { memberName } from '../../lib/people';
import { errorDetailList, errorReason, useResource } from '../../lib/use-resource';
import { PropertySections } from '../properties/property-sections';
import { usePropertyModel } from '../properties/use-property-model';
import { ChangeRequestCard } from './change-request-card';
import { leadDisplayName, StageBadge } from './lead-display';
import { IdentityCheck } from './identity-check';
import { LeadDocuments, linkFailure } from './lead-documents';
import type { PropertyEdits } from './lead-form-editor';
import { leadSummaryText } from './lead-summary';
import { LeadAttentionStrip, leadAttention, type LeadAttentionTarget } from './lead-attention';
import { LeadTasks } from './lead-tasks';
import { changeRequestText, LeadTimeline, pendingChangeRequest } from './lead-timeline';
import { RelatedRequests } from './related-requests';
import { emailSkippedText, StageMoveDialog, stageMoveRefusal } from './stage-move-dialog';
import { useLeadWorkspace } from './use-lead-workspace';
import { LoadingSkeleton } from '../crm/loading-skeleton';
import { LEAD_WORK_SAVED } from '../../lib/lead-work-events';
import { countryName } from '../../lib/countries';
import { readableSource } from '../../lib/source-label';

const ATTRIBUTION_LABELS: Record<string, string> = {
  utmSource: 'UTM source',
  utmMedium: 'UTM medium',
  utmCampaign: 'UTM campaign',
  utmTerm: 'UTM term',
  utmContent: 'UTM content',
  partnerCode: 'Partner code',
  landingPath: 'Landing page',
  referrerHost: 'Referrer',
};

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-3 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function ContactEditor({
  contact,
  saving,
  onSave,
  onCancel,
}: {
  contact: GetWorkspaceLeadResponse['lead']['contact'];
  saving: boolean;
  onSave(edit: LeadContactEdit): void;
  onCancel(): void;
}) {
  const [fullName, setFullName] = useState(contact.fullName ?? '');
  const [email, setEmail] = useState(contact.email ?? '');
  const [phone, setPhone] = useState(contact.phone ?? '');

  function submit(event: FormEvent) {
    event.preventDefault();
    const edit: LeadContactEdit = {};
    if (fullName.trim() && fullName.trim() !== contact.fullName) edit.fullName = fullName.trim();
    if (email.trim() && email.trim() !== contact.email) edit.email = email.trim();
    if (phone.trim() && phone.trim() !== contact.phone) edit.phone = phone.trim();
    if (Object.keys(edit).length === 0) onCancel();
    else onSave(edit);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <label className="text-xs text-muted-foreground">
        Name
        <Input
          value={fullName}
          onChange={(event) => setFullName(event.target.value)}
          maxLength={160}
        />
      </label>
      <label className="text-xs text-muted-foreground">
        Email
        <Input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          maxLength={254}
        />
      </label>
      <label className="text-xs text-muted-foreground">
        Phone
        <Input
          type="tel"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          maxLength={40}
        />
      </label>
      <div className="flex gap-2 pt-1">
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * The lead page, laid out like a CRM record: the stage, owner and archive in
 * the header; contact, the site's property sections and source on the left;
 * tasks and the timeline on the right. Roles that only read leads see the
 * stage and source without the customer's details. In the inbox's side panel
 * (`variant="panel"`) the same record goes without the page's chrome, in one
 * column, with Home, Tasks, Notes, Files and Activity tabs. Drafts stay mounted
 * while switching sections.
 */
export function LeadRecord({
  workspaceSlug,
  leadId,
  variant = 'page',
  onChange,
}: {
  workspaceSlug: string;
  leadId: string;
  variant?: 'page' | 'panel';
  /** After any change saved here (stage, owner, properties, notes, tasks, archive, opened). */
  onChange?(): void;
}) {
  const { workspaceId, accessToken, members } = useLeadWorkspace(workspaceSlug);
  const properties = usePropertyModel(workspaceId);
  const catalog = properties.catalog;
  const load = useMemo(
    () =>
      accessToken && workspaceId ? () => getStaffLead(accessToken, workspaceId, leadId) : undefined,
    [accessToken, workspaceId, leadId],
  );
  const record = useResource(load);
  const [saving, setSaving] = useState(false);
  const opening = useRef<string>(undefined);
  // The caller hears of each saved change; its callback may change every render.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const { reload } = record;
  useEffect(() => {
    const saved = (event: Event) => {
      if (
        event instanceof CustomEvent &&
        event.detail?.workspaceId === workspaceId &&
        event.detail?.leadId === leadId
      ) {
        void reload();
        onChangeRef.current?.();
      }
    };
    window.addEventListener(LEAD_WORK_SAVED, saved);
    return () => window.removeEventListener(LEAD_WORK_SAVED, saved);
  }, [workspaceId, leadId, reload]);

  // The first open by someone who works leads clears the "New" badge for the
  // whole team. Best effort: a failure leaves the badge for the next open.
  const shouldMarkOpened =
    record.data?.lead.isNew === true && record.data.access.manage && Boolean(accessToken);
  const { mutate } = record;
  useEffect(() => {
    if (!shouldMarkOpened || !accessToken || !workspaceId || opening.current === leadId) return;
    opening.current = leadId;
    markLeadOpened(accessToken, workspaceId, leadId)
      .then((result) => {
        mutate((current) => ({
          ...current,
          lead: { ...current.lead, isNew: false },
          activities: result.activity
            ? [result.activity, ...current.activities]
            : current.activities,
        }));
        onChangeRef.current?.();
      })
      .catch(() => undefined);
  }, [shouldMarkOpened, accessToken, workspaceId, leadId, mutate]);
  // Get Canada Sim's "email the customer this number?" after a SIM number is saved.
  const [simEmail, setSimEmail] = useState<'ask' | 'sending' | 'sent'>();
  const [simEmailMessage, setSimEmailMessage] = useState<string>();
  const [editingContact, setEditingContact] = useState(false);
  const [panelTab, setPanelTab] = useState('home');
  const [message, setMessage] = useState<string>();
  // The stage a move waits on details for (the dispatch or activation dialog).
  const [moveTo, setMoveTo] = useState<string>();
  // The mails the last change's automations did not send, and why.
  const [emailSkipped, setEmailSkipped] = useState<readonly EmailSkipped[]>([]);
  const [copied, setCopied] = useState(false);
  // Staff closed the notice of the last failed refresh.
  const [refreshDismissed, setRefreshDismissed] = useState(false);
  // The change request staff just decided: its card stays to say what happened.
  const [decided, setDecided] = useState<{ leadId: string; request: StaffChangeRequest }>();

  // "Copied" reads for a moment, then the button is itself again.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const inPanel = variant === 'panel';
  const Title = inPanel ? 'h2' : 'h1';

  // A refresh that fails keeps the lead on screen with a notice; only a lead
  // that could not be loaded at all shows the error.
  if (record.error && !record.data) {
    return (
      <div className={cn('flex flex-col items-start gap-3', inPanel ? 'py-4' : 'py-10')}>
        <Title className="text-xl font-semibold">
          {record.error === 'lead_not_found' ? 'Lead not found' : 'The lead could not be loaded'}
        </Title>
        <p className="text-sm text-muted-foreground">Reason: {record.error}.</p>
        {inPanel ? null : (
          <Link href={`/w/${workspaceSlug}/leads`} className="text-sm underline">
            Back to leads
          </Link>
        )}
      </div>
    );
  }
  if (!record.data || !accessToken || !workspaceId) {
    return (
      <LoadingSkeleton
        label="Loading the lead…"
        variant="record"
        panel={inPanel}
        className={inPanel ? 'p-4' : undefined}
      />
    );
  }

  const { lead, activities, tasks, related, identities, documents, access } = record.data;
  const waitingChange = pendingChangeRequest(activities);
  const shownRequest =
    record.data.changeRequest ?? (decided?.leadId === leadId ? decided.request : undefined);
  const canWrite = access.manage && lead.deletedAt === null;
  const stages = leadTypeEntry(lead.leadType)?.stages ?? [];
  const stageListed = stages.some((entry) => entry.key === lead.stage);
  // The stage it is at and the moves allowed from there, in board order; the
  // catalogue's moves for a backend that sends none.
  const moves =
    record.data.allowedMoves.length > 0
      ? record.data.allowedMoves
      : allowedStageMoves(lead.leadType, lead.stage);
  const stageChoices = stages.filter(
    (entry) => entry.key === lead.stage || moves.includes(entry.key),
  );
  const payload = lead.form?.payload ?? {};
  const customValues = lead.customValues ?? {};
  const layout =
    properties.model?.layouts[lead.leadType]?.layout ??
    defaultPropertyLayout(lead.leadType, catalog);
  // A SIM order's number can be emailed to its customer once it is saved.
  const offersSimEmail = catalog
    .forType(lead.leadType)
    .some((property) => property.key === 'simNumber');
  const savedSimNumber =
    typeof payload.simNumber === 'string' && payload.simNumber.trim() !== ''
      ? payload.simNumber
      : undefined;
  const attribution = Object.entries(lead.attribution).filter(
    ([key, value]) => value !== undefined && key !== 'partnerCodeMatched',
  );
  const self = members.find((member) => member.isSelf);

  /** A change the backend confirmed: shown here, and told to the caller. */
  function changeRecord(update: (current: GetWorkspaceLeadResponse) => GetWorkspaceLeadResponse) {
    record.mutate(update);
    onChangeRef.current?.();
  }

  function addActivities(entries: readonly LeadActivity[]) {
    changeRecord((current) => ({
      ...current,
      activities: [...entries, ...current.activities],
    }));
  }

  /** A saved change: the lead as the backend has it, its new entries, its moves and skipped mails. */
  function applyUpdate(result: UpdateWorkspaceLeadResponse) {
    changeRecord((current) => ({
      ...current,
      lead: result.lead,
      activities: [...result.activities, ...current.activities],
      allowedMoves: result.allowedMoves,
    }));
    setEmailSkipped(result.emailSkipped ?? []);
  }

  async function update(
    body: UpdateWorkspaceLeadRequest,
  ): Promise<UpdateWorkspaceLeadResponse | undefined> {
    if (!accessToken || !workspaceId) return undefined;
    setSaving(true);
    setMessage(undefined);
    try {
      const result = await updateStaffLead(accessToken, workspaceId, leadId, body);
      applyUpdate(result);
      setEditingContact(false);
      return result;
    } catch (error) {
      const code = errorReason(error);
      const refusal =
        body.stage === undefined ? undefined : stageMoveRefusal(code, lead.leadType, lead.stage);
      setMessage(refusal ?? `The change was not saved. Reason: ${code}.`);
      return undefined;
    } finally {
      setSaving(false);
    }
  }

  /** A stage that asks for details first opens the dialog; any other moves at once. */
  function changeStage(to: string) {
    if (stageGates(lead.leadType, to).length > 0) setMoveTo(to);
    else void update({ stage: to });
  }

  /** The dialog's move: it shows the refusals itself, so they are not caught here. */
  async function moveWithDetails(
    body: UpdateWorkspaceLeadRequest,
  ): Promise<UpdateWorkspaceLeadResponse> {
    if (!accessToken || !workspaceId) throw new Error('signed out');
    setMessage(undefined);
    return updateStaffLead(accessToken, workspaceId, leadId, body);
  }

  /** Reads the lead again; a failure keeps what is shown and says so. */
  async function refresh() {
    setRefreshDismissed(false);
    await record.reload();
  }

  /** The customer's request, decided: the answer is shown, then the record is read again for its documents. */
  async function decideChange(
    request: StaffChangeRequest,
    decision: 'approve' | 'reject',
    expectedVersion: number,
  ): Promise<ResolveChangeRequestResponse> {
    if (!accessToken || !workspaceId) throw new Error('signed out');
    const decide = decision === 'approve' ? approveChangeRequest : rejectChangeRequest;
    return decide(accessToken, workspaceId, leadId, request.id, expectedVersion);
  }

  async function changeDecided(request: StaffChangeRequest, result: ResolveChangeRequestResponse) {
    setDecided({ leadId, request });
    changeRecord((current) => ({
      ...current,
      lead: result.lead,
      activities: [...result.activities, ...current.activities],
      allowedMoves: result.allowedMoves,
      changeRequest: null,
    }));
    // An approval changed the lead's fields and made the held documents current.
    await refresh();
  }

  /**
   * Opens a document that came with the request in a tab of its own. The tab
   * opens inside the click (a popup blocker would refuse it later); a failure
   * is thrown with the words staff read.
   */
  async function openRequestDocument(fileId: string): Promise<void> {
    if (!accessToken || !workspaceId) throw new Error('Sign in again to open documents.');
    const tab = downloadNavigation.openTab();
    if (!tab) {
      throw new Error(
        'Your browser blocked the new tab. Allow pop-ups for this site, or download it.',
      );
    }
    try {
      const link = await createFileDownloadLink(accessToken, workspaceId, fileId, 'inline');
      tab.show(link.url);
    } catch (error) {
      tab.close();
      throw new Error(linkFailure(errorReason(error)));
    }
  }

  async function reviewed() {
    await refresh();
    onChangeRef.current?.();
  }

  /**
   * A section's save: its built-in answers, custom values and order details
   * in one change. Order edits come keyed by property and go out under their
   * stored names (`orderStorageKey`: the order's `plan` is sent as `planId`,
   * which re-freezes the plan).
   */
  async function saveProperties(edits: PropertyEdits): Promise<string | undefined> {
    if (!accessToken || !workspaceId) return 'The change was not saved. Sign in again.';
    let order: UpdateWorkspaceLeadRequest['order'];
    if (edits.order) {
      const parsed = leadOrderEditSchema.safeParse(
        Object.fromEntries(
          Object.entries(edits.order).map(([key, value]) => [orderStorageKey(key) ?? key, value]),
        ),
      );
      if (!parsed.success) return 'Check the order: a quantity and both statuses are needed.';
      order = parsed.data;
    }
    const body: UpdateWorkspaceLeadRequest = {
      ...(edits.form ? { form: edits.form } : {}),
      ...(edits.customValues ? { customValues: edits.customValues } : {}),
      ...(order ? { order } : {}),
    };
    try {
      const result = await updateStaffLead(accessToken, workspaceId, leadId, body);
      applyUpdate(result);
      const saved = result.lead.form?.payload.simNumber;
      if (edits.form && 'simNumber' in edits.form && typeof saved === 'string' && saved.trim()) {
        setSimEmail('ask');
      }
      return undefined;
    } catch (error) {
      return `The change was not saved. Reason: ${errorReason(error)}.`;
    }
  }

  async function emailSimNumber() {
    if (!accessToken || !workspaceId) return;
    setSimEmail('sending');
    setSimEmailMessage(undefined);
    try {
      const result = await emailLeadCustomer(accessToken, workspaceId, leadId, 'sim_number_ready');
      addActivities([result.activity]);
      setSimEmail('sent');
    } catch (error) {
      const reason = errorReason(error);
      // What the mail lacks: its fill-ins, or the customer's address.
      const missing = errorDetailList(error, 'missing');
      setSimEmail(undefined);
      setSimEmailMessage(
        reason === 'conflict' && missing.includes('SIM number')
          ? 'Add the SIM number first.'
          : reason === 'conflict' && missing.includes('customer email')
            ? 'The customer has no email address.'
            : reason === 'conflict'
              ? 'The order needs the customer’s email address and a SIM number first.'
              : reason === 'feature_not_ready'
                ? 'Emailing customers is not set up for this site yet.'
                : `The email was not sent. Reason: ${reason}.`,
      );
    }
  }

  async function copySummary() {
    if (!record.data) return;
    setMessage(undefined);
    try {
      await navigator.clipboard.writeText(
        leadSummaryText(record.data, {
          layout,
          catalog,
          // As the record shows them: everyone who sees the customer's details sees these.
          canRevealSensitive: record.data.access.contacts,
        }),
      );
      setCopied(true);
    } catch {
      setMessage('The browser did not allow copying. Select the details and copy them instead.');
    }
  }

  async function setArchived(archived: boolean) {
    if (!accessToken || !workspaceId) return;
    setSaving(true);
    setMessage(undefined);
    try {
      const result = await setLeadArchived(accessToken, workspaceId, leadId, archived);
      changeRecord((current) => ({
        ...current,
        lead: result.lead,
        activities: result.activity ? [result.activity, ...current.activities] : current.activities,
      }));
    } catch (error) {
      setMessage(
        `The lead was not ${archived ? 'archived' : 'restored'}. Reason: ${errorReason(error)}.`,
      );
    } finally {
      setSaving(false);
    }
  }

  function upsertTask(task: LeadTask) {
    changeRecord((current) => {
      const exists = current.tasks.some((entry) => entry.id === task.id);
      const nextTasks = exists
        ? current.tasks.map((entry) => (entry.id === task.id ? task : entry))
        : [task, ...current.tasks];
      const open = nextTasks.filter((entry) => entry.status === 'open');
      const due = open
        .map((entry) => entry.dueAt)
        .filter((value): value is string => value !== null)
        .sort();
      return {
        ...current,
        tasks: nextTasks,
        lead: { ...current.lead, openTaskCount: open.length, nextTaskDueAt: due[0] ?? null },
      };
    });
  }

  function noteAdded(activity: LeadActivity) {
    addActivities([activity]);
    changeRecord((current) => ({
      ...current,
      lead: { ...current.lead, updatedAt: activity.createdAt },
    }));
  }

  const attention = leadAttention({
    lead,
    formPayload: payload,
    documents,
    tasks,
    changeRequestNo: record.data.changeRequest?.requestNo,
    contacts: access.contacts,
  });
  const anchorId = (target: LeadAttentionTarget) => `lead-${lead.id}-${target}`;
  // In the panel a card may sit on another tab: open it first, then scroll
  // once that tab has rendered. Focus moves to the card for keyboard users.
  function jumpTo(target: LeadAttentionTarget) {
    if (inPanel)
      setPanelTab(target === 'documents' ? 'files' : target === 'tasks' ? 'tasks' : 'home');
    requestAnimationFrame(() => {
      const element = document.getElementById(anchorId(target));
      if (!element) return;
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
      element.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
      element.focus({ preventScroll: true });
    });
  }
  const anchored = (target: LeadAttentionTarget, node: ReactNode) =>
    node ? (
      <div id={anchorId(target)} tabIndex={-1} className="scroll-mt-16 outline-none">
        {node}
      </div>
    ) : null;

  const header = (
    <div
      className={cn('flex flex-col gap-4', !inPanel && 'rounded-2xl border bg-card p-5 md:p-6')}
      data-slot="lead-record-header"
    >
      {inPanel ? null : (
        <Link
          href={`/w/${workspaceSlug}/leads?type=${lead.leadType}`}
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" aria-hidden="true" /> {leadTypeLabel(lead.leadType)}{' '}
          leads
        </Link>
      )}
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        {!inPanel ? (
          <span
            className="flex size-12 items-center justify-center rounded-full border bg-muted/60"
            aria-hidden="true"
          >
            <UserRoundIcon className="size-5 text-muted-foreground" />
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <Title
            className={cn(
              'break-words font-semibold tracking-tight',
              inPanel ? 'text-xl leading-7' : 'text-2xl',
            )}
          >
            {leadDisplayName(lead.contact)}
          </Title>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="rounded-md bg-muted/60 px-2 py-1 font-medium text-foreground">
              {leadTypeLabel(lead.leadType)}
            </span>
            {lead.externalRef ? (
              <span className="max-w-full break-words rounded-md border px-2 py-1 font-mono text-[11px]">
                {lead.externalRef}
              </span>
            ) : null}
            <span>
              Received{' '}
              <time dateTime={lead.createdAt} title={dateTimeLabel(lead.createdAt)}>
                {relativeTime(lead.createdAt)}
              </time>
            </span>
          </div>
        </div>
        <div className={cn('grid w-full grid-cols-2 gap-3', !inPanel && 'sm:max-w-md')}>
          {canWrite ? (
            <>
              <label className="flex min-w-0 flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">Stage</span>
                <NativeSelect
                  value={lead.stage}
                  disabled={saving}
                  onChange={(event) => changeStage(event.target.value)}
                >
                  {stageListed ? null : <option value={lead.stage}>{lead.stage}</option>}
                  {stageChoices.map((entry) => (
                    <option key={entry.key} value={entry.key}>
                      {entry.label}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <label className="flex min-w-0 flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">Assignee</span>
                <NativeSelect
                  value={lead.assignedActorId ?? ''}
                  disabled={saving}
                  onChange={(event) => void update({ assignedActorId: event.target.value || null })}
                >
                  <option value="">Unassigned</option>
                  {self ? <option value={self.actorId}>{memberName(self)} (you)</option> : null}
                  {members
                    .filter((member) => !member.isSelf)
                    .map((member) => (
                      <option key={member.actorId} value={member.actorId}>
                        {memberName(member)}
                      </option>
                    ))}
                  {lead.assignedActorId &&
                  !members.some((member) => member.actorId === lead.assignedActorId) ? (
                    <option value={lead.assignedActorId}>Former teammate</option>
                  ) : null}
                </NativeSelect>
              </label>
            </>
          ) : (
            <StageBadge leadType={lead.leadType} stage={lead.stage} />
          )}
        </div>
        <div className="flex w-full flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
          {access.contacts ? (
            <Button type="button" variant="outline" size="sm" onClick={() => void copySummary()}>
              <CopyIcon className="size-4" aria-hidden="true" /> {copied ? 'Copied' : 'Copy info'}
            </Button>
          ) : null}
          {access.manage ? (
            lead.deletedAt === null ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                disabled={saving}
                onClick={() => void setArchived(true)}
              >
                <ArchiveIcon className="size-4" aria-hidden="true" /> Archive
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                disabled={saving}
                onClick={() => void setArchived(false)}
              >
                <RotateCcwIcon className="size-4" aria-hidden="true" /> Restore
              </Button>
            )
          ) : null}
        </div>
      </div>
      {lead.deletedAt ? (
        <p
          role="status"
          className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm"
        >
          This lead is archived (since {dateTimeLabel(lead.deletedAt)}). Restore it to work on it
          again.
        </p>
      ) : null}
      <LeadAttentionStrip items={attention} onJump={jumpTo} />
      {waitingChange ? (
        <p
          role="status"
          className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm"
        >
          Waiting in the old admin: the customer{' '}
          {changeRequestText(waitingChange, lead.leadType, catalog)}, received{' '}
          <time dateTime={waitingChange.createdAt} title={dateTimeLabel(waitingChange.createdAt)}>
            {relativeTime(waitingChange.createdAt)}
          </time>
          . Approve or reject it there until staff move to the CRM.
        </p>
      ) : null}
      {!access.contacts ? (
        <p role="status" className="rounded-md border px-3 py-2 text-sm text-muted-foreground">
          Your role shows a lead’s stage and source, not the customer’s details, notes or tasks.
        </p>
      ) : null}
      {message ? (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      ) : null}
      {record.error && !refreshDismissed ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm">
          <p role="alert" className="mr-auto">
            Couldn't refresh this lead. Try again.
          </p>
          <Button type="button" size="sm" variant="outline" onClick={() => void refresh()}>
            Retry
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setRefreshDismissed(true)}>
            Dismiss
          </Button>
        </div>
      ) : null}
      {emailSkipped.length > 0 ? (
        <div role="status">
          <ul
            aria-label="Emails not sent"
            className="flex flex-col gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm"
          >
            {emailSkipped.map((skipped, index) => (
              <li key={`${skipped.automation}:${index}`}>{emailSkippedText(skipped)}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {moveTo ? (
        <StageMoveDialog
          lead={lead}
          to={moveTo}
          gates={stageGates(lead.leadType, moveTo)}
          canOverride={access.overrideDocuments === true}
          onMove={moveWithDetails}
          onDone={(result) => {
            applyUpdate(result);
            setMoveTo(undefined);
          }}
          onCancel={() => setMoveTo(undefined)}
        />
      ) : null}
    </div>
  );

  const contactSection = access.contacts ? (
    <Card>
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Contact</h2>
          {canWrite && !editingContact ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditingContact(true)}>
              Edit
            </Button>
          ) : null}
        </div>
        {editingContact ? (
          <ContactEditor
            contact={lead.contact}
            saving={saving}
            onSave={(contact) => void update({ contact })}
            onCancel={() => setEditingContact(false)}
          />
        ) : (
          <dl>
            <Field label="Name">{lead.contact.fullName ?? '—'}</Field>
            <Field label="Email">
              {lead.contact.email ? (
                <a
                  className="underline-offset-2 hover:underline"
                  href={`mailto:${lead.contact.email}`}
                >
                  {lead.contact.email}
                </a>
              ) : (
                '—'
              )}
            </Field>
            <Field label="Phone">
              {lead.contact.phone ? (
                <a
                  className="underline-offset-2 hover:underline"
                  href={`tel:${lead.contact.phone}`}
                >
                  {lead.contact.phone}
                </a>
              ) : (
                '—'
              )}
            </Field>
            {lead.contact.countryCode ? (
              <Field label="Country">
                <span title={lead.contact.countryCode}>
                  {countryName(lead.contact.countryCode)}
                </span>
              </Field>
            ) : null}
          </dl>
        )}
      </CardContent>
    </Card>
  ) : null;

  const identitySection = (
    <IdentityCheck
      accessToken={accessToken}
      workspaceId={workspaceId}
      leadId={lead.id}
      identities={identities}
      canReveal={access.revealSensitive === true}
    />
  );

  const documentsSection = (
    <LeadDocuments
      accessToken={accessToken}
      workspaceId={workspaceId}
      documents={documents}
      canDownload={access.downloadDocuments === true}
      canReview={access.reviewDocuments === true && lead.deletedAt === null}
      onReviewed={reviewed}
    />
  );

  const relatedSection = <RelatedRequests workspaceSlug={workspaceSlug} related={related} />;

  const propertiesSection = access.contacts ? (
    <PropertySections
      leadType={lead.leadType}
      layout={layout}
      catalog={catalog}
      form={payload}
      customValues={customValues}
      order={lead.order}
      canEdit={canWrite}
      // Everyone who sees the customer's details sees these (the SIN keeps its own reveal).
      canRevealSensitive={access.contacts}
      onSave={saveProperties}
    />
  ) : null;

  const simEmailSection =
    access.contacts && offersSimEmail && canWrite && savedSimNumber ? (
      <Card>
        <CardContent className="flex flex-col gap-2">
          {access.emailCustomer ? (
            simEmail === 'ask' ? (
              <div
                role="group"
                aria-label="Email the customer this number?"
                className="flex flex-wrap items-center gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-sm"
              >
                <span className="mr-auto">Email the customer this number?</span>
                <Button type="button" size="sm" onClick={() => void emailSimNumber()}>
                  Email the customer
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setSimEmail(undefined)}
                >
                  Not now
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="mr-auto text-muted-foreground">SIM number {savedSimNumber}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={simEmail === 'sending'}
                  onClick={() => void emailSimNumber()}
                >
                  {simEmail === 'sending' ? 'Sending…' : 'Email it to the customer'}
                </Button>
                {simEmail === 'sent' ? (
                  <span role="status" className="w-full text-muted-foreground">
                    Queued: the customer gets it within a minute.
                  </span>
                ) : null}
              </div>
            )
          ) : (
            <p className="text-xs text-muted-foreground">
              Emailing the customer is not set up for this site yet.
            </p>
          )}
          {simEmailMessage ? (
            <p role="alert" className="text-sm text-destructive">
              {simEmailMessage}
            </p>
          ) : null}
        </CardContent>
      </Card>
    ) : null;

  const sourceSection = (
    <Card>
      <CardContent className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">Source</h2>
        <dl>
          <Field label="Source">
            <span title={lead.source}>{readableSource(lead.source)}</span>
          </Field>
          {attribution.map(([key, value]) => (
            <Field key={key} label={ATTRIBUTION_LABELS[key] ?? key}>
              {String(value)}
            </Field>
          ))}
          {lead.consentVersion ? <Field label="Consent">{lead.consentVersion}</Field> : null}
          <Field label="Received">{dateTimeLabel(lead.createdAt)}</Field>
          <Field label="Last activity">{dateTimeLabel(lead.updatedAt)}</Field>
        </dl>
      </CardContent>
    </Card>
  );

  const tasksSection = (
    <Card>
      <CardContent>
        <LeadTasks
          workspaceId={workspaceId}
          leadId={lead.id}
          tasks={tasks}
          members={members}
          canWrite={canWrite}
          accessToken={accessToken}
          onChange={upsertTask}
        />
      </CardContent>
    </Card>
  );

  const changeRequestSection = shownRequest ? (
    <ChangeRequestCard
      // A new version (the customer replaced it, or staff reloaded) starts the card afresh.
      key={`${shownRequest.id}:${shownRequest.version}`}
      lead={lead}
      changeRequest={shownRequest}
      catalog={catalog}
      canDecide={access.decideChanges === true}
      canDownload={access.downloadDocuments === true}
      onDecide={(decision, expectedVersion) =>
        decideChange(shownRequest, decision, expectedVersion)
      }
      onDone={(result) => void changeDecided(shownRequest, result)}
      openDocument={openRequestDocument}
      onReload={() => void refresh()}
    />
  ) : null;

  const timelineSection = (
    <Card>
      <CardContent>
        <LeadTimeline
          lead={lead}
          activities={activities}
          members={members}
          canWrite={canWrite && !inPanel}
          accessToken={accessToken}
          workspaceSlug={workspaceSlug}
          catalog={catalog}
          onNoteAdded={noteAdded}
        />
      </CardContent>
    </Card>
  );

  if (inPanel) {
    const activeTab = !access.contacts && panelTab !== 'files' ? 'home' : panelTab;
    return (
      <Tabs value={activeTab} onValueChange={setPanelTab} className="min-w-0">
        <TabsList
          aria-label="Lead sections"
          className="sticky top-0 z-10 overflow-x-auto bg-background px-2"
        >
          <TabsTrigger value="home" className="gap-1.5 px-2 text-xs">
            <HouseIcon className="size-3.5" aria-hidden="true" />
            Home
          </TabsTrigger>
          {access.contacts ? (
            <>
              <TabsTrigger value="tasks" className="gap-1.5 px-2 text-xs">
                <ListTodoIcon className="size-3.5" aria-hidden="true" />
                Tasks
              </TabsTrigger>
              <TabsTrigger value="notes" className="gap-1.5 px-2 text-xs">
                <StickyNoteIcon className="size-3.5" aria-hidden="true" />
                Notes
              </TabsTrigger>
            </>
          ) : null}
          <TabsTrigger value="files" className="gap-1.5 px-2 text-xs">
            <FilesIcon className="size-3.5" aria-hidden="true" />
            Files
          </TabsTrigger>
          {access.contacts ? (
            <TabsTrigger value="activity" className="gap-1.5 px-2 text-xs">
              <HistoryIcon className="size-3.5" aria-hidden="true" />
              Activity
            </TabsTrigger>
          ) : null}
        </TabsList>
        <div className="border-b p-4">{header}</div>
        <TabsContent
          value="home"
          hidden={activeTab !== 'home'}
          forceMount
          className="flex flex-col gap-4 p-4"
        >
          {contactSection}
          {anchored('order', propertiesSection)}
          {simEmailSection}
          {identitySection}
          {relatedSection}
          {access.contacts ? anchored('change-request', changeRequestSection) : null}
          {sourceSection}
        </TabsContent>
        {access.contacts ? (
          <>
            <TabsContent value="tasks" hidden={activeTab !== 'tasks'} forceMount className="p-4">
              {anchored('tasks', tasksSection)}
            </TabsContent>
            <TabsContent value="notes" hidden={activeTab !== 'notes'} forceMount className="p-4">
              <Card>
                <CardContent>
                  <LeadTimeline
                    mode="notes"
                    lead={lead}
                    activities={activities}
                    members={members}
                    canWrite={canWrite}
                    accessToken={accessToken}
                    workspaceSlug={workspaceSlug}
                    catalog={catalog}
                    onNoteAdded={noteAdded}
                  />
                </CardContent>
              </Card>
            </TabsContent>
          </>
        ) : null}
        <TabsContent value="files" hidden={activeTab !== 'files'} forceMount className="p-4">
          {documents.length > 0 ? (
            anchored('documents', documentsSection)
          ) : (
            <Card>
              <CardContent className="flex flex-col items-center gap-2 py-8 text-center">
                <FilesIcon className="size-6 text-muted-foreground" aria-hidden="true" />
                <h2 className="text-sm font-medium">No files yet</h2>
                <p className="text-sm text-muted-foreground">
                  Documents uploaded for this lead will appear here.
                </p>
              </CardContent>
            </Card>
          )}
        </TabsContent>
        {access.contacts ? (
          <TabsContent
            value="activity"
            hidden={activeTab !== 'activity'}
            forceMount
            className="p-4"
          >
            {timelineSection}
          </TabsContent>
        ) : null}
      </Tabs>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {header}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="flex flex-col gap-4">
          {contactSection}
          {identitySection}
          {anchored('documents', documentsSection)}
          {relatedSection}
          {anchored('order', propertiesSection)}
          {simEmailSection}
          {sourceSection}
        </div>
        {access.contacts ? (
          <div className="flex flex-col gap-4">
            {anchored('tasks', tasksSection)}
            {anchored('change-request', changeRequestSection)}
            {timelineSection}
          </div>
        ) : null}
      </div>
    </div>
  );
}
