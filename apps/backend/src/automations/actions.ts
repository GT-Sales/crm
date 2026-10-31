import type { TenantTransaction } from '@gt-sales/db';
import {
  BUILT_IN_STEP_ID,
  emailTemplateLabel,
  isSiteTemplateKey,
  type AutomationReason,
  type AutomationStepOutcome,
  type EmailSkipped,
  type EmailTemplateKey,
  type FlowSite,
  type FlowStep,
  type LeadActivity,
} from '@gt-sales/contracts';

import { composeCustomerEmail } from '../email/compose.js';
import { queueComposedEmail } from '../email/queue.js';
import { readEmailTemplate } from '../email/settings-store.js';
import type { FireFlowsContext, FireFlowsResult, LiveFlow, RunState } from './engine.js';
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
    case 'assign_lead':
    case 'update_lead':
    case 'notify_staff':
      throw new Error('step_not_available');
  }
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
