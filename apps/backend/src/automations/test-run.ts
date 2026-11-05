import { auditEvents, type TenantTransaction } from '@gt-sales/db';
import {
  initialLeadStage,
  isStageMoveAllowed,
  leadTypeSchema,
  stageGates,
  triggerLeadTypes,
  type AutomationKey,
  type AutomationReason,
  type AutomationRunStatus,
  type Condition,
  type ConditionGroup,
  type FlowDefinition,
  type FlowSite,
  type FlowStep,
  type FlowStepRun,
  type LeadPropertyFilter,
  type LeadType,
  type PropertyCatalog,
} from '@gt-sales/contracts';

import { composeCustomerEmail } from '../email/compose.js';
import { queueComposedEmail } from '../email/queue.js';
import { resolveSiteSender, type CustomerEmailEnvironment } from '../email/senders.js';
import type { WriteScope } from '../tenant-scope.js';
import { loadFlowSite } from './site.js';
import { evaluateSyntheticConditionGroup } from './conditions.js';
import { resolvePropertyFor } from '../leads/staff-queries.js';

export interface SampleLeadState {
  leadType: LeadType;
  stage: string;
  planId: string | null;
  assignedActorId: string | null;
  properties: Map<string, string | number | boolean | null>;
}

interface AnyConditionGroup {
  readonly match: 'all' | 'any';
  readonly items: readonly (Condition | AnyConditionGroup)[];
}

const isGroup = (item: Condition | AnyConditionGroup): item is AnyConditionGroup => 'match' in item;

/** Picks a first plan id or member id referenced in `in`/`is` conditions so the primary path has sample data. */
function seedFromGroup(
  group: AnyConditionGroup | null,
  site: FlowSite,
  lead: SampleLeadState,
): void {
  if (!group) return;
  for (const item of group.items) {
    if (isGroup(item)) {
      seedFromGroup(item, site, lead);
      continue;
    }
    if (item.kind === 'plan' && item.op === 'in' && lead.planId === null) {
      const matching = item.planIds.find((id) => site.plans.has(id));
      if (matching) lead.planId = matching;
    } else if (
      item.kind === 'assignee' &&
      item.op === 'is' &&
      item.actorId &&
      !lead.assignedActorId
    ) {
      if (site.memberIds.has(item.actorId)) lead.assignedActorId = item.actorId;
    } else if (item.kind === 'property' && !lead.properties.has(item.filter.key)) {
      const val = item.filter.value;
      if (
        item.filter.op === 'eq' &&
        (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean')
      ) {
        lead.properties.set(item.filter.key, val);
      } else if (item.filter.op === 'in' && Array.isArray(val) && typeof val[0] === 'string') {
        lead.properties.set(item.filter.key, val[0]);
      }
    }
  }
}

/** Why the sample lead could not move to `to`, as the live engine would say; null when it could. */
function sampleStageRefusal(
  lead: SampleLeadState,
  to: string,
): { reason: AutomationReason; detail: string } | null {
  if (lead.stage === to) return null;
  if (!isStageMoveAllowed(lead.leadType, lead.stage, to)) {
    return { reason: 'illegal_stage_move', detail: `${lead.stage} to ${to}` };
  }
  for (const gate of stageGates(lead.leadType, to)) {
    if (gate === 'dispatch') {
      return { reason: 'dispatch_details_required', detail: 'the sample lead has no courier' };
    }
    if (gate === 'documents') {
      return {
        reason: 'documents_incomplete',
        detail: 'the sample lead has no approved documents',
      };
    }
    // `activation` dates itself today when a flow moves the lead.
  }
  return null;
}

function seedFromSteps(steps: readonly FlowStep[], site: FlowSite, lead: SampleLeadState): void {
  for (const step of steps) {
    if (step.kind === 'if_else') {
      seedFromGroup(step.condition, site, lead);
      seedFromSteps(step.then, site, lead);
      seedFromSteps(step.else, site, lead);
    }
  }
}

function initialSampleLead(definition: FlowDefinition, site: FlowSite): SampleLeadState {
  const types = triggerLeadTypes(definition.trigger);
  const parsedLeadType = leadTypeSchema.safeParse(types[0]);
  const leadType: LeadType = parsedLeadType.success ? parsedLeadType.data : 'sim_order';
  const stage =
    definition.trigger.kind === 'stage_entered' || definition.trigger.kind === 'time_in_stage'
      ? definition.trigger.stage
      : initialLeadStage(leadType);

  let defaultPlanId: string | null = null;
  for (const [planId, plan] of site.plans.entries()) {
    if (plan.leadType === leadType) {
      defaultPlanId = planId;
      break;
    }
  }
  const firstMember = site.memberIds.values().next().value ?? null;
  const sample: SampleLeadState = {
    leadType,
    stage,
    planId: null,
    assignedActorId: null,
    properties: new Map(),
  };
  seedFromGroup(definition.trigger.when, site, sample);
  seedFromSteps(definition.steps, site, sample);
  if (sample.planId === null) sample.planId = defaultPlanId;
  if (sample.assignedActorId === null) sample.assignedActorId = firstMember;
  return sample;
}

function evaluatePropertyFilter(
  filter: LeadPropertyFilter,
  lead: SampleLeadState,
  catalog: PropertyCatalog,
): boolean {
  const property = resolvePropertyFor(catalog, filter.key, lead.leadType);
  if (!property || property.hidden || property.sensitive) return false;
  const raw = lead.properties.get(filter.key) ?? null;
  const val = filter.value;
  switch (filter.op) {
    case 'notEmpty':
      return raw !== null && (typeof raw !== 'string' || raw.replace(/^ +| +$/g, '') !== '');
    case 'empty':
      return raw === null || (typeof raw === 'string' && raw.replace(/^ +| +$/g, '') === '');
    case 'eq':
      if (
        ['text', 'longText', 'email', 'phone', 'url'].includes(property.kind) &&
        typeof raw === 'string' &&
        typeof val === 'string'
      )
        return (
          raw.replace(/^ +| +$/g, '').toLowerCase() === val.replace(/^ +| +$/g, '').toLowerCase()
        );
      return raw === val;
    case 'contains':
      return (
        typeof raw === 'string' &&
        typeof val === 'string' &&
        raw.toLowerCase().includes(val.toLowerCase())
      );
    case 'in':
      return typeof raw === 'string' && Array.isArray(val) && val.includes(raw);
    case 'gte':
      return (
        (typeof raw === 'number' && typeof val === 'number' && raw >= val) ||
        (typeof raw === 'string' && typeof val === 'string' && raw >= val)
      );
    case 'lte':
      return (
        (typeof raw === 'number' && typeof val === 'number' && raw <= val) ||
        (typeof raw === 'string' && typeof val === 'string' && raw <= val)
      );
  }
}

function evaluateCondition(
  condition: Condition,
  lead: SampleLeadState,
  catalog: PropertyCatalog,
): boolean {
  switch (condition.kind) {
    case 'lead_type':
      return condition.in.includes(lead.leadType);
    case 'stage':
      return condition.op === 'in'
        ? condition.stages.includes(lead.stage)
        : !condition.stages.includes(lead.stage);
    case 'plan':
      return condition.op === 'in'
        ? lead.planId !== null && condition.planIds.includes(lead.planId)
        : lead.planId === null || !condition.planIds.includes(lead.planId);
    case 'assignee':
      if (condition.op === 'none') return lead.assignedActorId === null;
      if (condition.op === 'any') return lead.assignedActorId !== null;
      return condition.actorId !== undefined && lead.assignedActorId === condition.actorId;
    case 'property':
      return evaluatePropertyFilter(condition.filter, lead, catalog);
  }
}

export function evaluateSampleConditionGroup(
  group: ConditionGroup,
  lead: SampleLeadState,
  catalog: PropertyCatalog,
): boolean {
  const checkGroup = (current: AnyConditionGroup): boolean => {
    if (current.items.length === 0) return current.match === 'all';
    return current.match === 'all'
      ? current.items.every((item) =>
          isGroup(item) ? checkGroup(item) : evaluateCondition(item, lead, catalog),
        )
      : current.items.some((item) =>
          isGroup(item) ? checkGroup(item) : evaluateCondition(item, lead, catalog),
        );
  };
  return checkGroup(group);
}

/**
 * Records that a member ran a flow test. A test can queue real mail from the
 * site's sender, so who ran it, which flow and how many mails it queued are
 * audited — never the address or any content.
 */
export async function recordFlowTest(
  tx: TenantTransaction,
  input: { scope: WriteScope; flowId: string; flowKey: AutomationKey; emailsQueued: number },
): Promise<void> {
  await tx.insert(auditEvents).values({
    workspaceId: input.scope.workspaceId,
    actorId: input.scope.actorId,
    actorLabel: 'staff actor',
    action: 'automation.tested',
    entity: 'automation',
    entityId: input.flowId,
    requestId: input.scope.requestId,
    after: { key: input.flowKey, emailsQueued: input.emailsQueued },
  });
}

export interface FlowTestRunResult {
  status: AutomationRunStatus;
  reason: AutomationReason | null;
  detail: string | null;
  emailsQueued: number;
  steps: FlowStepRun[];
}

/**
 * Runs a flow definition against sample lead data without changing real leads.
 * Any `send_email` step reached is composed with sample fill-ins and queued to
 * `email` when provided. The route passes only the caller's own verified
 * sign-in address here, never a request value.
 */
export async function runFlowTest(
  tx: TenantTransaction,
  input: {
    scope: WriteScope;
    flowKey: AutomationKey;
    definition: FlowDefinition;
    email?: string;
    customerEmailEnvironment: CustomerEmailEnvironment | undefined;
    simulation?: { sample: SampleLeadState };
  },
): Promise<FlowTestRunResult> {
  const { scope, flowKey, definition, email, customerEmailEnvironment } = input;
  const site = await loadFlowSite(tx, scope.workspaceId);
  const lead = input.simulation
    ? structuredClone(input.simulation.sample)
    : initialSampleLead(definition, site);
  const steps: FlowStepRun[] = [];
  let emailsQueued = 0;

  async function walk(list: readonly FlowStep[]): Promise<void> {
    for (const step of list) {
      const at = new Date().toISOString();
      switch (step.kind) {
        case 'if_else': {
          const holds = input.simulation
            ? await evaluateSyntheticConditionGroup(tx, step.condition, lead, site.catalog)
            : evaluateSampleConditionGroup(step.condition, lead, site.catalog);
          const branch = holds ? 'yes' : 'no';
          steps.push({
            stepId: step.id,
            stepKind: 'if_else',
            outcome: 'done',
            branch,
            reason: null,
            detail: null,
            at,
          });
          await walk(holds ? step.then : step.else);
          break;
        }
        case 'wait': {
          steps.push({
            stepId: step.id,
            stepKind: 'wait',
            outcome: 'done',
            branch: null,
            reason: null,
            detail: `${step.for.amount} ${step.for.unit}`,
            at,
          });
          break;
        }
        case 'create_task': {
          if (step.assignee.kind === 'member' && !site.memberIds.has(step.assignee.actorId)) {
            steps.push({
              stepId: step.id,
              stepKind: 'create_task',
              outcome: 'skipped',
              branch: null,
              reason: 'member_unavailable',
              detail: step.assignee.actorId,
              at,
            });
            break;
          }
          steps.push({
            stepId: step.id,
            stepKind: 'create_task',
            outcome: 'done',
            branch: null,
            reason: null,
            detail: step.title.slice(0, 200),
            at,
          });
          break;
        }
        case 'assign_lead': {
          // As live: an owned lead is only taken over with `reassign` (AUTH-2).
          if (lead.assignedActorId !== null && !step.reassign) {
            steps.push({
              stepId: step.id,
              stepKind: 'assign_lead',
              outcome: 'skipped',
              branch: null,
              reason: 'already_assigned',
              detail: null,
              at,
            });
            break;
          }
          if (!site.memberIds.has(step.actorId)) {
            steps.push({
              stepId: step.id,
              stepKind: 'assign_lead',
              outcome: 'skipped',
              branch: null,
              reason: 'member_unavailable',
              detail: step.actorId,
              at,
            });
            break;
          }
          lead.assignedActorId = step.actorId;
          steps.push({
            stepId: step.id,
            stepKind: 'assign_lead',
            outcome: 'done',
            branch: null,
            reason: null,
            detail: step.actorId,
            at,
          });
          break;
        }
        case 'update_lead': {
          if (step.change.kind === 'stage') {
            // As live (AUTH-2, ENG-L5): the type's allowed moves, then its
            // gates. The sample lead has no courier and no documents, so a
            // move gated on them is skipped for it, as it would be live.
            const refusal = sampleStageRefusal(lead, step.change.stage);
            if (refusal) {
              steps.push({
                stepId: step.id,
                stepKind: 'update_lead',
                outcome: 'skipped',
                branch: null,
                reason: refusal.reason,
                detail: refusal.detail,
                at,
              });
              break;
            }
            lead.stage = step.change.stage;
            steps.push({
              stepId: step.id,
              stepKind: 'update_lead',
              outcome: 'done',
              branch: null,
              reason: null,
              detail: step.change.stage,
              at,
            });
          } else {
            const prop = site.catalog.get(step.change.key);
            if (!prop || prop.sensitive) {
              steps.push({
                stepId: step.id,
                stepKind: 'update_lead',
                outcome: 'skipped',
                branch: null,
                reason: 'invalid_field',
                detail: step.change.key,
                at,
              });
            } else {
              lead.properties.set(step.change.key, step.change.value);
              steps.push({
                stepId: step.id,
                stepKind: 'update_lead',
                outcome: 'done',
                branch: null,
                reason: null,
                detail: step.change.key,
                at,
              });
            }
          }
          break;
        }
        case 'send_email': {
          if (input.simulation) {
            steps.push({
              stepId: step.id,
              stepKind: step.kind,
              outcome: 'done',
              branch: null,
              reason: null,
              detail: 'Simulated; no email queued',
              at,
            });
            break;
          }
          if (!email) {
            steps.push({
              stepId: step.id,
              stepKind: 'send_email',
              outcome: 'skipped',
              branch: null,
              reason: 'no_customer_email',
              detail: step.template,
              at,
            });
            break;
          }
          if (!customerEmailEnvironment) {
            steps.push({
              stepId: step.id,
              stepKind: 'send_email',
              outcome: 'skipped',
              branch: null,
              reason: 'no_sender',
              detail: step.template,
              at,
            });
            break;
          }
          const composed = await composeCustomerEmail(tx, customerEmailEnvironment, {
            workspaceId: scope.workspaceId,
            template: step.template,
            recipient: { kind: 'staff_test', toAddress: email },
            catalog: site.catalog,
          });
          if (composed.kind === 'skipped') {
            steps.push({
              stepId: step.id,
              stepKind: 'send_email',
              outcome: 'skipped',
              branch: null,
              reason: composed.reason,
              detail:
                composed.missing && composed.missing.length > 0
                  ? composed.missing.join(',')
                  : step.template,
              at,
            });
            break;
          }
          const dedupeKey = `test_flow:${flowKey}:${step.id}:${scope.actorId}:${scope.requestId}`;
          const queued = await queueComposedEmail(tx, {
            workspaceId: scope.workspaceId,
            actorId: scope.actorId,
            requestId: scope.requestId,
            leadId: null,
            dedupeKey,
            payload: composed.payload,
            automation: null,
          });
          if (queued.queued) emailsQueued += 1;
          steps.push({
            stepId: step.id,
            stepKind: 'send_email',
            outcome: 'done',
            branch: null,
            reason: null,
            detail: step.template,
            at,
          });
          break;
        }
        case 'notify_staff': {
          const sender = customerEmailEnvironment?.providerReady
            ? await resolveSiteSender(tx, scope.workspaceId)
            : undefined;
          const recipients = [
            ...(step.toAssignee && lead.assignedActorId ? [lead.assignedActorId] : []),
            ...step.actorIds,
          ];
          if (recipients.length === 0) {
            steps.push({
              stepId: step.id,
              stepKind: 'notify_staff',
              outcome: 'skipped',
              branch: null,
              reason: 'member_unavailable',
              detail: null,
              at,
            });
            break;
          }
          if (!input.simulation && !sender && !email) {
            steps.push({
              stepId: step.id,
              stepKind: 'notify_staff',
              outcome: 'skipped',
              branch: null,
              reason: 'no_staff_sender',
              detail: null,
              at,
            });
            break;
          }
          steps.push({
            stepId: step.id,
            stepKind: 'notify_staff',
            outcome: 'done',
            branch: null,
            reason: null,
            detail: step.note ? step.note.slice(0, 200) : null,
            at,
          });
          break;
        }
      }
    }
  }

  await walk(definition.steps);

  const actionSteps = steps.filter((step) => step.stepKind !== 'if_else');
  const anyDone = actionSteps.some((step) => step.outcome === 'done');
  const firstSkipped = actionSteps.find((step) => step.outcome === 'skipped');
  const status: AutomationRunStatus = anyDone || actionSteps.length === 0 ? 'completed' : 'skipped';

  return {
    status,
    reason: status === 'skipped' ? (firstSkipped?.reason ?? null) : null,
    detail: status === 'skipped' ? (firstSkipped?.detail ?? null) : null,
    emailsQueued,
    steps,
  };
}
