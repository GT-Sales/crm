import { sql } from 'drizzle-orm';
import type { TenantTransaction } from '@gt-sales/db';
import {
  ANY_PROPERTY_VARIABLE,
  BUILT_IN_STEP_ID,
  FLOW_TASK_VARIABLES,
  AUTOMATION_MAX_CHAIN_DEPTH,
  emailTemplateLabel,
  isSiteTemplateKey,
  membershipStatusSchema,
  parseTextVariables,
  staffPermissionNameSchema,
  staffRoleNameSchema,
  type PropertyCatalog,
  type AutomationReason,
  type AutomationStepOutcome,
  type EmailSkipped,
  type EmailTemplateKey,
  type FlowSite,
  type FlowStep,
  type LeadActivity,
} from '@gt-sales/contracts';

import { permissionEffects } from '@gt-sales/types';
import { z } from 'zod';

import { composeCustomerEmail } from '../email/compose.js';
import { fillInValuesForLead, leadPropertyText } from '../email/fill-in-values.js';
import { queueComposedEmail } from '../email/queue.js';
import { readEmailTemplate } from '../email/settings-store.js';
import { todayInToronto } from '../leads/stage-move.js';
import {
  applyLeadUpdate,
  insertLeadTask,
  type AutomationAttribution,
  type LeadUpdateContext,
  type UpdateLeadWorkOutcome,
} from '../leads/work-store.js';
import { decideAccess, type StaffAccessSnapshot } from '../staff/authorization.js';
import type { FireFlowsContext, FireFlowsResult, LiveFlow, RunState } from './engine.js';
import { notifyStaffStep } from './staff-notification.js';
import type { AutomationLead } from './run.js';

/**
 * The step executors (spec §5's table). Each runs inside its own savepoint
 * (the engine's), reads the lead as stored now, and says what happened as a
 * `StepResult` the engine records; a skip is a reason the run goes on with,
 * a throw is the step failed.
 */

export interface StepContext {
  tx: TenantTransaction;
  fire: FireFlowsContext;
  run: RunState;
  lead: AutomationLead;
  site: FlowSite;
}

export interface StepResult {
  outcome: AutomationStepOutcome;
  reason?: AutomationReason;
  detail?: string;
  jobId?: string;
  taskId?: string;
  branch?: 'yes' | 'no';
  emailSkipped?: EmailSkipped;
  activities?: LeadActivity[];
  nested?: FireFlowsResult;
}

export type ActionStep = Exclude<FlowStep, { kind: 'if_else' | 'wait' }>;

/** Runs one action step. */
export function runActionStep(ctx: StepContext, step: ActionStep): Promise<StepResult> {
  switch (step.kind) {
    case 'send_email':
      return sendEmailStep(ctx, step);
    case 'create_task':
      return createTaskStep(ctx, step);
    case 'assign_lead':
      return assignLeadStep(ctx, step);
    case 'update_lead':
      return updateLeadStep(ctx, step);
    case 'notify_staff':
      return notifyStaffStep(ctx, step);
  }
}

const permissionEffectSchema = z.enum(permissionEffects);

const accessRowSchema = z.object({
  membershipId: z.uuid(),
  status: membershipStatusSchema,
  roleNames: z.array(staffRoleNameSchema),
  permissionRows: z.array(
    z.object({ name: staffPermissionNameSchema, effect: permissionEffectSchema }),
  ),
});

/** R5: the activator is an active member holding `lead.manage` now (the routes' own decision). */
export async function activatorMayChangeLeads(
  tx: TenantTransaction,
  workspaceId: string,
  activatedBy: string | null,
): Promise<boolean> {
  if (activatedBy === null) return false;
  const rows = await tx.execute<{ [key: string]: unknown }>(sql`
    select membership_id as "membershipId", status, role_names as "roleNames",
      permission_rows as "permissionRows"
    from app.staff_access_snapshot(${workspaceId}::uuid, ${activatedBy}::uuid)
  `);
  const parsed = accessRowSchema.safeParse(rows[0]);
  if (!parsed.success) return false;
  const access: StaffAccessSnapshot = {
    membershipId: parsed.data.membershipId,
    status: parsed.data.status,
    roles: parsed.data.roleNames,
    permissions: parsed.data.permissionRows,
  };
  return decideAccess(access, 'lead.manage').allowed;
}

/** Whether `actorId` is an active staff member of the site now. */
async function isActiveMember(
  tx: TenantTransaction,
  workspaceId: string,
  actorId: string,
): Promise<boolean> {
  const rows = await tx.execute(sql`
    select 1 from app.memberships m
    where m.workspace_id = ${workspaceId} and m.user_id = ${actorId}
      and m.membership_type = 'staff' and m.status = 'active'
    limit 1
  `);
  return rows.length > 0;
}

/** The lead update context of a flow's write: the same mail, site snapshot and staff mail. */
function updateContextOf(fire: FireFlowsContext): LeadUpdateContext {
  return {
    emailEnvironment: fire.environment,
    ...(fire.siteHolder ? { siteHolder: fire.siteHolder } : {}),
    ...(fire.staffNotifications ? { staffNotifications: fire.staffNotifications } : {}),
  };
}

/** The run as the attribution of the writes it makes (R5, R8). */
function attributionOf(run: RunState): AutomationAttribution {
  return {
    key: run.flow.key,
    name: run.flow.name,
    version: run.flow.version,
    runId: run.id,
    depth: run.depth,
    chain: run.chain,
  };
}

const NOT_ALLOWED: StepResult = { outcome: 'skipped', reason: 'activator_not_allowed' };
const NONE = '(none)';
const TASK_TITLE_VARIABLES: readonly string[] = [...FLOW_TASK_VARIABLES, ANY_PROPERTY_VARIABLE];
const BRACED = /\{([^{}\n]*)\}/g;
const TITLE_MAX = 200;

/**
 * A task title with its variables filled from the lead: the order fill-ins,
 * and a property as the record page shows it to staff (never a sensitive
 * one). A value the lead lacks is `(none)`: an internal task is never
 * skipped for it.
 */
export function renderTaskTitle(
  title: string,
  lead: AutomationLead,
  catalog: PropertyCatalog,
): string {
  const values = fillInValuesForLead(lead, { siteName: '', siteUrl: null });
  const rendered = title.replace(BRACED, (whole) => {
    const parsed = parseTextVariables(whole, TASK_TITLE_VARIABLES);
    const name = parsed.ok ? parsed.names[0] : undefined;
    if (name === undefined) return whole;
    if (name.startsWith('prop:')) {
      return leadPropertyText(lead, catalog, name.slice(5), 'staff') ?? NONE;
    }
    const value = FLOW_TASK_VARIABLES.find((variable) => variable === name);
    return (value ? values[value] : undefined) ?? NONE;
  });
  return rendered.trim().slice(0, TITLE_MAX) || NONE;
}

/** A calendar day `days` after `day` (YYYY-MM-DD). */
function addDays(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** A staff task through the staff route's own insert, as the activator (P19). */
export async function createTaskStep(
  ctx: StepContext,
  step: Extract<FlowStep, { kind: 'create_task' }>,
): Promise<StepResult> {
  const { tx, fire, run, lead } = ctx;
  const activator = run.flow.activatedBy;
  if (!activator || !(await activatorMayChangeLeads(tx, fire.workspaceId, activator))) {
    return NOT_ALLOWED;
  }
  let assignedActorId: string | null = null;
  if (step.assignee.kind === 'member') {
    if (!(await isActiveMember(tx, fire.workspaceId, step.assignee.actorId))) {
      return { outcome: 'skipped', reason: 'member_unavailable', detail: step.assignee.actorId };
    }
    assignedActorId = step.assignee.actorId;
  } else if (step.assignee.kind === 'lead_assignee' && lead.assignedActorId !== null) {
    assignedActorId = (await isActiveMember(tx, fire.workspaceId, lead.assignedActorId))
      ? lead.assignedActorId
      : null;
  }
  const now = fire.now?.() ?? new Date();
  const dueAt =
    step.dueInDays === null
      ? null
      : `${addDays(todayInToronto(now), step.dueInDays)}T12:00:00.000Z`;
  const { taskId } = await insertLeadTask(tx, {
    workspaceId: fire.workspaceId,
    actorId: activator,
    requestId: fire.requestId,
    leadId: run.leadId,
    title: renderTaskTitle(step.title, lead, ctx.site.catalog),
    dueAt,
    assignedActorId,
    automation: attributionOf(run),
  });
  return { outcome: 'done', taskId, detail: taskId };
}

/** What a lead update the flow asked for came to, as a step. */
function updateOutcome(outcome: UpdateLeadWorkOutcome, field?: string): StepResult {
  switch (outcome.status) {
    case 'updated':
      return {
        outcome: 'done',
        nested: { skipped: outcome.emailSkipped ?? [], activities: outcome.activities },
      };
    case 'illegal_stage_move':
    case 'dispatch_details_required':
    case 'activation_details_required':
      return { outcome: 'skipped', reason: outcome.status };
    case 'documents_incomplete':
      return {
        outcome: 'skipped',
        reason: 'documents_incomplete',
        detail: outcome.missing.join(','),
      };
    case 'invalid_stage':
      return { outcome: 'skipped', reason: 'stage_unavailable' };
    case 'invalid_field':
      return { outcome: 'skipped', reason: 'invalid_field', detail: field ?? outcome.field };
    case 'assignee_not_found':
      return { outcome: 'skipped', reason: 'member_unavailable' };
    case 'not_found':
    case 'trashed':
      return { outcome: 'skipped', reason: 'lead_archived' };
    case 'document_override_reason_required':
      return { outcome: 'skipped', reason: 'step_failed' };
  }
}

/** The lead given to a member, through the staff assignment path; an owned lead only with `reassign`. */
export async function assignLeadStep(
  ctx: StepContext,
  step: Extract<FlowStep, { kind: 'assign_lead' }>,
): Promise<StepResult> {
  const { tx, fire, run, lead } = ctx;
  const activator = run.flow.activatedBy;
  if (!activator || !(await activatorMayChangeLeads(tx, fire.workspaceId, activator))) {
    return NOT_ALLOWED;
  }
  if (lead.assignedActorId !== null && !step.reassign) {
    return { outcome: 'skipped', reason: 'already_assigned' };
  }
  if (!(await isActiveMember(tx, fire.workspaceId, step.actorId))) {
    return { outcome: 'skipped', reason: 'member_unavailable', detail: step.actorId };
  }
  const outcome = await applyLeadUpdate(tx, updateContextOf(fire), {
    workspaceId: fire.workspaceId,
    actorId: activator,
    requestId: fire.requestId,
    leadId: run.leadId,
    assignedActorId: step.actorId,
    catalog: ctx.site.catalog,
    automation: attributionOf(run),
  });
  return updateOutcome(outcome);
}

/**
 * A stage, or one custom property or editable form field, set through the
 * staff `PATCH`'s own path: every allowed-move and gate check applies and
 * the documents override never does. A stage move at the deepest chain
 * level is skipped (P5).
 */
export async function updateLeadStep(
  ctx: StepContext,
  step: Extract<FlowStep, { kind: 'update_lead' }>,
): Promise<StepResult> {
  const { tx, fire, run } = ctx;
  const activator = run.flow.activatedBy;
  if (!activator || !(await activatorMayChangeLeads(tx, fire.workspaceId, activator))) {
    return NOT_ALLOWED;
  }
  const { change } = step;
  if (change.kind === 'stage' && run.depth >= AUTOMATION_MAX_CHAIN_DEPTH) {
    return { outcome: 'skipped', reason: 'chain_too_deep', detail: change.stage };
  }
  let edit:
    | { stage: string }
    | { customValues: Record<string, string | number | boolean | null> }
    | {
        form: Record<string, string | number | boolean | null>;
      };
  if (change.kind === 'stage') {
    edit = { stage: change.stage };
  } else {
    const property = ctx.site.catalog.get(change.key);
    if (!property || property.sensitive) {
      return { outcome: 'skipped', reason: 'invalid_field', detail: change.key };
    }
    if (property.storage === 'custom') {
      edit = { customValues: { [change.key]: change.value } };
    } else if (property.storage === 'form') {
      edit = { form: { [property.storageKey ?? change.key]: change.value } };
    } else {
      return { outcome: 'skipped', reason: 'invalid_field', detail: change.key };
    }
  }
  const outcome = await applyLeadUpdate(tx, updateContextOf(fire), {
    workspaceId: fire.workspaceId,
    actorId: activator,
    requestId: fire.requestId,
    leadId: run.leadId,
    catalog: ctx.site.catalog,
    automation: attributionOf(run),
    ...edit,
  });
  return updateOutcome(outcome, change.kind === 'property' ? change.key : undefined);
}

/** A send step's dedupe key: phase 4's exactly for the built-ins' `main`, else with the step id. */
export function sendDedupeKey(run: RunState, stepId: string): string {
  const base = `${run.leadId}:${run.flow.key}:${run.occurrence}`;
  return stepId === BUILT_IN_STEP_ID ? base : `${base}:${stepId}`;
}

/** What the admin is told about a mail a flow did not queue: the flow, the template, both names, why. */
export async function emailSkippedFor(
  tx: TenantTransaction,
  workspaceId: string,
  flow: Pick<LiveFlow, 'key' | 'name'>,
  template: EmailTemplateKey,
  skip: { reason: EmailSkipped['reason']; missing?: EmailSkipped['missing'] },
): Promise<EmailSkipped> {
  const stored = isSiteTemplateKey(template)
    ? await readEmailTemplate(tx, workspaceId, template)
    : undefined;
  return {
    automation: flow.key,
    flowName: flow.name.slice(0, 80),
    template,
    templateName: emailTemplateLabel(template, stored?.name ?? null).slice(0, 80),
    reason: skip.reason,
    ...(skip.missing ? { missing: skip.missing } : {}),
  };
}

/**
 * Composes the template from the lead as stored now and queues it once per
 * step and occurrence; a dedupe hit is `already_sent` (the occurrence was
 * mailed, by this code or by phase 4's).
 */
export async function sendEmailStep(
  ctx: StepContext,
  step: Extract<FlowStep, { kind: 'send_email' }>,
): Promise<StepResult> {
  const { tx, fire, run, lead } = ctx;
  const composed = await composeCustomerEmail(tx, fire.environment, {
    workspaceId: fire.workspaceId,
    template: step.template,
    recipient: { kind: 'lead', lead },
    catalog: ctx.site.catalog,
  });
  if (composed.kind === 'skipped') {
    if (composed.reason === 'template_unavailable') {
      return { outcome: 'skipped', reason: 'template_unavailable', detail: step.template };
    }
    const missing = composed.missing;
    return {
      outcome: 'skipped',
      reason: composed.reason,
      ...(missing && missing.length > 0 ? { detail: missing.join(',') } : {}),
      emailSkipped: await emailSkippedFor(tx, fire.workspaceId, run.flow, step.template, {
        reason: composed.reason,
        ...(missing ? { missing } : {}),
      }),
    };
  }

  const queued = await queueComposedEmail(tx, {
    workspaceId: fire.workspaceId,
    actorId: fire.actorId,
    requestId: fire.requestId,
    leadId: run.leadId,
    dedupeKey: sendDedupeKey(run, step.id),
    payload: composed.payload,
    automation: {
      key: run.flow.key,
      name: run.flow.name,
      version: run.flow.version,
      runId: run.id,
    },
    templateName: composed.templateName,
  });
  if (!queued.queued || queued.jobId === null) {
    return { outcome: 'skipped', reason: 'already_sent' };
  }
  return {
    outcome: 'done',
    jobId: queued.jobId,
    ...(queued.activity ? { activities: [queued.activity] } : {}),
  };
}
