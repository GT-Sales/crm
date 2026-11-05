'use client';

import { useEffect, useId, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import {
  AUTOMATION_MAX_HOURS,
  AUTOMATION_MAX_TRIGGER_DAYS,
  AUTOMATION_MAX_WAIT_DAYS,
  FLOW_TASK_VARIABLES,
  FLOW_TRIGGER_KINDS,
  emailTemplateKeySchema,
  leadTypeCatalog,
  type Duration,
  type FlowCatalogResponse,
  type FlowDraftStep,
  type FlowDraftTrigger,
  type FlowIssue,
  type FlowLeadChange,
  type FlowStep,
  type FlowTrigger,
  type FlowTriggerKind,
  type LeadType,
} from '@gt-sales/contracts';
import { Button, FormField, Input, Label, Textarea } from '@gt-sales/ui';
import Link from 'next/link';

import { issueText } from '../flow-words';
import { ConditionBuilder } from './condition-builder';
import { countNestedSteps } from './draft-mutations';
import { STEP_KIND_LABELS } from './layout-flow';

const TRIGGER_KIND_LABELS: Readonly<Record<FlowTriggerKind, string>> = {
  lead_submitted: 'Lead is submitted',
  stage_entered: 'Lead moves to a stage',
  time_in_stage: 'Lead has been in a stage for a while',
  task_overdue: 'Follow-up task is overdue',
  after_submitted: 'Time since lead was submitted',
};

function extractTriggerLeadTypes(trigger: FlowTrigger | FlowDraftTrigger | null): string[] {
  if (!trigger) return [];
  switch (trigger.kind) {
    case 'stage_entered':
    case 'time_in_stage':
      return trigger.leadType ? [trigger.leadType] : [];
    case 'lead_submitted':
    case 'task_overdue':
    case 'after_submitted':
      return [...trigger.leadTypes];
  }
}

function createDefaultTrigger(
  kind: FlowTriggerKind,
  catalog: FlowCatalogResponse | undefined,
): FlowDraftTrigger {
  const firstType: LeadType = catalog?.leadTypes[0]?.key ?? 'sim_order';
  const stages =
    catalog?.leadTypes.find((entry) => entry.key === firstType)?.stages ??
    leadTypeCatalog.sim_order.stages;
  const firstNonIncomplete =
    stages.find((stage) => stage.key !== 'incomplete')?.key ?? stages[0]?.key ?? 'pending';

  switch (kind) {
    case 'lead_submitted':
      return { kind: 'lead_submitted', leadTypes: [firstType], when: null };
    case 'stage_entered':
      return {
        kind: 'stage_entered',
        leadType: firstType,
        stage: firstNonIncomplete,
        when: null,
      };
    case 'time_in_stage':
      return {
        kind: 'time_in_stage',
        leadType: firstType,
        stage: firstNonIncomplete,
        after: { amount: 2, unit: 'days' },
        when: null,
      };
    case 'task_overdue':
      return {
        kind: 'task_overdue',
        leadTypes: [],
        after: null,
        when: null,
      };
    case 'after_submitted':
      return {
        kind: 'after_submitted',
        leadTypes: [firstType],
        after: { amount: 3, unit: 'days' },
        when: null,
      };
  }
}

function DurationFields({
  label,
  value,
  maxDays,
  disabled,
  onChange,
}: {
  label: string;
  value: Duration | null;
  maxDays: number;
  disabled: boolean;
  onChange(next: Duration): void;
}): JSX.Element {
  const id = useId();
  const amount = value?.amount ?? 1;
  const unit = value?.unit ?? 'days';
  const maxAmount = unit === 'hours' ? AUTOMATION_MAX_HOURS : maxDays;

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`${id}-amount`}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          id={`${id}-amount`}
          type="number"
          min={1}
          max={maxAmount}
          disabled={disabled}
          value={String(amount)}
          onChange={(event) => {
            const parsed = Math.max(1, Math.min(maxAmount, Number(event.target.value || '1')));
            onChange({ amount: parsed, unit });
          }}
          className="w-24"
        />
        <select
          aria-label={`${label} unit`}
          disabled={disabled}
          value={unit}
          onChange={(event) => {
            const nextUnit = event.target.value === 'hours' ? 'hours' : 'days';
            const nextMax = nextUnit === 'hours' ? AUTOMATION_MAX_HOURS : maxDays;
            onChange({ amount: Math.min(amount, nextMax), unit: nextUnit });
          }}
          className="h-9 rounded-md border bg-background px-2.5 text-sm"
        >
          <option value="hours">hours</option>
          <option value="days">days</option>
        </select>
      </div>
    </div>
  );
}

export function StepSidePanel({
  workspaceSlug,
  selectedId,
  trigger,
  step,
  issues,
  catalog,
  readOnly,
  onUpdateTrigger,
  onUpdateStep,
  onRemoveStep,
  onMoveStep,
  canMoveUp = false,
  canMoveDown = false,
  onClose,
}: {
  workspaceSlug: string;
  selectedId: 'trigger' | string;
  trigger: FlowTrigger | FlowDraftTrigger | null;
  step: FlowStep | FlowDraftStep | undefined;
  issues: readonly FlowIssue[];
  catalog: FlowCatalogResponse | undefined;
  readOnly: boolean;
  onUpdateTrigger(next: FlowDraftTrigger): void;
  onUpdateStep(stepId: string, updater: (current: FlowDraftStep) => FlowDraftStep): void;
  onRemoveStep(stepId: string): void;
  onMoveStep?(stepId: string, direction: 'up' | 'down'): void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  onClose(): void;
}): JSX.Element {
  const id = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  useEffect(() => {
    setConfirmingRemove(false);
    headingRef.current?.focus();
  }, [selectedId]);

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    }
  }

  const leadTypes =
    catalog?.leadTypes ??
    Object.entries(leadTypeCatalog).map(([key, entry]) => ({
      key,
      label: entry.label,
      stages: entry.stages.map((stage) => ({ key: stage.key, label: stage.label })),
    }));

  const triggerLeadTypes = extractTriggerLeadTypes(trigger);
  const heading =
    selectedId === 'trigger' ? 'Trigger' : step ? STEP_KIND_LABELS[step.kind] : 'Step';

  const nestedCount = step ? countNestedSteps(step) : 0;

  return (
    <aside
      aria-labelledby={`${id}-heading`}
      onKeyDown={handleKeyDown}
      className="automation-step-panel flex w-full scroll-mt-20 flex-col gap-4 rounded-lg border bg-card p-4 shadow-sm lg:sticky lg:top-20 lg:max-h-[calc(100dvh-7rem)] lg:w-96 lg:shrink-0 lg:overflow-y-auto"
    >
      <div className="flex items-center justify-between gap-2 border-b pb-3">
        <h3
          id={`${id}-heading`}
          ref={headingRef}
          tabIndex={-1}
          className="text-base font-semibold focus:outline-none"
        >
          {heading}
        </h3>
        <Button type="button" size="sm" variant="ghost" aria-label="Close panel" onClick={onClose}>
          Close
        </Button>
      </div>

      {issues.length > 0 ? (
        <div className="flex flex-col gap-1">
          {issues.map((issue, idx) => (
            <p
              key={`${issue.path}:${issue.code}:${idx}`}
              role="alert"
              className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
            >
              Needs attention: {issueText(issue)}
            </p>
          ))}
        </div>
      ) : null}

      {selectedId === 'trigger' ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-trigger-kind`}>When</Label>
            <select
              id={`${id}-trigger-kind`}
              disabled={readOnly}
              value={trigger?.kind ?? ''}
              onChange={(event) => {
                const nextKind = FLOW_TRIGGER_KINDS.find(
                  (candidate) => candidate === event.target.value,
                );
                if (nextKind) {
                  onUpdateTrigger(createDefaultTrigger(nextKind, catalog));
                }
              }}
              className="h-9 rounded-md border bg-background px-2.5 text-sm"
            >
              <option value="" disabled>
                Choose a trigger…
              </option>
              {FLOW_TRIGGER_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {TRIGGER_KIND_LABELS[kind]}
                </option>
              ))}
            </select>
          </div>

          {trigger && (trigger.kind === 'stage_entered' || trigger.kind === 'time_in_stage') ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-trigger-lead-type`}>Lead type</Label>
                <select
                  id={`${id}-trigger-lead-type`}
                  disabled={readOnly}
                  value={trigger.leadType ?? ''}
                  onChange={(event) => {
                    const nextType = event.target.value;
                    const typeStages =
                      leadTypes
                        .find((entry) => entry.key === nextType)
                        ?.stages.filter((s) => s.key !== 'incomplete') ?? [];
                    const nextStage = typeStages[0]?.key ?? null;
                    onUpdateTrigger({
                      ...trigger,
                      leadType: nextType,
                      stage: nextStage,
                    });
                  }}
                  className="h-9 rounded-md border bg-background px-2.5 text-sm"
                >
                  <option value="" disabled>
                    Select lead type…
                  </option>
                  {leadTypes.map((type) => (
                    <option key={type.key} value={type.key}>
                      {type.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-trigger-stage`}>Stage</Label>
                <select
                  id={`${id}-trigger-stage`}
                  disabled={readOnly || trigger.leadType === null}
                  value={trigger.stage ?? ''}
                  onChange={(event) =>
                    onUpdateTrigger({
                      ...trigger,
                      stage: event.target.value,
                    })
                  }
                  className="h-9 rounded-md border bg-background px-2.5 text-sm"
                >
                  <option value="" disabled>
                    Select stage…
                  </option>
                  {(leadTypes.find((entry) => entry.key === trigger.leadType)?.stages ?? [])
                    .filter((stage) => stage.key !== 'incomplete')
                    .map((stage) => (
                      <option key={stage.key} value={stage.key}>
                        {stage.label}
                      </option>
                    ))}
                </select>
              </div>
            </>
          ) : null}

          {trigger &&
          (trigger.kind === 'lead_submitted' ||
            trigger.kind === 'task_overdue' ||
            trigger.kind === 'after_submitted') ? (
            <fieldset disabled={readOnly} className="flex flex-col gap-1.5">
              <legend className="text-sm font-medium">
                Lead types{trigger.kind === 'task_overdue' ? ' (leave unchecked for all)' : ''}
              </legend>
              <div className="flex flex-wrap gap-2">
                {leadTypes.map((type) => {
                  const checked = trigger.leadTypes.includes(type.key);
                  return (
                    <label key={type.key} className="flex items-center gap-1.5 text-xs">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) => {
                          const next = event.target.checked
                            ? [...trigger.leadTypes, type.key]
                            : trigger.leadTypes.filter((item) => item !== type.key);
                          onUpdateTrigger({ ...trigger, leadTypes: next });
                        }}
                      />
                      {type.label}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ) : null}

          {trigger && (trigger.kind === 'time_in_stage' || trigger.kind === 'after_submitted') ? (
            <DurationFields
              label="After"
              value={trigger.after}
              maxDays={AUTOMATION_MAX_TRIGGER_DAYS}
              disabled={readOnly}
              onChange={(after) => onUpdateTrigger({ ...trigger, after })}
            />
          ) : null}

          {trigger && trigger.kind === 'task_overdue' ? (
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  disabled={readOnly}
                  checked={trigger.after !== null}
                  onChange={(event) =>
                    onUpdateTrigger({
                      ...trigger,
                      after: event.target.checked ? { amount: 1, unit: 'days' } : null,
                    })
                  }
                />
                Wait extra time after task becomes overdue
              </label>
              {trigger.after !== null ? (
                <DurationFields
                  label="Overdue by"
                  value={trigger.after}
                  maxDays={AUTOMATION_MAX_TRIGGER_DAYS}
                  disabled={readOnly}
                  onChange={(after) => onUpdateTrigger({ ...trigger, after })}
                />
              ) : null}
            </div>
          ) : null}

          {trigger ? (
            <ConditionBuilder
              label="Only when"
              value={trigger.when}
              allowNull
              catalog={catalog}
              triggerLeadTypes={triggerLeadTypes}
              disabled={readOnly}
              onChange={(when) => onUpdateTrigger({ ...trigger, when })}
            />
          ) : null}
        </div>
      ) : null}

      {selectedId !== 'trigger' && step ? (
        <div className="flex flex-col gap-4">
          {step.kind === 'send_email' ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-email-template`}>Email template</Label>
              <select
                id={`${id}-email-template`}
                disabled={readOnly}
                value={step.template ?? ''}
                onChange={(event) => {
                  const parsed = emailTemplateKeySchema.safeParse(event.target.value);
                  const template = parsed.success ? parsed.data : null;
                  onUpdateStep(step.id, (current) =>
                    current.kind === 'send_email' ? { ...current, template } : current,
                  );
                }}
                className="h-9 rounded-md border bg-background px-2.5 text-sm"
              >
                <option value="" disabled>
                  Select an email template…
                </option>
                {(catalog?.templates ?? [])
                  .filter((tpl) => !tpl.archived && tpl.key !== 'tracking_code')
                  .map((tpl) => (
                    <option key={tpl.key} value={tpl.key}>
                      {tpl.name}
                    </option>
                  ))}
              </select>
              <Link
                className="text-xs underline text-muted-foreground"
                href={`/w/${workspaceSlug}/settings/email${
                  step.template ? `?template=${step.template}` : ''
                }`}
              >
                Edit templates in Settings → Email
              </Link>
            </div>
          ) : null}

          {step.kind === 'create_task' ? (
            <div className="flex flex-col gap-3">
              <FormField id={`${id}-task-title`} label="Task title">
                <Input
                  ref={titleInputRef}
                  disabled={readOnly}
                  maxLength={200}
                  value={step.title ?? ''}
                  onChange={(event) => {
                    const nextTitle = event.target.value;
                    onUpdateStep(step.id, (current) =>
                      current.kind === 'create_task' ? { ...current, title: nextTitle } : current,
                    );
                  }}
                />
              </FormField>

              {!readOnly ? (
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`${id}-insert-var`} className="text-xs text-muted-foreground">
                    Insert variable
                  </Label>
                  <select
                    id={`${id}-insert-var`}
                    aria-label="Insert variable"
                    value=""
                    onChange={(event) => {
                      const token = event.target.value;
                      if (!token) return;
                      const inputEl = titleInputRef.current;
                      const currentTitle = step.title ?? '';
                      const start = inputEl?.selectionStart ?? currentTitle.length;
                      const end = inputEl?.selectionEnd ?? currentTitle.length;
                      const inserted = `{${token}}`;
                      const nextTitle =
                        currentTitle.slice(0, start) + inserted + currentTitle.slice(end);
                      onUpdateStep(step.id, (current) =>
                        current.kind === 'create_task'
                          ? { ...current, title: nextTitle.slice(0, 200) }
                          : current,
                      );
                    }}
                    className="h-8 rounded-md border bg-background px-2 text-xs"
                  >
                    <option value="">Choose a variable to insert…</option>
                    {FLOW_TASK_VARIABLES.map((variable) => (
                      <option key={variable} value={variable}>
                        {`{${variable}}`}
                      </option>
                    ))}
                    {(catalog?.properties ?? [])
                      .filter((prop) => prop.taskVariable)
                      .map((prop) => (
                        <option key={prop.key} value={`prop:${prop.key}`}>
                          {`${prop.label} ({prop:${prop.key}})`}
                        </option>
                      ))}
                  </select>
                </div>
              ) : null}

              <FormField
                id={`${id}-task-due`}
                label="Due in (days)"
                hint="Leave empty for no due date; 0 means due today."
              >
                <Input
                  type="number"
                  min={0}
                  max={365}
                  disabled={readOnly}
                  value={step.dueInDays === null ? '' : String(step.dueInDays)}
                  onChange={(event) => {
                    const raw = event.target.value.trim();
                    const dueInDays = raw === '' ? null : Math.max(0, Math.min(365, Number(raw)));
                    onUpdateStep(step.id, (current) =>
                      current.kind === 'create_task' ? { ...current, dueInDays } : current,
                    );
                  }}
                />
              </FormField>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-task-assignee`}>Assign task to</Label>
                <select
                  id={`${id}-task-assignee`}
                  disabled={readOnly}
                  value={step.assignee.kind}
                  onChange={(event) => {
                    const kind = event.target.value;
                    onUpdateStep(step.id, (current) => {
                      if (current.kind !== 'create_task') return current;
                      if (kind === 'member') {
                        // UI-6: only a real member, never a placeholder id.
                        const firstActor = catalog?.members[0]?.actorId;
                        if (firstActor === undefined) return current;
                        return {
                          ...current,
                          assignee: { kind: 'member', actorId: firstActor },
                        };
                      }
                      if (kind === 'none') {
                        return { ...current, assignee: { kind: 'none' } };
                      }
                      return { ...current, assignee: { kind: 'lead_assignee' } };
                    });
                  }}
                  className="h-9 rounded-md border bg-background px-2.5 text-sm"
                >
                  <option value="lead_assignee">The lead’s owner</option>
                  <option value="member" disabled={!catalog?.members.length}>
                    Specific member
                  </option>
                  <option value="none">No one</option>
                </select>
              </div>

              {step.assignee.kind === 'member' ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`${id}-task-member`}>Team member</Label>
                  <select
                    id={`${id}-task-member`}
                    disabled={readOnly}
                    value={step.assignee.actorId}
                    onChange={(event) => {
                      const actorId = event.target.value;
                      onUpdateStep(step.id, (current) =>
                        current.kind === 'create_task'
                          ? { ...current, assignee: { kind: 'member', actorId } }
                          : current,
                      );
                    }}
                    className="h-9 rounded-md border bg-background px-2.5 text-sm"
                  >
                    {(catalog?.members ?? []).map((member) => (
                      <option key={member.actorId} value={member.actorId}>
                        {member.displayName ?? member.actorId}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
            </div>
          ) : null}

          {step.kind === 'assign_lead' ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-assign-member`}>Assign lead to</Label>
                <select
                  id={`${id}-assign-member`}
                  disabled={readOnly}
                  value={step.actorId ?? ''}
                  onChange={(event) => {
                    const actorId = event.target.value || null;
                    onUpdateStep(step.id, (current) =>
                      current.kind === 'assign_lead' ? { ...current, actorId } : current,
                    );
                  }}
                  className="h-9 rounded-md border bg-background px-2.5 text-sm"
                >
                  <option value="" disabled>
                    Select a team member…
                  </option>
                  {(catalog?.members ?? []).map((member) => (
                    <option key={member.actorId} value={member.actorId}>
                      {member.displayName ?? member.actorId}
                    </option>
                  ))}
                </select>
              </div>

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  disabled={readOnly}
                  checked={step.reassign}
                  onChange={(event) => {
                    const reassign = event.target.checked;
                    onUpdateStep(step.id, (current) =>
                      current.kind === 'assign_lead' ? { ...current, reassign } : current,
                    );
                  }}
                />
                Reassign if someone already owns the lead
              </label>
            </div>
          ) : null}

          {step.kind === 'update_lead' ? (
            <UpdateLeadFields
              step={step}
              catalog={catalog}
              leadTypes={leadTypes}
              triggerLeadTypes={triggerLeadTypes}
              disabled={readOnly}
              onUpdate={(change) =>
                onUpdateStep(step.id, (current) =>
                  current.kind === 'update_lead' ? { ...current, change } : current,
                )
              }
            />
          ) : null}

          {step.kind === 'notify_staff' ? (
            <div className="flex flex-col gap-3">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  disabled={readOnly}
                  checked={step.toAssignee}
                  onChange={(event) => {
                    const toAssignee = event.target.checked;
                    onUpdateStep(step.id, (current) =>
                      current.kind === 'notify_staff' ? { ...current, toAssignee } : current,
                    );
                  }}
                />
                Email the lead’s owner
              </label>

              <fieldset disabled={readOnly} className="flex flex-col gap-1.5">
                <legend className="text-sm font-medium">Additional team members</legend>
                {(catalog?.members ?? []).length === 0 ? (
                  <p className="text-xs text-muted-foreground">No team members listed.</p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {(catalog?.members ?? []).map((member) => {
                      const checked = step.actorIds.includes(member.actorId);
                      return (
                        <label key={member.actorId} className="flex items-center gap-2 text-xs">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(event) => {
                              const nextIds = event.target.checked
                                ? [...step.actorIds, member.actorId].slice(0, 10)
                                : step.actorIds.filter((item) => item !== member.actorId);
                              onUpdateStep(step.id, (current) =>
                                current.kind === 'notify_staff'
                                  ? { ...current, actorIds: nextIds }
                                  : current,
                              );
                            }}
                          />
                          {member.displayName ?? member.actorId}
                        </label>
                      );
                    })}
                  </div>
                )}
              </fieldset>

              <FormField
                id={`${id}-notify-note`}
                label="Note"
                hint="Plain text only (up to 300 characters; no fill-ins)."
              >
                <Textarea
                  rows={3}
                  maxLength={300}
                  disabled={readOnly}
                  value={step.note}
                  onChange={(event) => {
                    const note = event.target.value;
                    onUpdateStep(step.id, (current) =>
                      current.kind === 'notify_staff' ? { ...current, note } : current,
                    );
                  }}
                />
              </FormField>
            </div>
          ) : null}

          {step.kind === 'if_else' ? (
            <ConditionBuilder
              label="If condition"
              value={step.condition}
              allowNull={false}
              catalog={catalog}
              triggerLeadTypes={triggerLeadTypes}
              disabled={readOnly}
              onChange={(condition) => {
                if (!condition) return;
                onUpdateStep(step.id, (current) =>
                  current.kind === 'if_else' ? { ...current, condition } : current,
                );
              }}
            />
          ) : null}

          {step.kind === 'wait' ? (
            <DurationFields
              label="Wait for"
              value={step.for}
              maxDays={AUTOMATION_MAX_WAIT_DAYS}
              disabled={readOnly}
              onChange={(duration) =>
                onUpdateStep(step.id, (current) =>
                  current.kind === 'wait' ? { ...current, for: duration } : current,
                )
              }
            />
          ) : null}

          {!readOnly ? (
            <div className="border-t pt-3">
              {onMoveStep ? (
                <div
                  className="mb-3 flex gap-2"
                  role="group"
                  aria-label="Move step within this path"
                >
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!canMoveUp}
                    onClick={() => onMoveStep(step.id, 'up')}
                  >
                    Move up
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!canMoveDown}
                    onClick={() => onMoveStep(step.id, 'down')}
                  >
                    Move down
                  </Button>
                </div>
              ) : null}
              {confirmingRemove ? (
                <div className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
                  <p className="text-xs">
                    Remove this If/else and the {nestedCount} step{nestedCount === 1 ? '' : 's'}{' '}
                    inside its branches?
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      onClick={() => onRemoveStep(step.id)}
                    >
                      Remove all
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirmingRemove(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    if (step.kind === 'if_else' && nestedCount > 0) {
                      setConfirmingRemove(true);
                    } else {
                      onRemoveStep(step.id);
                    }
                  }}
                >
                  Remove step
                </Button>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}

function UpdateLeadFields({
  step,
  catalog,
  leadTypes,
  triggerLeadTypes,
  disabled,
  onUpdate,
}: {
  step: Extract<FlowStep | FlowDraftStep, { kind: 'update_lead' }>;
  catalog: FlowCatalogResponse | undefined;
  leadTypes: FlowCatalogResponse['leadTypes'];
  triggerLeadTypes: readonly string[];
  disabled: boolean;
  onUpdate(change: FlowLeadChange | null): void;
}): JSX.Element {
  const id = useId();
  const editableProperties = (catalog?.properties ?? []).filter((prop) => prop.update);
  const relevantTypes =
    triggerLeadTypes.length > 0
      ? leadTypes.filter((entry) => triggerLeadTypes.includes(entry.key))
      : leadTypes;
  const availableStages = Array.from(
    new Map(
      relevantTypes.flatMap((entry) => entry.stages.map((stage) => [stage.key, stage])),
    ).values(),
  );

  const changeKind = step.change?.kind ?? 'stage';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-change-kind`}>Change</Label>
        <select
          id={`${id}-change-kind`}
          disabled={disabled}
          value={changeKind}
          onChange={(event) => {
            if (event.target.value === 'property') {
              const firstProp = editableProperties[0];
              onUpdate({
                kind: 'property',
                key: firstProp?.key ?? 'carrier',
                value: defaultPropertyValue(firstProp),
              });
            } else {
              const firstStage = availableStages[0]?.key ?? 'verified';
              onUpdate({ kind: 'stage', stage: firstStage });
            }
          }}
          className="h-9 rounded-md border bg-background px-2.5 text-sm"
        >
          <option value="stage">Move to stage</option>
          <option value="property">Set property</option>
        </select>
      </div>

      {step.change?.kind === 'stage' || step.change === null ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-stage`}>Stage</Label>
          <select
            id={`${id}-stage`}
            disabled={disabled}
            value={step.change?.kind === 'stage' ? step.change.stage : ''}
            onChange={(event) => onUpdate({ kind: 'stage', stage: event.target.value })}
            className="h-9 rounded-md border bg-background px-2.5 text-sm"
          >
            <option value="" disabled>
              Select stage…
            </option>
            {availableStages.map((stage) => (
              <option key={stage.key} value={stage.key}>
                {stage.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {step.change?.kind === 'property' ? (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-prop-key`}>Property</Label>
            <select
              id={`${id}-prop-key`}
              disabled={disabled}
              value={step.change.key}
              onChange={(event) => {
                const key = event.target.value;
                const prop = editableProperties.find((entry) => entry.key === key);
                const defaultValue = defaultPropertyValue(prop);
                onUpdate({ kind: 'property', key, value: defaultValue });
              }}
              className="h-9 rounded-md border bg-background px-2.5 text-sm"
            >
              {editableProperties.map((prop) => (
                <option key={prop.key} value={prop.key}>
                  {prop.label}
                </option>
              ))}
            </select>
          </div>

          <PropertyValueField
            id={`${id}-prop-value`}
            property={editableProperties.find(
              (property) => step.change?.kind === 'property' && property.key === step.change.key,
            )}
            value={step.change.value}
            disabled={disabled}
            onChange={(value) => {
              if (step.change?.kind === 'property') onUpdate({ ...step.change, value });
            }}
          />
        </>
      ) : null}
    </div>
  );
}

function defaultPropertyValue(property: FlowCatalogResponse['properties'][number] | undefined) {
  if (property?.kind === 'yesNo') return true;
  if (property?.kind === 'number' || property?.kind === 'money') return 0;
  if (property?.kind === 'choice') return property.options?.[0]?.value ?? null;
  return null;
}

function PropertyValueField({
  id,
  property,
  value,
  disabled,
  onChange,
}: {
  id: string;
  property: FlowCatalogResponse['properties'][number] | undefined;
  value: Extract<FlowLeadChange, { kind: 'property' }>['value'];
  disabled: boolean;
  onChange(value: Extract<FlowLeadChange, { kind: 'property' }>['value']): void;
}): JSX.Element {
  const numeric = property?.kind === 'number' || property?.kind === 'money';
  return (
    <FormField
      id={id}
      label="Value"
      hint={property?.kind === 'money' ? 'Amount in Canadian cents.' : undefined}
    >
      {property?.kind === 'yesNo' ? (
        <select
          disabled={disabled}
          value={value === null ? '' : String(value)}
          onChange={(event) =>
            onChange(event.target.value === '' ? null : event.target.value === 'true')
          }
          className="h-9 rounded-md border bg-background px-2.5 text-sm"
        >
          <option value="">Clear value</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      ) : property?.kind === 'choice' ? (
        <select
          disabled={disabled}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value || null)}
          className="h-9 rounded-md border bg-background px-2.5 text-sm"
        >
          <option value="">Clear value</option>
          {property.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : property?.kind === 'longText' ? (
        <Textarea
          disabled={disabled}
          value={value === null ? '' : String(value)}
          onChange={(event) => onChange(event.target.value || null)}
        />
      ) : (
        <Input
          disabled={disabled}
          type={
            numeric
              ? 'number'
              : property?.kind === 'date'
                ? 'date'
                : property?.kind === 'email'
                  ? 'email'
                  : property?.kind === 'url'
                    ? 'url'
                    : property?.kind === 'phone'
                      ? 'tel'
                      : 'text'
          }
          step={property?.kind === 'money' ? 1 : 'any'}
          value={value === null ? '' : String(value)}
          onChange={(event) => {
            const raw = event.target.value;
            const next = raw === '' ? null : numeric ? Number(raw) : raw;
            if (typeof next !== 'number' || Number.isFinite(next)) onChange(next);
          }}
        />
      )}
    </FormField>
  );
}
