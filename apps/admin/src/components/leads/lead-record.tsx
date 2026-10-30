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
  type UpdateWorkspaceLeadRequest,
  type UpdateWorkspaceLeadResponse,
} from '@gt-sales/contracts';
import { Button, Card, CardContent, cn, Input, NativeSelect } from '@gt-sales/ui';
import { ArchiveIcon, ArrowLeftIcon, CopyIcon, PrinterIcon, RotateCcwIcon } from 'lucide-react';

import {
  emailLeadCustomer,
  getStaffLead,
  markLeadOpened,
  setLeadArchived,
  updateStaffLead,
} from '../../lib/api';
import { dateTimeLabel, relativeTime } from '../../lib/dates';
import { memberName } from '../../lib/people';
import { errorDetailList, errorReason, useResource } from '../../lib/use-resource';
import { PropertySections } from '../properties/property-sections';
import { usePropertyModel } from '../properties/use-property-model';
import { leadDisplayName, StageBadge } from './lead-display';
import { IdentityCheck } from './identity-check';
import { LeadDocuments } from './lead-documents';
import type { PropertyEdits } from './lead-form-editor';
import { deliveryLetterUrl, leadSummaryText } from './lead-summary';
import { LeadTasks } from './lead-tasks';
import { changeRequestText, LeadTimeline, pendingChangeRequest } from './lead-timeline';
import { RelatedRequests } from './related-requests';
import { emailSkippedText, StageMoveDialog, stageMoveRefusal } from './stage-move-dialog';
import { useLeadWorkspace } from './use-lead-workspace';

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
 * column.
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
  const [message, setMessage] = useState<string>();
  // The stage a move waits on details for (the dispatch or activation dialog).
  const [moveTo, setMoveTo] = useState<string>();
  // The mails the last change's automations did not send, and why.
  const [emailSkipped, setEmailSkipped] = useState<readonly EmailSkipped[]>([]);
  const [copied, setCopied] = useState(false);
  // Staff closed the notice of the last failed refresh.
  const [refreshDismissed, setRefreshDismissed] = useState(false);

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
      <p className="py-10 text-sm text-muted-foreground" aria-busy="true">
        Loading the lead…
      </p>
    );
  }

  const { lead, activities, tasks, related, identities, documents, access } = record.data;
  const letterUrl = access.contacts ? deliveryLetterUrl(record.data) : undefined;
  const waitingChange = pendingChangeRequest(activities);
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

  return (
    <div className={cn('flex flex-col', inPanel ? 'gap-4' : 'gap-6')}>
      <div className="flex flex-col gap-3">
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
          <div className="min-w-0 flex-1">
            <Title
              className={cn(
                'truncate font-semibold tracking-tight',
                inPanel ? 'text-lg' : 'text-2xl',
              )}
            >
              {leadDisplayName(lead.contact)}
            </Title>
            <p className="text-sm text-muted-foreground">
              {leadTypeLabel(lead.leadType)} · received{' '}
              <time dateTime={lead.createdAt} title={dateTimeLabel(lead.createdAt)}>
                {relativeTime(lead.createdAt)}
              </time>
              {lead.externalRef ? ` · ${lead.externalRef}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canWrite ? (
              <>
                <label className="w-52">
                  <span className="sr-only">Stage</span>
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
                <label className="w-52">
                  <span className="sr-only">Assignee</span>
                  <NativeSelect
                    value={lead.assignedActorId ?? ''}
                    disabled={saving}
                    onChange={(event) =>
                      void update({ assignedActorId: event.target.value || null })
                    }
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
            {access.contacts ? (
              <Button type="button" variant="outline" size="sm" onClick={() => void copySummary()}>
                <CopyIcon className="size-4" aria-hidden="true" /> {copied ? 'Copied' : 'Copy info'}
              </Button>
            ) : null}
            {letterUrl ? (
              <Button asChild variant="outline" size="sm">
                <a href={letterUrl} target="_blank" rel="noopener noreferrer">
                  <PrinterIcon className="size-4" aria-hidden="true" /> Print delivery letter
                </a>
              </Button>
            ) : null}
            {access.manage ? (
              lead.deletedAt === null ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
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
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setRefreshDismissed(true)}
            >
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

      <div
        className={cn(
          'grid',
          inPanel ? 'gap-4' : 'gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]',
        )}
      >
        <div className="flex flex-col gap-4">
          {access.contacts ? (
            <Card>
              <CardContent className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <h2 className="text-base font-semibold">Contact</h2>
                  {canWrite && !editingContact ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditingContact(true)}
                    >
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
                      <Field label="Country">{lead.contact.countryCode}</Field>
                    ) : null}
                  </dl>
                )}
              </CardContent>
            </Card>
          ) : null}

          <IdentityCheck
            accessToken={accessToken}
            workspaceId={workspaceId}
            leadId={lead.id}
            identities={identities}
            canReveal={access.revealSensitive === true}
          />

          <LeadDocuments
            accessToken={accessToken}
            workspaceId={workspaceId}
            documents={documents}
            canDownload={access.downloadDocuments === true}
            canReview={access.reviewDocuments === true && lead.deletedAt === null}
            onReviewed={reviewed}
          />

          <RelatedRequests workspaceSlug={workspaceSlug} related={related} />

          {access.contacts ? (
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
          ) : null}

          {access.contacts && offersSimEmail && canWrite && savedSimNumber ? (
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
                      <span className="mr-auto text-muted-foreground">
                        SIM number {savedSimNumber}
                      </span>
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
          ) : null}

          <Card>
            <CardContent className="flex flex-col gap-2">
              <h2 className="text-base font-semibold">Source</h2>
              <dl>
                <Field label="Source">
                  <code className="text-xs">{lead.source}</code>
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
        </div>

        {access.contacts ? (
          <div className="flex flex-col gap-4">
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
            <Card>
              <CardContent>
                <LeadTimeline
                  lead={lead}
                  activities={activities}
                  members={members}
                  canWrite={canWrite}
                  accessToken={accessToken}
                  workspaceSlug={workspaceSlug}
                  catalog={catalog}
                  onNoteAdded={(activity) => {
                    addActivities([activity]);
                    changeRecord((current) => ({
                      ...current,
                      lead: { ...current.lead, updatedAt: activity.createdAt },
                    }));
                  }}
                />
              </CardContent>
            </Card>
          </div>
        ) : null}
      </div>
    </div>
  );
}
