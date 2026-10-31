import { z } from 'zod';

import { BUILT_IN_AUTOMATIONS } from './automations';
import {
  AUTOMATION_MAX_FLOWS,
  automationKeySchema,
  type BuiltInAutomationKey,
} from './automation-keys';
import { emailTemplateKeySchema, type EmailTemplateKey } from './customer-email';
import {
  isLeadStage,
  leadStageLabel,
  leadTypeCatalog,
  leadTypeLabel,
  submittedLeadStage,
} from './lead-types';
import { leadTypeSchema, type LeadType } from './leads';
import { isOrderLeadType, propertyKeySchema, type PropertyCatalog } from './properties';
import { leadPropertyFilterSchema, leadStageSchema } from './workspace-leads';

export { AUTOMATION_MAX_FLOWS } from './automation-keys';

/**
 * Automation flows (phase 8 spec §3): a trigger and an ordered list of steps,
 * with if/else branches and waits. A flow has a draft (`flowDraftSchema`, what
 * the editor may save while it is being built) and an active version
 * (`flowDefinitionSchema`, what may be activated and run). Both check the same
 * structure; a site's own facts (its templates, members, plans and properties)
 * are checked separately by `checkFlowAgainstSite`, so a flow that names
 * something a site later removes still parses and is skipped with the key at
 * fault (ruling R6). Pure: no database, no environment.
 */

// ---------------------------------------------------------------------------
// Value lists

export const FLOW_TRIGGER_KINDS = [
  'lead_submitted',
  'stage_entered',
  'time_in_stage',
  'task_overdue',
  'after_submitted',
] as const;
export const flowTriggerKindSchema = z.enum(FLOW_TRIGGER_KINDS);
export type FlowTriggerKind = z.infer<typeof flowTriggerKindSchema>;

export const FLOW_STEP_KINDS = [
  'send_email',
  'create_task',
  'assign_lead',
  'update_lead',
  'notify_staff',
  'if_else',
  'wait',
] as const;
export const flowStepKindSchema = z.enum(FLOW_STEP_KINDS);
export type FlowStepKind = z.infer<typeof flowStepKindSchema>;

export const AUTOMATION_RUN_STATUSES = [
  'waiting',
  'completed',
  'skipped',
  'failed',
  'cancelled',
] as const;
export const automationRunStatusSchema = z.enum(AUTOMATION_RUN_STATUSES);
export type AutomationRunStatus = z.infer<typeof automationRunStatusSchema>;

export const AUTOMATION_STEP_OUTCOMES = [
  'done',
  'skipped',
  'failed',
  'waiting',
  'cancelled',
] as const;
export const automationStepOutcomeSchema = z.enum(AUTOMATION_STEP_OUTCOMES);
export type AutomationStepOutcome = z.infer<typeof automationStepOutcomeSchema>;

export const AUTOMATION_VERSION_STATUSES = ['draft', 'active', 'retired', 'discarded'] as const;
export const automationVersionStatusSchema = z.enum(AUTOMATION_VERSION_STATUSES);
export type AutomationVersionStatus = z.infer<typeof automationVersionStatusSchema>;

export const AUTOMATION_WAIT_STATUSES = ['pending', 'resumed', 'cancelled'] as const;
export const automationWaitStatusSchema = z.enum(AUTOMATION_WAIT_STATUSES);
export type AutomationWaitStatus = z.infer<typeof automationWaitStatusSchema>;

export const AUTOMATION_TIMER_STATUSES = ['pending', 'fired', 'void'] as const;
export const automationTimerStatusSchema = z.enum(AUTOMATION_TIMER_STATUSES);
export type AutomationTimerStatus = z.infer<typeof automationTimerStatusSchema>;

/** The time-based triggers, each of which waits as a row of `app.automation_timers`. */
export const AUTOMATION_TIMER_KINDS = ['time_in_stage', 'task_overdue', 'after_submitted'] as const;
export const automationTimerKindSchema = z.enum(AUTOMATION_TIMER_KINDS);
export type AutomationTimerKind = z.infer<typeof automationTimerKindSchema>;

/**
 * Why a run or a step did not do its work. The database stores only the
 * shape (`AUTOMATION_REASON_SHAPE`), so a new reason needs no migration; a
 * test ties every value here to that shape.
 */
export const AUTOMATION_REASONS = [
  'no_sender',
  'no_customer_email',
  'missing_fill_in',
  'already_sent',
  'compose_failed',
  'step_failed',
  'definition_invalid',
  'stage_unavailable',
  'template_unavailable',
  'property_unavailable',
  'plan_unavailable',
  'member_unavailable',
  'lead_type_unavailable',
  'invalid_variable',
  'chain_too_deep',
  'loop_prevented',
  'already_assigned',
  'activator_not_allowed',
  'illegal_stage_move',
  'dispatch_details_required',
  'activation_details_required',
  'documents_incomplete',
  'invalid_field',
  'no_staff_sender',
  'member_has_no_address',
  'lead_archived',
  'flow_switched_off',
  'resume_failed',
] as const;
export const automationReasonSchema = z.enum(AUTOMATION_REASONS);
export type AutomationReason = z.infer<typeof automationReasonSchema>;

/** The shape of a stored reason (`automation_runs_reason_check`, `automation_step_runs_reason_check`). */
export const AUTOMATION_REASON_SHAPE = /^[a-z][a-z0-9_]{0,63}$/;

/** A step's id: unique in its flow; the admin makes `s_` and 8 random characters. */
export const STEP_ID_PATTERN = /^[a-z0-9_]{1,40}$/;
/** The one step of a built-in's default, whose mail keeps phase 4's dedupe key. */
export const BUILT_IN_STEP_ID = 'main';

// ---------------------------------------------------------------------------
// Limits (spec §3; checked on save and on activation)

export const AUTOMATION_MAX_STEPS = 30;
export const AUTOMATION_MAX_BRANCH_DEPTH = 3;
export const AUTOMATION_MAX_WAITS = 5;
export const AUTOMATION_MAX_CONDITIONS = 30;
export const AUTOMATION_MAX_GROUP_ITEMS = 10;
export const AUTOMATION_MAX_CHAIN_DEPTH = 3;
export const AUTOMATION_RUN_PAGE = 50;
export const AUTOMATION_MAX_DEFINITION_BYTES = 65_536;
export const AUTOMATION_MAX_PATH_WAIT_DAYS = 90;
/** A wait: 1 to 720 hours or 1 to 60 days. A trigger's delay: 1 to 720 hours or 1 to 90 days. */
export const AUTOMATION_MAX_HOURS = 720;
export const AUTOMATION_MAX_WAIT_DAYS = 60;
export const AUTOMATION_MAX_TRIGGER_DAYS = 90;
const MAX_CONDITION_VALUES = 20;
const MAX_TRIGGER_TYPES = 5;
const MAX_NOTIFY_MEMBERS = 10;

// ---------------------------------------------------------------------------
// Shapes

export const durationSchema = z
  .object({ amount: z.int().min(1).max(AUTOMATION_MAX_HOURS), unit: z.enum(['hours', 'days']) })
  .strict();
export type Duration = z.infer<typeof durationSchema>;

const matchSchema = z.enum(['all', 'any']);

export const conditionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('lead_type'),
      in: z.array(leadTypeSchema).min(1).max(MAX_CONDITION_VALUES),
    })
    .strict(),
  z
    .object({
      kind: z.literal('stage'),
      op: z.enum(['in', 'not_in']),
      stages: z.array(leadStageSchema).min(1).max(MAX_CONDITION_VALUES),
    })
    .strict(),
  z
    .object({
      kind: z.literal('plan'),
      op: z.enum(['in', 'not_in']),
      planIds: z.array(z.uuid()).min(1).max(MAX_CONDITION_VALUES),
    })
    .strict(),
  z
    .object({
      kind: z.literal('assignee'),
      op: z.enum(['none', 'any', 'is']),
      actorId: z.uuid().optional(),
    })
    .strict()
    .refine((condition) => (condition.op === 'is') === (condition.actorId !== undefined), {
      message: 'an assignee condition names a member with is, and only with is',
      path: ['actorId'],
    }),
  z.object({ kind: z.literal('property'), filter: leadPropertyFilterSchema }).strict(),
]);
export type Condition = z.infer<typeof conditionSchema>;

/** A group inside a group: groups go two levels deep, no further. */
const innerConditionGroupSchema = z
  .object({
    match: matchSchema,
    items: z.array(conditionSchema).min(1).max(AUTOMATION_MAX_GROUP_ITEMS),
  })
  .strict();

export const conditionGroupSchema = z
  .object({
    match: matchSchema,
    items: z
      .array(z.union([conditionSchema, innerConditionGroupSchema]))
      .min(1)
      .max(AUTOMATION_MAX_GROUP_ITEMS),
  })
  .strict();
export type ConditionGroup = z.infer<typeof conditionGroupSchema>;

/** A group at either level, for code that walks them. */
interface AnyConditionGroup {
  readonly match: 'all' | 'any';
  readonly items: readonly (Condition | AnyConditionGroup)[];
}

const isConditionGroup = (item: Condition | AnyConditionGroup): item is AnyConditionGroup =>
  'match' in item;

const triggerLeadTypesSchema = (min: number) =>
  z
    .array(leadTypeSchema)
    .min(min)
    .max(MAX_TRIGGER_TYPES)
    .refine((types) => new Set(types).size === types.length, { message: 'a lead type twice' });

const whenSchema = conditionGroupSchema.nullable();

export const flowTriggerSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('lead_submitted'),
      leadTypes: triggerLeadTypesSchema(1),
      when: whenSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('stage_entered'),
      leadType: leadTypeSchema,
      stage: leadStageSchema,
      when: whenSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('time_in_stage'),
      leadType: leadTypeSchema,
      stage: leadStageSchema,
      after: durationSchema,
      when: whenSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('task_overdue'),
      /** [] = every lead type. */
      leadTypes: triggerLeadTypesSchema(0),
      after: durationSchema.nullable(),
      when: whenSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('after_submitted'),
      leadTypes: triggerLeadTypesSchema(1),
      after: durationSchema,
      when: whenSchema,
    })
    .strict(),
]);
export type FlowTrigger = z.infer<typeof flowTriggerSchema>;

const flowDraftTriggerSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('lead_submitted'),
      leadTypes: triggerLeadTypesSchema(0),
      when: whenSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('stage_entered'),
      leadType: leadTypeSchema.nullable(),
      stage: leadStageSchema.nullable(),
      when: whenSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('time_in_stage'),
      leadType: leadTypeSchema.nullable(),
      stage: leadStageSchema.nullable(),
      after: durationSchema.nullable(),
      when: whenSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('task_overdue'),
      leadTypes: triggerLeadTypesSchema(0),
      after: durationSchema.nullable(),
      when: whenSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('after_submitted'),
      leadTypes: triggerLeadTypesSchema(0),
      after: durationSchema.nullable(),
      when: whenSchema,
    })
    .strict(),
]);
export type FlowDraftTrigger = z.infer<typeof flowDraftTriggerSchema>;

const stepIdSchema = z.string().regex(STEP_ID_PATTERN);

const taskAssigneeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('lead_assignee') }).strict(),
  z.object({ kind: z.literal('member'), actorId: z.uuid() }).strict(),
  z.object({ kind: z.literal('none') }).strict(),
]);
export type FlowTaskAssignee = z.infer<typeof taskAssigneeSchema>;

const leadChangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('stage'), stage: leadStageSchema }).strict(),
  z
    .object({
      kind: z.literal('property'),
      key: propertyKeySchema,
      value: z.union([z.string().max(4000), z.number().finite(), z.boolean(), z.null()]),
    })
    .strict(),
]);
export type FlowLeadChange = z.infer<typeof leadChangeSchema>;

const taskTitleSchema = z.string().min(1).max(200);
const dueInDaysSchema = z.int().min(0).max(365).nullable();
const notifyFields = {
  toAssignee: z.boolean(),
  actorIds: z.array(z.uuid()).max(MAX_NOTIFY_MEMBERS),
  note: z.string().max(300),
};

export type FlowStep =
  | { id: string; kind: 'send_email'; template: EmailTemplateKey }
  | {
      id: string;
      kind: 'create_task';
      title: string;
      dueInDays: number | null;
      assignee: FlowTaskAssignee;
    }
  | { id: string; kind: 'assign_lead'; actorId: string; reassign: boolean }
  | { id: string; kind: 'update_lead'; change: FlowLeadChange }
  | { id: string; kind: 'notify_staff'; toAssignee: boolean; actorIds: string[]; note: string }
  | { id: string; kind: 'if_else'; condition: ConditionGroup; then: FlowStep[]; else: FlowStep[] }
  | { id: string; kind: 'wait'; for: Duration };

/** A step as a draft may hold it: the settings it still needs may be null. */
export type FlowDraftStep =
  | { id: string; kind: 'send_email'; template: EmailTemplateKey | null }
  | {
      id: string;
      kind: 'create_task';
      title: string | null;
      dueInDays: number | null;
      assignee: FlowTaskAssignee;
    }
  | { id: string; kind: 'assign_lead'; actorId: string | null; reassign: boolean }
  | { id: string; kind: 'update_lead'; change: FlowLeadChange | null }
  | { id: string; kind: 'notify_staff'; toAssignee: boolean; actorIds: string[]; note: string }
  | {
      id: string;
      kind: 'if_else';
      condition: ConditionGroup | null;
      then: FlowDraftStep[];
      else: FlowDraftStep[];
    }
  | { id: string; kind: 'wait'; for: Duration | null };

export const flowStepSchema: z.ZodType<FlowStep> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z
      .object({ id: stepIdSchema, kind: z.literal('send_email'), template: emailTemplateKeySchema })
      .strict(),
    z
      .object({
        id: stepIdSchema,
        kind: z.literal('create_task'),
        title: taskTitleSchema,
        dueInDays: dueInDaysSchema,
        assignee: taskAssigneeSchema,
      })
      .strict(),
    z
      .object({
        id: stepIdSchema,
        kind: z.literal('assign_lead'),
        actorId: z.uuid(),
        reassign: z.boolean(),
      })
      .strict(),
    z
      .object({ id: stepIdSchema, kind: z.literal('update_lead'), change: leadChangeSchema })
      .strict(),
    z.object({ id: stepIdSchema, kind: z.literal('notify_staff'), ...notifyFields }).strict(),
    z
      .object({
        id: stepIdSchema,
        kind: z.literal('if_else'),
        condition: conditionGroupSchema,
        then: z.array(flowStepSchema).max(AUTOMATION_MAX_STEPS),
        else: z.array(flowStepSchema).max(AUTOMATION_MAX_STEPS),
      })
      .strict(),
    z.object({ id: stepIdSchema, kind: z.literal('wait'), for: durationSchema }).strict(),
  ]),
);

export const flowDraftStepSchema: z.ZodType<FlowDraftStep> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z
      .object({
        id: stepIdSchema,
        kind: z.literal('send_email'),
        template: emailTemplateKeySchema.nullable(),
      })
      .strict(),
    z
      .object({
        id: stepIdSchema,
        kind: z.literal('create_task'),
        title: taskTitleSchema.nullable(),
        dueInDays: dueInDaysSchema,
        assignee: taskAssigneeSchema,
      })
      .strict(),
    z
      .object({
        id: stepIdSchema,
        kind: z.literal('assign_lead'),
        actorId: z.uuid().nullable(),
        reassign: z.boolean(),
      })
      .strict(),
    z
      .object({
        id: stepIdSchema,
        kind: z.literal('update_lead'),
        change: leadChangeSchema.nullable(),
      })
      .strict(),
    z.object({ id: stepIdSchema, kind: z.literal('notify_staff'), ...notifyFields }).strict(),
    z
      .object({
        id: stepIdSchema,
        kind: z.literal('if_else'),
        condition: conditionGroupSchema.nullable(),
        then: z.array(flowDraftStepSchema).max(AUTOMATION_MAX_STEPS),
        else: z.array(flowDraftStepSchema).max(AUTOMATION_MAX_STEPS),
      })
      .strict(),
    z
      .object({ id: stepIdSchema, kind: z.literal('wait'), for: durationSchema.nullable() })
      .strict(),
  ]),
);

const flowDefinitionObjectSchema = z
  .object({
    schemaVersion: z.literal(1),
    trigger: flowTriggerSchema,
    steps: z.array(flowStepSchema).min(1).max(AUTOMATION_MAX_STEPS),
  })
  .strict();
export type FlowDefinition = z.infer<typeof flowDefinitionObjectSchema>;

const flowDraftObjectSchema = z
  .object({
    schemaVersion: z.literal(1),
    trigger: flowDraftTriggerSchema.nullable(),
    steps: z.array(flowDraftStepSchema).max(AUTOMATION_MAX_STEPS),
  })
  .strict();
export type FlowDraft = z.infer<typeof flowDraftObjectSchema>;

export type FlowOrigin = 'builtin' | 'custom';

const definitionSchemas = {
  builtin: flowDefinitionObjectSchema.superRefine((definition, ctx) =>
    checkStructure(definition, 'builtin', true, ctx),
  ),
  custom: flowDefinitionObjectSchema.superRefine((definition, ctx) =>
    checkStructure(definition, 'custom', true, ctx),
  ),
};
const draftSchemas = {
  builtin: flowDraftObjectSchema.superRefine((draft, ctx) =>
    checkStructure(draft, 'builtin', false, ctx),
  ),
  custom: flowDraftObjectSchema.superRefine((draft, ctx) =>
    checkStructure(draft, 'custom', false, ctx),
  ),
};

/** What may be activated and run, for a flow of `origin` (only a built-in may have the step `main`). */
export function flowDefinitionSchemaFor(origin: FlowOrigin) {
  return definitionSchemas[origin];
}

/** What a draft of a flow of `origin` may be while it is built (P10). */
export function flowDraftSchemaFor(origin: FlowOrigin) {
  return draftSchemas[origin];
}

/** A custom flow's definition. */
export const flowDefinitionSchema = definitionSchemas.custom;
/** A custom flow's draft; the empty draft is `{ schemaVersion: 1, trigger: null, steps: [] }`. */
export const flowDraftSchema = draftSchemas.custom;

/** The draft a new custom flow starts with. */
export const EMPTY_FLOW_DRAFT: FlowDraft = { schemaVersion: 1, trigger: null, steps: [] };

// ---------------------------------------------------------------------------
// Issues

export const FLOW_ISSUE_CODES = [
  'stage_unavailable',
  'template_unavailable',
  'property_unavailable',
  'plan_unavailable',
  'member_unavailable',
  'lead_type_unavailable',
  'invalid_variable',
  'definition_invalid',
] as const;
export const flowIssueCodeSchema = z.enum(FLOW_ISSUE_CODES);
export type FlowIssueCode = z.infer<typeof flowIssueCodeSchema>;

/** One thing at fault in a flow: where (`steps.2.then.0.template`), what, and the key or id at fault, never a value. */
export const flowIssueSchema = z
  .object({ path: z.string().max(200), code: flowIssueCodeSchema, ref: z.string().max(200) })
  .strict();
export type FlowIssue = z.infer<typeof flowIssueSchema>;

// ---------------------------------------------------------------------------
// Built-ins

/** A built-in's version-1 definition: phase 4's trigger, no `when`, one step `main` sending its template. */
export function builtInFlowDefinition(key: BuiltInAutomationKey): FlowDefinition {
  const rule = BUILT_IN_AUTOMATIONS.find((entry) => entry.key === key);
  if (!rule) throw new Error(`unknown built-in automation ${key}`);
  const { trigger } = rule;
  return {
    schemaVersion: 1,
    trigger:
      trigger.kind === 'lead_submitted'
        ? { kind: 'lead_submitted', leadTypes: [...trigger.leadTypes], when: null }
        : {
            kind: 'stage_entered',
            leadType: trigger.leadType,
            stage: trigger.stage,
            when: null,
          },
    steps: [{ id: BUILT_IN_STEP_ID, kind: 'send_email', template: rule.action.template }],
  };
}

/** A built-in's default name: its label. */
export function builtInFlowName(key: BuiltInAutomationKey): string {
  const rule = BUILT_IN_AUTOMATIONS.find((entry) => entry.key === key);
  if (!rule) throw new Error(`unknown built-in automation ${key}`);
  return rule.label;
}

// ---------------------------------------------------------------------------
// Walking and matching

type WalkableStep = FlowStep | FlowDraftStep;

function walkSequence<S extends WalkableStep>(
  steps: readonly S[],
  prefix: string,
  depth: number,
  visit: (step: S, path: string, depth: number) => void,
  children: (step: S) => { then: readonly S[]; else: readonly S[] } | undefined,
): void {
  steps.forEach((step, index) => {
    const path = `${prefix}.${index}`;
    visit(step, path, depth);
    const branches = children(step);
    if (branches) {
      walkSequence(branches.then, `${path}.then`, depth + 1, visit, children);
      walkSequence(branches.else, `${path}.else`, depth + 1, visit, children);
    }
  });
}

/**
 * Visits every step in pre-order (`then` before `else`) with its path
 * (`steps.2.then.0`) and its depth (the if/else steps around it; 0 at the top).
 */
export function walkSteps(
  steps: readonly FlowStep[],
  visit: (step: FlowStep, path: string, depth: number) => void,
): void {
  walkSequence(steps, 'steps', 0, visit, (step) =>
    step.kind === 'if_else' ? { then: step.then, else: step.else } : undefined,
  );
}

/** `walkSteps` for a draft's steps. */
export function walkDraftSteps(
  steps: readonly FlowDraftStep[],
  visit: (step: FlowDraftStep, path: string, depth: number) => void,
): void {
  walkSequence(steps, 'steps', 0, visit, (step) =>
    step.kind === 'if_else' ? { then: step.then, else: step.else } : undefined,
  );
}

const ALL_LEAD_TYPES: readonly string[] = Object.keys(leadTypeCatalog);
const isKnownLeadType = (leadType: string) => ALL_LEAD_TYPES.includes(leadType);
const ALL_STAGES: ReadonlySet<string> = new Set(
  Object.values(leadTypeCatalog).flatMap((entry) => entry.stages.map((stage) => stage.key)),
);

/** The lead types a trigger can fire for; a `task_overdue` trigger with no type fires for every type. */
export function triggerLeadTypes(trigger: FlowTrigger): readonly LeadType[] {
  switch (trigger.kind) {
    case 'stage_entered':
    case 'time_in_stage':
      return [trigger.leadType];
    case 'task_overdue':
      return trigger.leadTypes.length === 0 ? ALL_LEAD_TYPES : trigger.leadTypes;
    case 'lead_submitted':
    case 'after_submitted':
      return trigger.leadTypes;
  }
}

/** The types a draft trigger names so far: null while it has none to check against. */
function draftTriggerTypes(trigger: FlowDraftTrigger | null): readonly string[] | null {
  if (trigger === null) return null;
  switch (trigger.kind) {
    case 'stage_entered':
    case 'time_in_stage':
      return trigger.leadType === null ? null : [trigger.leadType];
    case 'task_overdue':
      return trigger.leadTypes.length === 0 ? ALL_LEAD_TYPES : trigger.leadTypes;
    case 'lead_submitted':
    case 'after_submitted':
      return trigger.leadTypes.length === 0 ? null : trigger.leadTypes;
  }
}

/** Whether an event set off in a write (a submission or a stage entry) is this trigger's. */
export function triggerMatchesEvent(
  trigger: FlowTrigger,
  event: { kind: 'lead_submitted' | 'stage_entered'; leadType: string; stage: string },
): boolean {
  if (trigger.kind === 'lead_submitted') {
    return event.kind === 'lead_submitted' && trigger.leadTypes.includes(event.leadType);
  }
  if (trigger.kind === 'stage_entered') {
    return (
      event.kind === 'stage_entered' &&
      trigger.leadType === event.leadType &&
      trigger.stage === event.stage
    );
  }
  return false;
}

/** Whether a step changes the lead or makes work for staff (assign, update, task): activating it needs `lead.manage` (R5). */
export function flowHasLeadChangingStep(steps: readonly FlowStep[]): boolean {
  let found = false;
  walkSteps(steps, (step) => {
    if (step.kind === 'assign_lead' || step.kind === 'update_lead' || step.kind === 'create_task') {
      found = true;
    }
  });
  return found;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** A duration in milliseconds; a day is 24 hours. */
export function durationMs(duration: Duration): number {
  return duration.amount * (duration.unit === 'hours' ? HOUR_MS : DAY_MS);
}

const torontoParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Toronto',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** How far Toronto's wall clock is ahead of UTC at `at`, in milliseconds (negative). */
function torontoOffsetMs(at: number): number {
  const parts = new Map(torontoParts.formatToParts(at).map((part) => [part.type, part.value]));
  const field = (type: Intl.DateTimeFormatPartTypes) => Number(parts.get(type) ?? '0');
  const wall = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour'),
    field('minute'),
    field('second'),
  );
  return wall - (at - (at % 1000));
}

/** The instant a calendar day begins in America/Toronto. */
function torontoStartOfDay(year: number, monthIndex: number, day: number): number {
  const wall = Date.UTC(year, monthIndex, day);
  const first = wall - torontoOffsetMs(wall);
  return wall - torontoOffsetMs(first);
}

const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** When a time trigger's timer is due; null for a trigger that is not time-based. `dueDay` (YYYY-MM-DD) only for task_overdue. */
export function timerDueAt(
  trigger: FlowTrigger,
  input: { eventAt: Date; dueDay?: string },
): Date | null {
  switch (trigger.kind) {
    case 'time_in_stage':
    case 'after_submitted':
      return new Date(input.eventAt.getTime() + durationMs(trigger.after));
    case 'task_overdue': {
      const match = CALENDAR_DAY.exec(input.dueDay ?? '');
      if (!match) return null;
      const start = torontoStartOfDay(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1);
      return new Date(start + (trigger.after ? durationMs(trigger.after) : 0));
    }
    case 'lead_submitted':
    case 'stage_entered':
      return null;
  }
}

// ---------------------------------------------------------------------------
// Variables

/** What a task title may write in braces, besides `{prop:<key>}`. */
export const FLOW_TASK_VARIABLES = [
  'first name',
  'last name',
  'plan',
  'price',
  'SIM number',
  'courier',
  'tracking number',
  'order number',
] as const;
export type FlowTaskVariable = (typeof FLOW_TASK_VARIABLES)[number];

/** The allowed list entry that lets any `{prop:<key>}` through. */
export const ANY_PROPERTY_VARIABLE = 'prop:*';
const PROPERTY_VARIABLE = /^prop:\s*(.*)$/i;
const BRACED = /\{([^{}\n]*)\}/g;
const canonicalName = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * The names written in braces in `text`, normalized (`{ First  Name }` is
 * `first name`, a property `prop:<key>`), each once in the order written; or
 * the first one `allowed` does not take, as typed. `prop:*` in `allowed` lets
 * any well-formed property key through. A `{` with no `}` on its line is text.
 */
export function parseTextVariables(
  text: string,
  allowed: readonly string[],
): { ok: true; names: string[] } | { ok: false; name: string } {
  const byCanonical = new Map(
    allowed
      .filter((name) => name !== ANY_PROPERTY_VARIABLE)
      .map((name) => [canonicalName(name), name]),
  );
  const anyProperty = allowed.includes(ANY_PROPERTY_VARIABLE);
  const names: string[] = [];
  for (const match of text.matchAll(BRACED)) {
    const typed = (match[1] ?? '').trim();
    const property = PROPERTY_VARIABLE.exec(typed);
    let name: string | undefined;
    if (property) {
      const key = (property[1] ?? '').trim();
      if (anyProperty && propertyKeySchema.safeParse(key).success) name = `prop:${key}`;
    } else {
      name = byCanonical.get(canonicalName(typed));
    }
    if (name === undefined) return { ok: false, name: typed };
    if (!names.includes(name)) names.push(name);
  }
  return { ok: true, names };
}

const TASK_TITLE_VARIABLES: readonly string[] = [...FLOW_TASK_VARIABLES, ANY_PROPERTY_VARIABLE];

/** The property keys a task title's `{prop:…}` names; [] when it does not parse. */
function titlePropertyKeys(title: string): string[] {
  const parsed = parseTextVariables(title, TASK_TITLE_VARIABLES);
  if (!parsed.ok) return [];
  return parsed.names.filter((name) => name.startsWith('prop:')).map((name) => name.slice(5));
}

// ---------------------------------------------------------------------------
// Size

/** A value as Postgres writes a `jsonb` as text (`", "` and `": "` between items), so its length is `octet_length(definition::text)`'s. */
function jsonbText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(jsonbText).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => `${JSON.stringify(key)}: ${jsonbText(entry)}`);
    return `{${entries.join(', ')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The definition's size as the database's CHECK measures it, in bytes. */
export function flowDefinitionBytes(value: unknown): number {
  return new TextEncoder().encode(jsonbText(value)).length;
}

// ---------------------------------------------------------------------------
// Structure (both schemas)

type IssueSink = {
  addIssue(issue: { code: 'custom'; message: string; path: (string | number)[] }): void;
};

/**
 * A stage a type the trigger names does not list while some other type does:
 * a slip of the type, refused as structure. A stage no type lists (removed
 * from the catalogue since) is a site issue instead, so a stored flow that
 * names it still parses and is skipped with the key (R6).
 */
function isStageOfAnotherType(
  stage: string,
  types: readonly string[],
  need: 'some' | 'every',
): boolean {
  const known = types.filter(isKnownLeadType);
  if (known.length === 0 || !ALL_STAGES.has(stage)) return false;
  return need === 'some'
    ? !known.some((leadType) => isLeadStage(leadType, stage))
    : !known.every((leadType) => isLeadStage(leadType, stage));
}

function isWithin(duration: Duration, maxDays: number): boolean {
  return duration.unit === 'hours'
    ? duration.amount <= AUTOMATION_MAX_HOURS
    : duration.amount <= maxDays;
}

/** The longest sum of waits on any path through `steps`, in milliseconds. */
function longestWaitMs(steps: readonly FlowDraftStep[]): number {
  let total = 0;
  for (const step of steps) {
    if (step.kind === 'wait' && step.for) total += durationMs(step.for);
    if (step.kind === 'if_else')
      total += Math.max(longestWaitMs(step.then), longestWaitMs(step.else));
  }
  return total;
}

function checkStructure(
  flow: FlowDraft,
  origin: FlowOrigin,
  activatable: boolean,
  ctx: IssueSink,
): void {
  const issue = (message: string, path: (string | number)[]) =>
    ctx.addIssue({ code: 'custom', message, path });
  const { trigger } = flow;
  const types = draftTriggerTypes(trigger);
  let conditions = 0;

  const visitGroup = (group: AnyConditionGroup, path: (string | number)[]) => {
    group.items.forEach((item, index) => {
      const at = [...path, 'items', index];
      if (isConditionGroup(item)) {
        visitGroup(item, at);
        return;
      }
      conditions += 1;
      if (item.kind === 'stage' && types) {
        for (const stage of item.stages) {
          if (isStageOfAnotherType(stage, types, 'some')) issue('stage_unavailable', at);
        }
      }
      if (item.kind === 'plan' && types && !types.every(isOrderLeadType)) {
        issue('plan_unavailable', at);
      }
    });
  };

  if (trigger) {
    if (trigger.kind === 'stage_entered' || trigger.kind === 'time_in_stage') {
      if (trigger.stage !== null && trigger.leadType !== null) {
        if (
          trigger.stage === 'incomplete' ||
          isStageOfAnotherType(trigger.stage, [trigger.leadType], 'every')
        ) {
          issue('stage_unavailable', ['trigger', 'stage']);
        }
      }
    }
    if (
      (trigger.kind === 'time_in_stage' ||
        trigger.kind === 'task_overdue' ||
        trigger.kind === 'after_submitted') &&
      trigger.after &&
      !isWithin(trigger.after, AUTOMATION_MAX_TRIGGER_DAYS)
    ) {
      issue('a trigger waits 1 to 720 hours or 1 to 90 days', ['trigger', 'after']);
    }
    if (trigger.when) visitGroup(trigger.when, ['trigger', 'when']);
  }

  const ids = new Set<string>();
  let stepCount = 0;
  let waits = 0;
  const visitSequence = (
    steps: readonly FlowDraftStep[],
    path: (string | number)[],
    depth: number,
  ) => {
    steps.forEach((step, index) => {
      const at = [...path, index];
      stepCount += 1;
      if (ids.has(step.id)) issue('a step id twice', [...at, 'id']);
      ids.add(step.id);
      if (step.id === BUILT_IN_STEP_ID && origin !== 'builtin') {
        issue('the step id main is a built-in’s only', [...at, 'id']);
      }
      switch (step.kind) {
        case 'send_email':
          if (step.template === 'tracking_code') issue('template_unavailable', [...at, 'template']);
          break;
        case 'create_task':
          if (step.title !== null) {
            if (step.title.trim() === '') issue('a task needs a title', [...at, 'title']);
            if (!parseTextVariables(step.title, TASK_TITLE_VARIABLES).ok) {
              issue('invalid_variable', [...at, 'title']);
            }
          }
          break;
        case 'update_lead':
          if (step.change?.kind === 'stage' && types) {
            if (isStageOfAnotherType(step.change.stage, types, 'every')) {
              issue('stage_unavailable', [...at, 'change']);
            }
          }
          break;
        case 'notify_staff':
          if (activatable && !step.toAssignee && step.actorIds.length === 0) {
            issue('a notification needs at least one recipient', at);
          }
          if (new Set(step.actorIds).size !== step.actorIds.length) {
            issue('a member twice', [...at, 'actorIds']);
          }
          break;
        case 'wait':
          waits += 1;
          if (step.for && !isWithin(step.for, AUTOMATION_MAX_WAIT_DAYS)) {
            issue('a wait is 1 to 720 hours or 1 to 60 days', [...at, 'for']);
          }
          break;
        case 'if_else':
          if (index !== steps.length - 1) issue('an if/else is the last step of its sequence', at);
          if (depth + 1 > AUTOMATION_MAX_BRANCH_DEPTH) {
            issue(`branches go ${AUTOMATION_MAX_BRANCH_DEPTH} deep at most`, at);
          }
          if (step.condition) visitGroup(step.condition, [...at, 'condition']);
          visitSequence(step.then, [...at, 'then'], depth + 1);
          visitSequence(step.else, [...at, 'else'], depth + 1);
          break;
        case 'assign_lead':
          break;
      }
    });
  };
  visitSequence(flow.steps, ['steps'], 0);

  if (stepCount > AUTOMATION_MAX_STEPS) {
    issue(`a flow has ${AUTOMATION_MAX_STEPS} steps at most`, ['steps']);
  }
  if (waits > AUTOMATION_MAX_WAITS)
    issue(`a flow has ${AUTOMATION_MAX_WAITS} waits at most`, ['steps']);
  if (longestWaitMs(flow.steps) > AUTOMATION_MAX_PATH_WAIT_DAYS * DAY_MS) {
    issue(`the waits on a path add up to ${AUTOMATION_MAX_PATH_WAIT_DAYS} days at most`, ['steps']);
  }
  if (conditions > AUTOMATION_MAX_CONDITIONS) {
    issue(`a flow has ${AUTOMATION_MAX_CONDITIONS} conditions at most`, []);
  }
  if (flowDefinitionBytes(flow) > AUTOMATION_MAX_DEFINITION_BYTES) {
    issue(`a flow is ${AUTOMATION_MAX_DEFINITION_BYTES} bytes at most`, []);
  }
}

// ---------------------------------------------------------------------------
// The site check

export interface FlowSiteTemplate {
  readonly archived: boolean;
  /** The `{prop:…}` keys the template's subject and body use. */
  readonly propertyKeys: readonly string[];
}

/** What a site has now, for `checkFlowAgainstSite`. */
export interface FlowSite {
  /** Every template the site can send: the nine built-ins and its own `tpl_` ones. */
  readonly templates: ReadonlyMap<string, FlowSiteTemplate>;
  /** The actor ids of its active staff members. */
  readonly memberIds: ReadonlySet<string>;
  /** Every plan of the site (inactive ones included), by id. */
  readonly plans: ReadonlyMap<string, { readonly leadType: string }>;
  readonly catalog: PropertyCatalog;
}

/**
 * What in `definition` the site cannot use now, in document order (the
 * trigger, then the steps in pre-order): a lead type or stage the catalogue
 * does not list, a template that is gone or archived (or one of its `{prop:…}`
 * a customer may not see for a trigger type), a property a condition, a
 * lead update or a task title may not use, a plan of another site or type,
 * a member who is not active. Settings a draft has not set yet are skipped.
 * `ref` is the key or id at fault, never a value.
 */
export function checkFlowAgainstSite(
  definition: FlowDefinition | FlowDraft,
  site: FlowSite,
): FlowIssue[] {
  const issues: FlowIssue[] = [];
  const add = (path: string, code: FlowIssueCode, ref: string) => issues.push({ path, code, ref });
  const { trigger } = definition;
  const named = draftTriggerTypes(trigger);
  const types = named?.filter(isKnownLeadType) ?? null;
  const checkable = types !== null && types.length > 0 ? types : null;

  if (trigger) {
    if (trigger.kind === 'stage_entered' || trigger.kind === 'time_in_stage') {
      if (trigger.leadType !== null) {
        if (!isKnownLeadType(trigger.leadType)) {
          add('trigger.leadType', 'lead_type_unavailable', trigger.leadType);
        } else if (trigger.stage !== null && !isLeadStage(trigger.leadType, trigger.stage)) {
          add('trigger.stage', 'stage_unavailable', trigger.stage);
        }
      }
    } else {
      trigger.leadTypes.forEach((leadType, index) => {
        if (!isKnownLeadType(leadType)) {
          add(`trigger.leadTypes.${index}`, 'lead_type_unavailable', leadType);
        }
      });
    }
  }

  const filterable = (key: string) =>
    checkable !== null &&
    checkable.some((leadType) => site.catalog.filterable(leadType).some((p) => p.key === key));
  const member = (path: string, actorId: string) => {
    if (!site.memberIds.has(actorId)) add(path, 'member_unavailable', actorId);
  };

  const visitGroup = (group: AnyConditionGroup, path: string) => {
    group.items.forEach((item, index) => {
      const at = `${path}.items.${index}`;
      if (isConditionGroup(item)) {
        visitGroup(item, at);
        return;
      }
      switch (item.kind) {
        case 'lead_type':
          for (const leadType of item.in) {
            if (!isKnownLeadType(leadType)) add(at, 'lead_type_unavailable', leadType);
          }
          break;
        case 'stage':
          if (checkable === null) break;
          for (const stage of item.stages) {
            if (!checkable.some((leadType) => isLeadStage(leadType, stage))) {
              add(at, 'stage_unavailable', stage);
            }
          }
          break;
        case 'plan':
          for (const planId of item.planIds) {
            const plan = site.plans.get(planId);
            if (!plan || (checkable !== null && !checkable.includes(plan.leadType))) {
              add(at, 'plan_unavailable', planId);
            }
          }
          break;
        case 'assignee':
          if (item.op === 'is' && item.actorId !== undefined) member(at, item.actorId);
          break;
        case 'property':
          if (checkable !== null && !filterable(item.filter.key)) {
            add(at, 'property_unavailable', item.filter.key);
          }
          break;
      }
    });
  };
  if (trigger?.when) visitGroup(trigger.when, 'trigger.when');

  /** A property a customer email may show for every trigger type: visible, not sensitive, not staff-only. */
  const customerVisible = (key: string) =>
    checkable === null ||
    checkable.every((leadType) => {
      const property = site.catalog.forType(leadType).find((entry) => entry.key === key);
      return property !== undefined && !property.sensitive && !property.staffOnly;
    });
  const editable = (key: string) =>
    checkable === null ||
    checkable.every((leadType) => {
      const property = site.catalog.forType(leadType).find((entry) => entry.key === key);
      return property !== undefined && property.editable && !property.sensitive;
    });
  const titleUsable = (key: string) => {
    const property = site.catalog.get(key);
    return property !== undefined && !property.hidden && !property.sensitive;
  };

  walkDraftSteps(definition.steps, (step, path) => {
    switch (step.kind) {
      case 'send_email': {
        if (step.template === null) break;
        const template = site.templates.get(step.template);
        if (!template || template.archived) {
          add(`${path}.template`, 'template_unavailable', step.template);
          break;
        }
        for (const key of template.propertyKeys) {
          if (!customerVisible(key)) add(`${path}.template`, 'property_unavailable', key);
        }
        break;
      }
      case 'create_task':
        if (step.title !== null) {
          const parsed = parseTextVariables(step.title, TASK_TITLE_VARIABLES);
          if (!parsed.ok) {
            add(`${path}.title`, 'invalid_variable', parsed.name);
          } else {
            for (const key of titlePropertyKeys(step.title)) {
              if (!titleUsable(key)) add(`${path}.title`, 'property_unavailable', key);
            }
          }
        }
        if (step.assignee.kind === 'member') member(`${path}.assignee`, step.assignee.actorId);
        break;
      case 'assign_lead':
        if (step.actorId !== null) member(`${path}.actorId`, step.actorId);
        break;
      case 'update_lead':
        if (step.change === null || checkable === null) break;
        if (step.change.kind === 'stage') {
          const { stage } = step.change;
          if (!checkable.every((leadType) => isLeadStage(leadType, stage))) {
            add(`${path}.change`, 'stage_unavailable', stage);
          }
        } else if (!editable(step.change.key)) {
          add(`${path}.change`, 'property_unavailable', step.change.key);
        }
        break;
      case 'notify_staff':
        step.actorIds.forEach((actorId, index) => member(`${path}.actorIds.${index}`, actorId));
        break;
      case 'if_else':
        if (step.condition) visitGroup(step.condition, `${path}.condition`);
        break;
      case 'wait':
        break;
    }
  });
  return issues;
}

// ---------------------------------------------------------------------------
// Overlap warnings (O10)

export interface FlowForOverlap {
  readonly key: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly definition: FlowDefinition | null;
}

export const flowOverlapWarningSchema = z.object({
  event: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('lead_submitted'), leadType: leadTypeSchema }),
    z.object({
      kind: z.literal('stage_entered'),
      leadType: leadTypeSchema,
      stage: leadStageSchema,
    }),
  ]),
  flows: z
    .array(z.object({ key: automationKeySchema, name: z.string() }))
    .min(2)
    .max(AUTOMATION_MAX_FLOWS),
  message: z.string().max(2000),
});
export type FlowOverlapWarning = z.infer<typeof flowOverlapWarningSchema>;

/** Whether the flow mails the customer before its first wait (either branch of an if/else may run). */
function mailsBeforeWait(steps: readonly FlowStep[]): boolean {
  for (const step of steps) {
    if (step.kind === 'wait') return false;
    if (step.kind === 'send_email') return true;
    if (step.kind === 'if_else') return mailsBeforeWait(step.then) || mailsBeforeWait(step.else);
  }
  return false;
}

/** "a SIM order", "an internet": the label as it reads mid-sentence, an acronym kept. */
function typeInWords(leadType: string): string {
  const label = leadTypeLabel(leadType);
  const [first = '', ...rest] = label.split(' ');
  const word = first === first.toUpperCase() ? first : first.toLowerCase();
  const phrase = [word, ...rest].join(' ');
  return `${/^[aeiou]/i.test(phrase) ? 'an' : 'a'} ${phrase}`;
}

/**
 * One warning per event on which two or more flows that are on each mail the
 * customer before any wait: a submission of one lead type (which also counts
 * as entering the stage it stands in once submitted, R4), or a move of one
 * type into one stage. Both still send; the page says so.
 */
export function overlappingEmailFlows(flows: readonly FlowForOverlap[]): FlowOverlapWarning[] {
  type Bucket = {
    event: FlowOverlapWarning['event'];
    flows: { key: string; name: string }[];
    submissions: number;
  };
  const buckets = new Map<string, Bucket>();
  const put = (id: string, event: Bucket['event'], flow: FlowForOverlap, submission: boolean) => {
    const bucket = buckets.get(id) ?? { event, flows: [], submissions: 0 };
    buckets.set(id, bucket);
    if (bucket.flows.some((entry) => entry.key === flow.key)) return;
    bucket.flows.push({ key: flow.key, name: flow.name });
    if (submission) bucket.submissions += 1;
  };
  for (const flow of flows) {
    const { definition } = flow;
    if (!flow.enabled || !definition || !mailsBeforeWait(definition.steps)) continue;
    const { trigger } = definition;
    if (trigger.kind === 'lead_submitted') {
      for (const leadType of trigger.leadTypes) {
        put(`submitted:${leadType}`, { kind: 'lead_submitted', leadType }, flow, true);
      }
    } else if (trigger.kind === 'stage_entered') {
      const { leadType, stage } = trigger;
      put(`stage:${leadType}:${stage}`, { kind: 'stage_entered', leadType, stage }, flow, false);
      if (submittedLeadStage(leadType) === stage) {
        put(`submitted:${leadType}`, { kind: 'lead_submitted', leadType }, flow, false);
      }
    }
  }
  const warnings: FlowOverlapWarning[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.flows.length < 2) continue;
    // Stage flows alone on a submission are warned about on their stage's own event.
    if (bucket.event.kind === 'lead_submitted' && bucket.submissions === 0) continue;
    const words =
      bucket.event.kind === 'lead_submitted'
        ? `${typeInWords(bucket.event.leadType)} is submitted`
        : `${typeInWords(bucket.event.leadType)} moves to ${leadStageLabel(bucket.event.leadType, bucket.event.stage)}`;
    warnings.push({
      event: bucket.event,
      flows: bucket.flows,
      message: `Customers get ${bucket.flows.length} emails when ${words}: ${bucket.flows
        .map((entry) => entry.name)
        .join(', ')}.`,
    });
  }
  return warnings;
}
