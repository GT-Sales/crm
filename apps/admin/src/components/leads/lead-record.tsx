'use client';

import Link from 'next/link';
import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  leadTypeEntry,
  leadTypeLabel,
  type GetWorkspaceLeadResponse,
  type LeadActivity,
  type LeadContactEdit,
  type LeadTask,
  type UpdateWorkspaceLeadRequest,
} from '@gt-sales/contracts';
import { Button, Card, CardContent, Input, NativeSelect } from '@gt-sales/ui';
import { ArrowLeftIcon, RotateCcwIcon, Trash2Icon } from 'lucide-react';

import { getStaffLead, setLeadTrashed, updateStaffLead } from '../../lib/api';
import { dateTimeLabel, relativeTime } from '../../lib/dates';
import { memberName } from '../../lib/people';
import { errorReason, useResource } from '../../lib/use-resource';
import { leadDisplayName, StageBadge } from './lead-display';
import { formFields } from './lead-fields';
import { LeadTasks } from './lead-tasks';
import { LeadTimeline } from './lead-timeline';
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
 * The lead page, laid out like a CRM record: the stage, owner and trash in
 * the header; contact, request and source on the left; tasks and the
 * timeline on the right. Roles that only read leads see the stage and source
 * without the customer's details.
 */
export function LeadRecord({ workspaceSlug, leadId }: { workspaceSlug: string; leadId: string }) {
  const { workspaceId, accessToken, members } = useLeadWorkspace(workspaceSlug);
  const load = useMemo(
    () =>
      accessToken && workspaceId ? () => getStaffLead(accessToken, workspaceId, leadId) : undefined,
    [accessToken, workspaceId, leadId],
  );
  const record = useResource(load);
  const [saving, setSaving] = useState(false);
  const [editingContact, setEditingContact] = useState(false);
  const [message, setMessage] = useState<string>();

  if (record.error) {
    return (
      <div className="flex flex-col items-start gap-3 py-10">
        <h1 className="text-xl font-semibold">
          {record.error === 'lead_not_found' ? 'Lead not found' : 'The lead could not be loaded'}
        </h1>
        <p className="text-sm text-muted-foreground">Reason: {record.error}.</p>
        <Link href={`/w/${workspaceSlug}/leads`} className="text-sm underline">
          Back to leads
        </Link>
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

  const { lead, activities, tasks, access } = record.data;
  const canWrite = access.manage && lead.deletedAt === null;
  const stages = leadTypeEntry(lead.leadType)?.stages ?? [];
  const stageListed = stages.some((entry) => entry.key === lead.stage);
  const fields = lead.form ? formFields(lead.leadType, lead.form.payload) : [];
  const attribution = Object.entries(lead.attribution).filter(
    ([key, value]) => value !== undefined && key !== 'partnerCodeMatched',
  );
  const self = members.find((member) => member.isSelf);

  function addActivities(entries: readonly LeadActivity[]) {
    record.mutate((current) => ({
      ...current,
      activities: [...entries, ...current.activities],
    }));
  }

  async function update(body: UpdateWorkspaceLeadRequest) {
    if (!accessToken || !workspaceId) return;
    setSaving(true);
    setMessage(undefined);
    try {
      const result = await updateStaffLead(accessToken, workspaceId, leadId, body);
      record.mutate((current) => ({
        ...current,
        lead: result.lead,
        activities: [...result.activities, ...current.activities],
      }));
      setEditingContact(false);
    } catch (error) {
      setMessage(`The change was not saved. Reason: ${errorReason(error)}.`);
    } finally {
      setSaving(false);
    }
  }

  async function setTrashed(trashed: boolean) {
    if (!accessToken || !workspaceId) return;
    setSaving(true);
    setMessage(undefined);
    try {
      const result = await setLeadTrashed(accessToken, workspaceId, leadId, trashed);
      record.mutate((current) => ({
        ...current,
        lead: result.lead,
        activities: result.activity ? [result.activity, ...current.activities] : current.activities,
      }));
    } catch (error) {
      setMessage(
        `The lead was not ${trashed ? 'moved to the trash' : 'restored'}. Reason: ${errorReason(error)}.`,
      );
    } finally {
      setSaving(false);
    }
  }

  function upsertTask(task: LeadTask) {
    record.mutate((current) => {
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
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Link
          href={`/w/${workspaceSlug}/leads?type=${lead.leadType}`}
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" aria-hidden="true" /> {leadTypeLabel(lead.leadType)}{' '}
          leads
        </Link>
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-2xl font-semibold tracking-tight">
              {leadDisplayName(lead.contact)}
            </h1>
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
                    onChange={(event) => void update({ stage: event.target.value })}
                  >
                    {stageListed ? null : <option value={lead.stage}>{lead.stage}</option>}
                    {stages.map((entry) => (
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
            {access.manage ? (
              lead.deletedAt === null ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={saving}
                  onClick={() => void setTrashed(true)}
                >
                  <Trash2Icon className="size-4" aria-hidden="true" /> Move to trash
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  disabled={saving}
                  onClick={() => void setTrashed(false)}
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
            This lead is in the trash (since {dateTimeLabel(lead.deletedAt)}). Restore it to work on
            it again.
          </p>
        ) : null}
        {!access.contacts ? (
          <p role="status" className="rounded-md border px-3 py-2 text-sm text-muted-foreground">
            Your role shows a lead’s stage and source, not the customer’s details, notes or tasks.
          </p>
        ) : null}
        {message ? (
          <p role="alert" className="text-sm text-rose-300">
            {message}
          </p>
        ) : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
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

          {fields.length > 0 ? (
            <Card>
              <CardContent className="flex flex-col gap-2">
                <h2 className="text-base font-semibold">Request</h2>
                <dl>
                  {fields.map((field) => (
                    <Field key={field.label} label={field.label}>
                      {field.value}
                    </Field>
                  ))}
                </dl>
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
                  onNoteAdded={(activity) => {
                    addActivities([activity]);
                    record.mutate((current) => ({
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
