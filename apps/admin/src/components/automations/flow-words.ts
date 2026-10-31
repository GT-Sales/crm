import {
  automationReasonSchema,
  emailTemplateLabel,
  leadTypeCatalog,
  isSiteTemplateKey,
  type AutomationReason,
  type Condition,
  type ConditionGroup,
  type Duration,
  type FlowCatalogResponse,
  type FlowDraftStep,
  type FlowDraftTrigger,
  type FlowIssue,
  type FlowRun,
  type FlowStep,
  type FlowSummary,
  type FlowTrigger,
} from '@gt-sales/contracts';

/**
 * Flows in words, for the Automations list, a flow's read-only page and (in
 * Step B) the canvas: the trigger, a condition, each step, a run's status
 * and why a run or a flow stopped. Every key is named through `FlowNames`,
 * which reads the site's catalogue; anything it no longer knows reads as its
 * key, so a removed stage or template still shows what the flow names.
 */

export interface FlowNames {
  leadType(key: string): string;
  /** `type` may be '' when the step does not know it (an Update lead step): any type's label. */
  stage(type: string, key: string): string;
  template(key: string): string;
  member(actorId: string): string;
  plan(id: string): string;
  property(key: string): string;
  /** A choice property's option label, else the value. */
  option(key: string, value: string): string;
}

/** How a lead type reads mid-sentence: "SIM order", "internet lead". */
const TYPE_NOUNS: Readonly<Record<string, string>> = {
  sim_order: 'SIM order',
  internet: 'internet lead',
  mobility: 'mobility order',
  partner_application: 'partner application',
  contact_message: 'contact message',
};

export function namesFromCatalog(
  catalog: Pick<
    FlowCatalogResponse,
    'leadTypes' | 'templates' | 'members' | 'plans' | 'properties'
  >,
): FlowNames {
  const types = new Map(catalog.leadTypes.map((type) => [type.key, type]));
  const templates = new Map(catalog.templates.map((template) => [template.key, template.name]));
  const members = new Map(catalog.members.map((member) => [member.actorId, member.displayName]));
  const plans = new Map(catalog.plans.map((plan) => [plan.id, plan.name]));
  const properties = new Map(catalog.properties.map((property) => [property.key, property]));
  return {
    leadType: (key) => types.get(key)?.label ?? key,
    stage: (type, key) => {
      const own = types.get(type)?.stages.find((stage) => stage.key === key);
      if (own) return own.label;
      for (const entry of catalog.leadTypes) {
        const stage = entry.stages.find((candidate) => candidate.key === key);
        if (stage) return stage.label;
      }
      return key;
    },
    template: (key) => templates.get(key) ?? emailTemplateLabel(key),
    member: (actorId) => members.get(actorId) ?? 'a former teammate',
    plan: (id) => plans.get(id) ?? 'a plan no longer on this site',
    property: (key) => properties.get(key)?.label ?? key,
    option: (key, value) =>
      properties.get(key)?.options?.find((option) => option.value === value)?.label ?? value,
  };
}

/**
 * Names from code alone (lead types, stages, built-in email labels), for the
 * Automations list, which shows triggers only and reads no catalogue.
 */
export function namesFromCode(): FlowNames {
  return namesFromCatalog({
    leadTypes: Object.entries(leadTypeCatalog).map(([key, entry]) => ({
      key,
      label: entry.label,
      stages: entry.stages.map((stage) => ({ key: stage.key, label: stage.label })),
    })),
    templates: [],
    members: [],
    plans: [],
    properties: [],
  });
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** `a`, `a or b`, `a, b or c` (or `and`). */
function joined(items: readonly string[], word: 'or' | 'and'): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${word} ${items.at(-1) ?? ''}`;
}

/** "a SIM order", "an internet lead". */
function withArticle(noun: string): string {
  return `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`;
}

function typeNoun(leadType: string, names: FlowNames): string {
  return TYPE_NOUNS[leadType] ?? names.leadType(leadType).toLowerCase();
}

/** "a SIM order", "a SIM order or an internet lead", "a lead" for none. */
function typesInWords(leadTypes: readonly string[], names: FlowNames): string {
  if (leadTypes.length === 0) return 'a lead';
  return joined(
    leadTypes.map((leadType) => withArticle(typeNoun(leadType, names))),
    'or',
  );
}

/** "3 days", "1 hour". */
export function durationText(duration: Duration): string {
  const unit = duration.unit === 'days' ? 'day' : 'hour';
  return `${duration.amount} ${unit}${duration.amount === 1 ? '' : 's'}`;
}

/** The trigger in one sentence: "A SIM order moves to Delivered". */
export function describeTrigger(trigger: FlowTrigger | FlowDraftTrigger, names: FlowNames): string {
  switch (trigger.kind) {
    case 'lead_submitted':
      return capitalize(`${typesInWords(trigger.leadTypes, names)} is submitted`);
    case 'stage_entered':
      if (trigger.leadType === null) return 'A lead moves to a stage';
      return capitalize(
        `${typesInWords([trigger.leadType], names)} moves to ${
          trigger.stage === null ? 'a stage' : names.stage(trigger.leadType, trigger.stage)
        }`,
      );
    case 'time_in_stage': {
      if (trigger.leadType === null) return 'A lead has been in a stage for a while';
      const stage =
        trigger.stage === null ? 'a stage' : names.stage(trigger.leadType, trigger.stage);
      const after = trigger.after === null ? 'a while' : durationText(trigger.after);
      return capitalize(
        `${typesInWords([trigger.leadType], names)} has been in ${stage} for ${after}`,
      );
    }
    case 'task_overdue': {
      const on =
        trigger.leadTypes.length === 0 ? '' : ` on ${typesInWords(trigger.leadTypes, names)}`;
      const after = trigger.after === null ? '' : ` by ${durationText(trigger.after)}`;
      return `A follow-up task${on} is overdue${after}`;
    }
    case 'after_submitted': {
      const after = trigger.after === null ? 'a while' : durationText(trigger.after);
      return capitalize(`${typesInWords(trigger.leadTypes, names)} was submitted ${after} ago`);
    }
  }
}

function propertyValueText(key: string, value: unknown, names: FlowNames): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return names.option(key, value);
  if (Array.isArray(value)) {
    return joined(
      value.map((entry) => propertyValueText(key, entry, names)),
      'or',
    );
  }
  return 'nothing';
}

function conditionText(condition: Condition, names: FlowNames): string {
  switch (condition.kind) {
    case 'lead_type':
      return `the lead type is ${joined(condition.in.map(names.leadType), 'or')}`;
    case 'stage': {
      const stages = joined(
        condition.stages.map((stage) => names.stage('', stage)),
        'or',
      );
      return condition.op === 'in' ? `the stage is ${stages}` : `the stage is not ${stages}`;
    }
    case 'plan': {
      const plans = joined(condition.planIds.map(names.plan), 'or');
      return condition.op === 'in' ? `the plan is ${plans}` : `the plan is not ${plans}`;
    }
    case 'assignee':
      if (condition.op === 'none') return 'no one owns the lead';
      if (condition.op === 'any') return 'someone owns the lead';
      return `${names.member(condition.actorId ?? '')} owns the lead`;
    case 'property': {
      const { key, op, value } = condition.filter;
      const label = names.property(key);
      switch (op) {
        case 'eq':
        case 'in':
          return `${label} is ${propertyValueText(key, value, names)}`;
        case 'contains':
          return `${label} contains ${propertyValueText(key, value, names)}`;
        case 'lte':
          return `${label} is at most ${propertyValueText(key, value, names)}`;
        case 'gte':
          return `${label} is at least ${propertyValueText(key, value, names)}`;
        case 'empty':
          return `${label} is empty`;
        case 'notEmpty':
          return `${label} is filled in`;
      }
    }
  }
}

interface AnyGroup {
  readonly match: 'all' | 'any';
  readonly items: readonly (Condition | AnyGroup)[];
}

function groupText(group: AnyGroup, names: FlowNames, nested: boolean): string {
  const parts = group.items.map((item) =>
    'match' in item ? groupText(item, names, true) : conditionText(item, names),
  );
  if (parts.length === 1) return parts[0] ?? '';
  const text = `${group.match === 'all' ? 'all of' : 'any of'}: ${parts.join('; ')}`;
  return nested ? `(${text})` : text;
}

/** A condition group in words: "the plan is Student or Visitor", "all of: …; …". */
export function describeCondition(group: ConditionGroup, names: FlowNames): string {
  return groupText(group, names, false);
}

function dueText(dueInDays: number | null): string {
  if (dueInDays === null) return '';
  if (dueInDays === 0) return ' due today';
  return ` due in ${dueInDays} day${dueInDays === 1 ? '' : 's'}`;
}

/** One step as a sentence: "Send the Dispatched email", "Wait 2 days". */
export function describeStep(step: FlowStep | FlowDraftStep, names: FlowNames): string {
  switch (step.kind) {
    case 'send_email':
      if (step.template === null) return 'Send an email (not chosen yet)';
      return isSiteTemplateKey(step.template)
        ? `Send the email "${names.template(step.template)}"`
        : `Send the ${names.template(step.template)} email`;
    case 'wait':
      return step.for === null
        ? 'Wait (how long is not set yet)'
        : `Wait ${durationText(step.for)}`;
    case 'if_else':
      return step.condition === null
        ? 'If (no condition yet)'
        : `If ${describeCondition(step.condition, names)}`;
    case 'create_task': {
      const title = step.title === null ? 'a task' : `the task "${step.title}"`;
      const assignee =
        step.assignee.kind === 'lead_assignee'
          ? " for the lead's owner"
          : step.assignee.kind === 'member'
            ? ` for ${names.member(step.assignee.actorId)}`
            : ' for no one in particular';
      return `Create ${title}${dueText(step.dueInDays)}${assignee}`;
    }
    case 'assign_lead': {
      if (step.actorId === null) return 'Assign the lead (to no one chosen yet)';
      const member = names.member(step.actorId);
      return step.reassign
        ? `Assign the lead to ${member}`
        : `Assign the lead to ${member} (if no one owns it)`;
    }
    case 'update_lead':
      if (step.change === null) return 'Change the lead (not chosen yet)';
      if (step.change.kind === 'stage')
        return `Move the lead to ${names.stage('', step.change.stage)}`;
      return step.change.value === null
        ? `Clear ${names.property(step.change.key)}`
        : `Set ${names.property(step.change.key)} to ${propertyValueText(
            step.change.key,
            step.change.value,
            names,
          )}`;
    case 'notify_staff': {
      const people = [
        ...step.actorIds.map(names.member),
        ...(step.toAssignee ? ["the lead's owner"] : []),
      ];
      return people.length === 0
        ? 'Email staff (no one chosen yet)'
        : `Email ${joined(people, 'and')}`;
    }
  }
}

const REASONS: Readonly<Record<AutomationReason, string>> = {
  no_sender: 'the site has no sender yet',
  no_customer_email: 'the customer has no email address',
  missing_fill_in: 'the email needs fill-ins the lead does not have',
  already_sent: 'the email was already sent',
  compose_failed: 'the email could not be made',
  step_failed: 'a step failed',
  definition_invalid: 'the flow can no longer be read',
  stage_unavailable: 'names a stage that no longer exists',
  template_unavailable: 'names an email that no longer exists',
  property_unavailable: 'names a property it may not use',
  plan_unavailable: 'names a plan this site does not have',
  member_unavailable: 'names a member who is no longer on this site',
  lead_type_unavailable: 'names a lead type that no longer exists',
  invalid_variable: 'uses a fill-in that does not exist',
  chain_too_deep: 'too many automations ran one after another',
  loop_prevented: 'it would have run again in the same chain',
  already_assigned: 'the lead already has an owner',
  activator_not_allowed: 'the member who activated it may no longer change leads',
  illegal_stage_move: 'that stage move is not allowed',
  dispatch_details_required: 'the move needs the dispatch details',
  activation_details_required: 'the move needs the activation details',
  documents_incomplete: 'the required documents are not approved',
  invalid_field: 'a value does not fit its property',
  no_staff_sender: 'staff email is not set up',
  member_has_no_address: 'a member has no email address on file',
  lead_archived: 'the lead was archived',
  flow_switched_off: 'the flow was switched off',
  resume_failed: 'it could not carry on after the wait',
};

/** Why a run or a step stopped: "names a stage that no longer exists (paid)". */
export function reasonText(reason: AutomationReason, detail: string | null): string {
  const words = REASONS[reason];
  return detail === null || detail === '' ? words : `${words} (${detail})`;
}

/** A flow issue in the same words (its `ref` as the detail). */
export function issueText(issue: FlowIssue): string {
  const reason = automationReasonSchema.parse(issue.code);
  return reasonText(reason, issue.code === 'definition_invalid' ? null : issue.ref);
}

const RESUME_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/Toronto',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** "3 Nov 14:00" in Toronto. */
export function resumeLabel(iso: string): string {
  return RESUME_FORMAT.format(new Date(iso)).replace(',', '');
}

/** A run's status in words: "Completed", "Waiting until 3 Nov 14:00", "Skipped: …". */
export function runStatusText(run: FlowRun): string {
  const why = run.reason === null ? '' : `: ${reasonText(run.reason, run.detail)}`;
  switch (run.status) {
    case 'completed':
      return 'Completed';
    case 'waiting':
      return run.resumeAt === null ? 'Waiting' : `Waiting until ${resumeLabel(run.resumeAt)}`;
    case 'skipped':
      return `Skipped${why}`;
    case 'failed':
      return `Failed${why}`;
    case 'cancelled':
      return `Cancelled${why}`;
  }
}

/** The list's status chip: needs attention, else not activated, else draft changes, else none. */
export function flowStatusChip(
  flow: FlowSummary,
): { label: string; tone: 'warning' | 'neutral' } | null {
  if (flow.needsAttention) {
    return { label: `Needs attention: ${issueText(flow.needsAttention)}`, tone: 'warning' };
  }
  if (flow.activeVersion === null) return { label: 'Not activated', tone: 'neutral' };
  if (flow.hasDraft) return { label: 'Draft changes', tone: 'neutral' };
  return null;
}
