import { and, eq, sql } from 'drizzle-orm';
import { automationRuns, automationWaits, automations, type TenantTransaction } from '@gt-sales/db';
import {
  BUILT_IN_AUTOMATION_KEYS,
  automationKeySchema,
  builtInFlowName,
  checkFlowAgainstSite,
  durationMs,
  flowDefinitionSchemaFor,
  flowTriggerSchema,
  isBuiltInAutomationKey,
  triggerMatchesEvent,
  type AutomationKey,
  type AutomationReason,
  type EmailSkipped,
  type FlowDefinition,
  type FlowIssue,
  type FlowSite,
  type FlowStep,
  type FlowTrigger,
  type LeadActivity,
  type PropertyCatalog,
} from '@gt-sales/contracts';

import type { CustomerEmailEnvironment } from '../email/senders.js';
import { sanitizeLogIdentifier } from '../http/logger.js';
import { emailSkippedFor, runActionStep, type StepContext, type StepResult } from './actions.js';
import { evaluateConditionGroup } from './conditions.js';
import { detailOf, finishRun, insertStepRun } from './records.js';
import { readAutomationLead } from './run.js';
import { loadFlowSite } from './site.js';

/**
 * The flow engine (spec §5): inside the transaction of a move or a submit it
 * reads the site's live flows in one statement, so a flow activated or
 * switched while the write is in flight is seen either as it was or as it is,
 * never half; it matches each event to each flow, guards loops, checks the
 * flow against the site and runs its steps, each in a savepoint, through the
 * outbox. Nothing it does for a flow's sake fails the write: a step that
 * throws is recorded `failed`, a flow that cannot run is recorded `skipped`
 * with the key at fault. Every record names keys, ids and versions only.
 */

export interface FlowEvent {
  kind: 'lead_submitted' | 'stage_entered';
  leadId: string;
  leadType: string;
  stage: string;
  occurrence: string;
  depth: number;
  /** The flows whose moves led here, oldest first (R8). */
  chain: readonly string[];
  parentRunId: string | null;
  at: Date;
}

/** The site snapshot, read once per write and only when a flow's trigger matches (P23). */
export interface FlowSiteHolder {
  get(tx: TenantTransaction): Promise<FlowSite>;
}

export interface FireFlowsContext {
  workspaceId: string;
  /** The write's actor: a customer email is queued as it (P19). */
  actorId: string;
  requestId: string;
  environment: CustomerEmailEnvironment;
  catalog?: PropertyCatalog;
  /** P24, tests only: called once after the flows are read. */
  afterFlowsRead?: () => Promise<void>;
  /** The clock of a wait's resume time; the scheduler passes its own. */
  now?: () => Date;
  /** Shared by the nested firings of one write; made by the first. */
  siteHolder?: FlowSiteHolder;
}

export interface FireFlowsResult {
  skipped: EmailSkipped[];
  activities: LeadActivity[];
}

export interface LiveFlow {
  id: string;
  key: AutomationKey;
  name: string;
  origin: 'builtin' | 'custom';
  versionId: string;
  version: number;
  activatedBy: string | null;
  definition: unknown;
}

export interface RunState {
  id: string;
  flow: LiveFlow;
  definition: FlowDefinition;
  leadId: string;
  leadType: string;
  occurrence: string;
  depth: number;
  chain: readonly string[];
  triggerKind: FlowTrigger['kind'];
}

const emptyResult = (): FireFlowsResult => ({ skipped: [], activities: [] });

function mergeInto(target: FireFlowsResult, source: FireFlowsResult | undefined): void {
  if (!source) return;
  target.skipped.push(...source.skipped);
  target.activities.push(...source.activities);
}

/** A holder that loads the site on first use, with the catalogue the write already has. */
export function flowSiteHolder(workspaceId: string, catalog?: PropertyCatalog): FlowSiteHolder {
  let loaded: Promise<FlowSite> | undefined;
  return {
    get(tx) {
      loaded ??= loadFlowSite(tx, workspaceId, catalog);
      return loaded;
    },
  };
}

const builtInOrder = new Map<string, number>(BUILT_IN_AUTOMATION_KEYS.map((key, i) => [key, i]));

interface LiveFlowRow {
  [key: string]: unknown;
  id: string;
  key: string;
  name: string | null;
  origin: string;
  createdAt: Date | string;
  versionId: string;
  version: number;
  activatedBy: string | null;
  definition: unknown;
}

/**
 * The site's live flows in one statement: on, not archived, with the version
 * `active_version_id` names; built-ins in key order, then custom flows by
 * creation, then id.
 */
export async function readLiveFlows(
  tx: TenantTransaction,
  workspaceId: string,
): Promise<LiveFlow[]> {
  const rows = await tx.execute<LiveFlowRow>(sql`
    select a.id, a.key, a.name, a.origin, a.created_at as "createdAt",
      v.id as "versionId", v.version, v.activated_by as "activatedBy", v.definition
    from app.automations a
    join app.automation_versions v
      on v.workspace_id = a.workspace_id and v.id = a.active_version_id
    where a.workspace_id = ${workspaceId}
      and a.enabled
      and a.archived_at is null
  `);
  const flows: Array<LiveFlow & { createdAt: number }> = [];
  for (const row of rows) {
    const key = automationKeySchema.safeParse(row.key);
    if (!key.success) continue;
    const origin = row.origin === 'custom' ? 'custom' : 'builtin';
    const name =
      row.name ?? (isBuiltInAutomationKey(key.data) ? builtInFlowName(key.data) : key.data);
    flows.push({
      id: row.id,
      key: key.data,
      name,
      origin,
      versionId: row.versionId,
      version: Number(row.version),
      activatedBy: row.activatedBy,
      definition: row.definition,
      createdAt: new Date(row.createdAt).getTime(),
    });
  }
  flows.sort((a, b) => {
    const ai = builtInOrder.get(a.key);
    const bi = builtInOrder.get(b.key);
    if (ai !== undefined || bi !== undefined) {
      return (ai ?? Number.MAX_SAFE_INTEGER) - (bi ?? Number.MAX_SAFE_INTEGER);
    }
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return flows.map(({ createdAt: _createdAt, ...flow }) => flow);
}

/** The stored definition's trigger, when it still reads as one. */
function storedTrigger(definition: unknown): FlowTrigger | undefined {
  if (typeof definition !== 'object' || definition === null || !('trigger' in definition)) {
    return undefined;
  }
  const parsed = flowTriggerSchema.safeParse(definition.trigger);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Every live flow each event triggers, in order (submission flows before the
 * stage flows of the same write, R4); never throws for a flow's sake. A lead
 * the customer never submitted fires nothing.
 */
export async function fireFlows(
  tx: TenantTransaction,
  context: FireFlowsContext,
  events: readonly FlowEvent[],
): Promise<FireFlowsResult> {
  const result = emptyResult();
  if (events.length === 0) return result;
  const flows = await readLiveFlows(tx, context.workspaceId);
  if (context.afterFlowsRead) await context.afterFlowsRead();
  if (flows.length === 0) return result;
  const fire: FireFlowsContext = {
    ...context,
    siteHolder: context.siteHolder ?? flowSiteHolder(context.workspaceId, context.catalog),
  };

  for (const event of events) {
    const lead = await readAutomationLead(tx, context.workspaceId, event.leadId);
    if (!lead.submitted) continue;
    for (const flow of flows) {
      try {
        mergeInto(
          result,
          await tx.transaction((savepoint) => fireFlow(savepoint, fire, flow, event)),
        );
      } catch (error) {
        logFlowFailure(fire, flow.key, error);
      }
    }
  }
  return result;
}

interface RunInsert {
  flow: LiveFlow;
  event: Pick<FlowEvent, 'leadId' | 'occurrence' | 'depth' | 'parentRunId'>;
  triggerKind: FlowTrigger['kind'];
  skipped?: { reason: AutomationReason; detail?: string };
}

/**
 * The run's row, once per flow, lead and occurrence: `undefined` when the
 * occurrence already ran (`automation_runs_occurrence_unique`). A skipped
 * run is written finished; a run that starts is `completed` until its steps
 * say otherwise, and counts on the flow.
 */
export async function insertRun(
  tx: TenantTransaction,
  workspaceId: string,
  input: RunInsert,
): Promise<string | undefined> {
  const status = input.skipped ? 'skipped' : 'completed';
  const reason = input.skipped?.reason ?? null;
  const detail = input.skipped?.detail === undefined ? null : detailOf([input.skipped.detail]);
  const rows = await tx.execute<{ id: string }>(sql`
    insert into app.automation_runs (
      workspace_id, automation_key, automation_id, version_id, lead_id, status, reason, detail,
      occurrence, trigger_kind, depth, parent_run_id, created_at, updated_at, finished_at
    ) values (
      ${workspaceId}, ${input.flow.key}, ${input.flow.id}, ${input.flow.versionId},
      ${input.event.leadId}, ${status}, ${reason}, ${detail}, ${input.event.occurrence},
      ${input.triggerKind}, ${input.event.depth}, ${input.event.parentRunId},
      clock_timestamp(), clock_timestamp(),
      ${input.skipped ? sql`clock_timestamp()` : sql`null`}
    )
    on conflict (workspace_id, automation_key, lead_id, occurrence)
      where occurrence is not null
      do nothing
    returning id
  `);
  const id = rows[0]?.id;
  if (id && !input.skipped) {
    await tx
      .update(automations)
      .set({ runCount: sql`${automations.runCount} + 1`, lastRunAt: sql`now()` })
      .where(and(eq(automations.workspaceId, workspaceId), eq(automations.id, input.flow.id)));
  }
  return id;
}

/** The first issue a flow has on this site, by where it sits. */
function firstIssue(issues: readonly FlowIssue[], inWhen: boolean): FlowIssue | undefined {
  return issues.find((issue) => issue.path.startsWith('trigger.when') === inWhen);
}

/** One flow for one event, inside its own savepoint. */
async function fireFlow(
  tx: TenantTransaction,
  fire: FireFlowsContext,
  flow: LiveFlow,
  event: FlowEvent,
): Promise<FireFlowsResult> {
  const trigger = storedTrigger(flow.definition);
  if (!trigger || !triggerMatchesEvent(trigger, event)) return emptyResult();
  return startFlowRun(tx, fire, flow, {
    leadId: event.leadId,
    leadType: event.leadType,
    occurrence: event.occurrence,
    depth: event.depth,
    chain: event.chain,
    parentRunId: event.parentRunId,
    triggerKind: trigger.kind,
  });
}

/**
 * A flow whose trigger matched (an event, or a due timer): parse and check
 * the version, its `when`, the loop guard, then the run and its steps. What
 * is wrong with the flow itself (it no longer parses, it names something the
 * site cannot use) is a skipped run with the reason and the key at fault;
 * a `when` that does not hold records nothing.
 */
export async function startFlowRun(
  tx: TenantTransaction,
  fire: FireFlowsContext,
  flow: LiveFlow,
  start: {
    leadId: string;
    leadType: string;
    occurrence: string;
    depth: number;
    chain: readonly string[];
    parentRunId: string | null;
    triggerKind: FlowTrigger['kind'];
  },
): Promise<FireFlowsResult> {
  const { workspaceId } = fire;
  const runInsert = (skipped?: RunInsert['skipped']) =>
    insertRun(tx, workspaceId, {
      flow,
      event: start,
      triggerKind: start.triggerKind,
      ...(skipped ? { skipped } : {}),
    });

  const parsed = flowDefinitionSchemaFor(flow.origin).safeParse(flow.definition);
  if (!parsed.success) {
    await runInsert({ reason: 'definition_invalid' });
    return emptyResult();
  }
  const definition = parsed.data;
  const site = await siteOf(tx, fire);
  const issues = checkFlowAgainstSite(definition, site);
  // A `when` that names something gone cannot be weighed: the flow is skipped for it.
  const whenIssue = firstIssue(issues, true);
  if (whenIssue) {
    await runInsert({ reason: whenIssue.code, detail: whenIssue.ref });
    return emptyResult();
  }
  if (definition.trigger.when) {
    const holds = await evaluateConditionGroup(tx, {
      workspaceId,
      leadId: start.leadId,
      leadType: start.leadType,
      group: definition.trigger.when,
      catalog: site.catalog,
    });
    if (!holds) return emptyResult();
  }
  if (start.chain.includes(flow.key)) {
    await runInsert({ reason: 'loop_prevented', detail: flow.key });
    return emptyResult();
  }
  const issue = firstIssue(issues, false);
  if (issue) {
    await runInsert({ reason: issue.code, detail: issue.ref });
    return emptyResult();
  }

  const runId = await runInsert();
  if (!runId) return emptyResult();
  const run: RunState = {
    id: runId,
    flow,
    definition,
    leadId: start.leadId,
    leadType: start.leadType,
    occurrence: start.occurrence,
    depth: start.depth,
    chain: start.chain,
    triggerKind: start.triggerKind,
  };
  const ran = await runSteps(tx, fire, run, []);
  if (ran.ended !== 'waiting') {
    await finishRun(tx, workspaceId, runId, {
      status: ran.ended,
      ...(ran.ended === 'failed' ? { reason: 'step_failed' as const } : {}),
    });
  }
  return { skipped: ran.skipped, activities: ran.activities };
}

export function siteOf(tx: TenantTransaction, fire: FireFlowsContext): Promise<FlowSite> {
  const holder = fire.siteHolder ?? flowSiteHolder(fire.workspaceId, fire.catalog);
  return holder.get(tx);
}

type Ended = 'completed' | 'waiting' | 'failed';

/**
 * Where in a definition a step sits, as indices: `[i]` at the top, then for
 * each if/else on the way a branch (0 then, 1 else) and an index in it.
 */
export type StepPosition = readonly number[];

/** The position of the step after `stepId` (which may be past its sequence's end), or undefined. */
export function positionAfter(
  steps: readonly FlowStep[],
  stepId: string,
): StepPosition | undefined {
  const search = (sequence: readonly FlowStep[], prefix: number[]): number[] | undefined => {
    for (let index = 0; index < sequence.length; index += 1) {
      const step = sequence[index];
      if (!step) continue;
      if (step.id === stepId) return [...prefix, index + 1];
      if (step.kind === 'if_else') {
        const found =
          search(step.then, [...prefix, index, 0]) ?? search(step.else, [...prefix, index, 1]);
        if (found) return found;
      }
    }
    return undefined;
  };
  return search(steps, []);
}

/**
 * Runs `run`'s steps from `startAt` (`[]` = the top), recording each; stops
 * at a wait or the end. T8 calls it to resume after a wait.
 */
export async function runSteps(
  tx: TenantTransaction,
  context: FireFlowsContext,
  run: RunState,
  startAt: StepPosition,
): Promise<FireFlowsResult & { ended: Ended }> {
  const result = emptyResult();
  const ended = await runSequence(tx, context, run, run.definition.steps, startAt, result);
  return { ...result, ended };
}

async function runSequence(
  tx: TenantTransaction,
  context: FireFlowsContext,
  run: RunState,
  sequence: readonly FlowStep[],
  position: StepPosition,
  result: FireFlowsResult,
): Promise<Ended> {
  const [first = 0, branch, ...rest] = position;
  if (branch !== undefined) {
    // Resuming inside a branch: the if/else already chose it, and nothing follows it (R7).
    const step = sequence[first];
    if (!step || step.kind !== 'if_else') return 'completed';
    return runSequence(tx, context, run, branch === 0 ? step.then : step.else, rest, result);
  }
  for (let index = first; index < sequence.length; index += 1) {
    const step = sequence[index];
    if (!step) continue;
    if (step.kind === 'if_else') {
      const site = await siteOf(tx, context);
      const holds = await evaluateConditionGroup(tx, {
        workspaceId: context.workspaceId,
        leadId: run.leadId,
        leadType: run.leadType,
        group: step.condition,
        catalog: site.catalog,
      });
      await insertStepRun(tx, context.workspaceId, {
        runId: run.id,
        stepId: step.id,
        stepKind: 'if_else',
        outcome: 'done',
        branch: holds ? 'yes' : 'no',
      });
      return runSequence(tx, context, run, holds ? step.then : step.else, [], result);
    }
    if (step.kind === 'wait') {
      await startWait(tx, context, run, step);
      return 'waiting';
    }
    const done = await runAction(tx, context, run, step, result);
    if (done.outcome === 'failed') return 'failed';
  }
  return 'completed';
}

/** A wait: its `waiting` row, the wait to resume at, and the run left waiting. */
async function startWait(
  tx: TenantTransaction,
  context: FireFlowsContext,
  run: RunState,
  step: Extract<FlowStep, { kind: 'wait' }>,
): Promise<void> {
  const now = context.now?.() ?? new Date();
  await insertStepRun(tx, context.workspaceId, {
    runId: run.id,
    stepId: step.id,
    stepKind: 'wait',
    outcome: 'waiting',
  });
  await tx.insert(automationWaits).values({
    workspaceId: context.workspaceId,
    runId: run.id,
    automationId: run.flow.id,
    leadId: run.leadId,
    stepId: step.id,
    resumeAt: new Date(now.getTime() + durationMs(step.for)),
  });
  await tx
    .update(automationRuns)
    .set({ status: 'waiting', updatedAt: now })
    .where(and(eq(automationRuns.workspaceId, context.workspaceId), eq(automationRuns.id, run.id)));
}

/** One action step in its own savepoint; a throw is the step `failed`, recorded outside it. */
async function runAction(
  tx: TenantTransaction,
  context: FireFlowsContext,
  run: RunState,
  step: Exclude<FlowStep, { kind: 'if_else' | 'wait' }>,
  result: FireFlowsResult,
): Promise<StepResult> {
  const site = await siteOf(tx, context);
  let outcome: StepResult;
  try {
    outcome = await tx.transaction(async (savepoint) => {
      const lead = await readAutomationLead(savepoint, context.workspaceId, run.leadId);
      const ctx: StepContext = { tx: savepoint, fire: context, run, lead, site };
      return runActionStep(ctx, step);
    });
  } catch (error) {
    outcome = await failedStep(tx, context, run, step, error);
  }
  await insertStepRun(tx, context.workspaceId, {
    runId: run.id,
    stepId: step.id,
    stepKind: step.kind,
    outcome: outcome.outcome,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    ...(outcome.detail !== undefined ? { detail: detailOf([outcome.detail]) } : {}),
    ...(outcome.jobId ? { jobId: outcome.jobId } : {}),
    ...(outcome.taskId ? { taskId: outcome.taskId } : {}),
  });
  if (outcome.emailSkipped) result.skipped.push(outcome.emailSkipped);
  if (outcome.activities) result.activities.push(...outcome.activities);
  mergeInto(result, outcome.nested);
  return outcome;
}

/** A step that threw: `compose_failed` for a mail that would not compose or fit its job, else `step_failed`. */
async function failedStep(
  tx: TenantTransaction,
  context: FireFlowsContext,
  run: RunState,
  step: Exclude<FlowStep, { kind: 'if_else' | 'wait' }>,
  error: unknown,
): Promise<StepResult> {
  if (step.kind !== 'send_email') {
    logStepFailure(context, run.flow.key, step.kind, error);
    return { outcome: 'failed', reason: 'step_failed' };
  }
  logComposeFailure(context, run.flow.key, step.template);
  return {
    outcome: 'failed',
    reason: 'compose_failed',
    emailSkipped: await emailSkippedFor(tx, context.workspaceId, run.flow, step.template, {
      reason: 'compose_failed',
    }),
  };
}

/** One structured warning naming the flow and its template; never the lead, its address or the error's text. */
function logComposeFailure(context: FireFlowsContext, automation: string, template: string): void {
  console.warn(
    JSON.stringify({
      event: 'automation_compose_failed',
      requestId: sanitizeLogIdentifier(context.requestId) ?? 'unknown',
      workspaceId: sanitizeLogIdentifier(context.workspaceId) ?? 'unknown',
      automation,
      template,
    }),
  );
}

function logStepFailure(
  context: FireFlowsContext,
  automation: string,
  stepKind: string,
  error: unknown,
): void {
  console.warn(
    JSON.stringify({
      event: 'automation_step_failed',
      requestId: sanitizeLogIdentifier(context.requestId) ?? 'unknown',
      workspaceId: sanitizeLogIdentifier(context.workspaceId) ?? 'unknown',
      automation,
      stepKind,
      code: errorCode(error),
    }),
  );
}

function logFlowFailure(context: FireFlowsContext, automation: string, error: unknown): void {
  console.warn(
    JSON.stringify({
      event: 'automation_flow_failed',
      requestId: sanitizeLogIdentifier(context.requestId) ?? 'unknown',
      workspaceId: sanitizeLogIdentifier(context.workspaceId) ?? 'unknown',
      automation,
      code: errorCode(error),
    }),
  );
}

/** A bounded code for a log line: a SQLSTATE when there is one, never the error's text. */
export function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = error.code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
      return `sqlstate_${code.toLowerCase()}`;
    }
  }
  if (error instanceof Error && /^[a-z][a-z0-9_]{2,63}$/.test(error.message)) return error.message;
  return 'unexpected_error';
}
