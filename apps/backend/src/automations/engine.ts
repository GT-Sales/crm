import { and, eq, sql } from 'drizzle-orm';
import { automationRuns, automationWaits, type TenantTransaction } from '@gt-sales/db';
import {
  AUTOMATION_MAX_CHAIN_DEPTH,
  BUILT_IN_AUTOMATION_KEYS,
  automationKeySchema,
  timerDueAt,
  triggerLeadTypes,
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
import { intakeCheckCode } from '../intake-check/check.js';
import { emailSkippedFor, runActionStep, type StepContext, type StepResult } from './actions.js';
import { evaluateConditionGroup } from './conditions.js';
import { cancelWaitingRun, detailOf, finishRun, insertStepRun } from './records.js';
import { readAutomationLead } from './run.js';
import { loadFlowSite } from './site.js';
import type { StaffNotificationEnvironment } from './staff-notification.js';

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
  /**
   * The runs that started during the write (I1). The outermost firing of a
   * write makes it and counts them on their flows once, at its end, in flow
   * id order, so no write holds a flow row while it fires more flows.
   */
  startedRuns?: string[];
  /** What staff notification mail needs; read from the environment when absent. */
  staffNotifications?: StaffNotificationEnvironment;
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
export function storedTrigger(definition: unknown): FlowTrigger | undefined {
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
 *
 * Each call reads the live flows once; a nested firing (a flow's own move)
 * and `writeTimers` read them again, so under READ COMMITTED a version
 * activated mid-write may be seen by the nested events but not the top
 * ones. Every run still uses exactly one version (R2).
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
  const base: FireFlowsContext = {
    ...context,
    siteHolder: context.siteHolder ?? flowSiteHolder(context.workspaceId, context.catalog),
  };

  await countingRuns(tx, base, async (fire) => {
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
  });
  return result;
}

/**
 * Runs `body` with the write's list of started runs: the caller's when it has
 * one (a nested firing), else a new one this call counts at its end.
 */
async function countingRuns<T>(
  tx: TenantTransaction,
  context: FireFlowsContext,
  body: (fire: FireFlowsContext) => Promise<T>,
): Promise<T> {
  if (context.startedRuns) return body(context);
  const startedRuns: string[] = [];
  const value = await body({ ...context, startedRuns });
  await countStartedRuns(tx, context.workspaceId, startedRuns);
  return value;
}

/**
 * `run_count` and `last_run_at` for the runs that started and are still
 * there (a run in a rolled-back savepoint is gone and not counted), one
 * statement locking the flow rows in id order first, so two writes never
 * take them in opposite orders.
 */
async function countStartedRuns(
  tx: TenantTransaction,
  workspaceId: string,
  runIds: readonly string[],
): Promise<void> {
  if (runIds.length === 0) return;
  const ids = sql.join(
    runIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const started = await tx.execute<{ automationId: string; n: number }>(sql`
    select r.automation_id as "automationId", count(*)::int as n
    from app.automation_runs r
    where r.workspace_id = ${workspaceId} and r.id in (${ids}) and r.automation_id is not null
    group by r.automation_id
    order by r.automation_id
  `);
  if (started.length === 0) return;
  const flows = sql.join(
    started.map((row) => sql`${row.automationId}::uuid`),
    sql`, `,
  );
  // Locked first, in id order, by a statement of their own; then counted. `no key update`
  // is the lock the update needs: it does not wait on the key-share locks every run
  // insert's foreign key holds on its flow in other writes.
  await tx.execute(sql`
    select a.id from app.automations a
    where a.workspace_id = ${workspaceId} and a.id in (${flows})
    order by a.id
    for no key update
  `);
  for (const row of started) {
    await tx.execute(sql`
      update app.automations
      set run_count = run_count + ${row.n}, last_run_at = now()
      where workspace_id = ${workspaceId} and id = ${row.automationId}
    `);
  }
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
 * say otherwise.
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
  // A started run is counted on its flow at the end of the write (`countStartedRuns`).
  return rows[0]?.id;
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
  fire.startedRuns?.push(runId);
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
  // A run has one wait row (`run_id` is unique): a later wait in the same run reuses it.
  const resumeAt = new Date(now.getTime() + durationMs(step.for));
  await tx
    .insert(automationWaits)
    .values({
      workspaceId: context.workspaceId,
      runId: run.id,
      automationId: run.flow.id,
      leadId: run.leadId,
      stepId: step.id,
      resumeAt,
    })
    .onConflictDoUpdate({
      target: automationWaits.runId,
      set: { stepId: step.id, resumeAt, status: 'pending', attempts: 0, updatedAt: now },
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

/** A bounded code for a log line, as the intake check makes it; never the error's text. */
export function errorCode(error: unknown): string {
  return intakeCheckCode(error);
}

// ---------------------------------------------------------------------------
// The scheduler's work: waits and timers (spec §5, P7, P17, P18, R2, R3)

/** Test seams of the scheduler's items; production sets none. */
export interface ItemHooks {
  /** Called right after the item is claimed, outside any savepoint (a killed tick). */
  afterClaim?: () => Promise<void>;
  /** Called inside a resume's savepoint, before its steps (a resume that throws). */
  insideResume?: () => Promise<void>;
  /** Told of a resume that threw (the tick logs it by code). */
  onFailure?: (error: unknown) => void;
}

const RESUME_MAX_ATTEMPTS = 5;

interface ClaimedWait {
  [key: string]: unknown;
  id: string;
  runId: string;
  automationId: string;
  leadId: string;
  stepId: string;
  attempts: number;
}

interface WaitingRun {
  [key: string]: unknown;
  status: string;
  versionId: string | null;
  occurrence: string | null;
  depth: number;
  parentRunId: string | null;
  triggerKind: string | null;
}

interface VersionedFlow {
  [key: string]: unknown;
  id: string;
  key: string;
  name: string | null;
  origin: string;
  enabled: boolean;
  archived: boolean;
  versionId: string;
  version: number;
  activatedBy: string | null;
  definition: unknown;
}

interface ItemLead {
  [key: string]: unknown;
  leadType: string;
  stage: string;
  submitted: boolean;
  gone: boolean;
}

/** The lead an item works on, locked after the item (lock order: wait or timer, then lead). */
async function lockItemLead(
  tx: TenantTransaction,
  workspaceId: string,
  leadId: string,
): Promise<ItemLead | undefined> {
  const [lead] = await tx.execute<ItemLead>(sql`
    select l.lead_type as "leadType", l.stage, l.status <> 'incomplete' as submitted,
      (l.deleted_at is not null or l.customer_data_restricted_at is not null) as gone
    from app.leads l
    where l.workspace_id = ${workspaceId} and l.id = ${leadId}
    for update
  `);
  return lead;
}

/** A flow's row with one version of it (never locked: the switch locks it, P7). */
async function readVersionedFlow(
  tx: TenantTransaction,
  workspaceId: string,
  automationId: string,
  versionId: string,
): Promise<(LiveFlow & { enabled: boolean; archived: boolean }) | undefined> {
  const [row] = await tx.execute<VersionedFlow>(sql`
    select a.id, a.key, a.name, a.origin, a.enabled, a.archived_at is not null as archived,
      v.id as "versionId", v.version, v.activated_by as "activatedBy", v.definition
    from app.automations a
    join app.automation_versions v on v.workspace_id = a.workspace_id and v.automation_id = a.id
    where a.workspace_id = ${workspaceId} and a.id = ${automationId} and v.id = ${versionId}
  `);
  if (!row) return undefined;
  const key = automationKeySchema.safeParse(row.key);
  if (!key.success) return undefined;
  return {
    id: row.id,
    key: key.data,
    name: row.name ?? (isBuiltInAutomationKey(key.data) ? builtInFlowName(key.data) : key.data),
    origin: row.origin === 'custom' ? 'custom' : 'builtin',
    versionId: row.versionId,
    version: Number(row.version),
    activatedBy: row.activatedBy,
    definition: row.definition,
    enabled: row.enabled,
    archived: row.archived,
  };
}

/** P6: the flows a run's moves came through, oldest first, by `parent_run_id` (3 hops at most). */
async function chainOf(
  tx: TenantTransaction,
  workspaceId: string,
  parentRunId: string | null,
): Promise<string[]> {
  const chain: string[] = [];
  let next = parentRunId;
  for (let hop = 0; next !== null && hop < AUTOMATION_MAX_CHAIN_DEPTH; hop += 1) {
    const [parent] = await tx.execute<{ key: string; parentRunId: string | null }>(sql`
      select automation_key as key, parent_run_id as "parentRunId"
      from app.automation_runs where workspace_id = ${workspaceId} and id = ${next}
    `);
    if (!parent) break;
    chain.unshift(parent.key);
    next = parent.parentRunId;
  }
  return chain;
}

const triggerKindSchema = flowTriggerSchema.options.map((option) => option.shape.kind.value);
function asTriggerKind(value: string | null): FlowTrigger['kind'] {
  return triggerKindSchema.find((kind) => kind === value) ?? 'stage_entered';
}

/**
 * Resumes a run whose wait is due, on its own version (R2): a lead archived
 * or restricted cancels it `lead_archived`, a flow off or archived
 * `flow_switched_off`, a version the site can no longer run its first issue;
 * else the wait's step is done and the steps after it run with the lead as
 * it is now, the run's depth and chain. A resume that throws is rolled back,
 * counts an attempt and, at the fifth, fails the run `resume_failed`.
 */
export async function resumeRun(
  tx: TenantTransaction,
  context: FireFlowsContext,
  waitId: string,
  now: Date,
  hooks: ItemHooks = {},
): Promise<'resumed' | 'cancelled' | 'failed' | 'skipped'> {
  const { workspaceId } = context;
  const [wait] = await tx.execute<ClaimedWait>(sql`
    select w.id, w.run_id as "runId", w.automation_id as "automationId", w.lead_id as "leadId",
      w.step_id as "stepId", w.attempts
    from app.automation_waits w
    where w.workspace_id = ${workspaceId} and w.id = ${waitId}
      and w.status = 'pending' and w.resume_at <= ${now.toISOString()}::timestamptz
    for update skip locked
  `);
  if (!wait) return 'skipped';
  await hooks.afterClaim?.();
  const cancel = async (reason: AutomationReason, detail?: string) => {
    await cancelWaitingRun(tx, workspaceId, {
      runId: wait.runId,
      reason,
      ...(detail !== undefined ? { detail } : {}),
    });
    return 'cancelled' as const;
  };

  const [run] = await tx.execute<WaitingRun>(sql`
    select status, version_id as "versionId", occurrence, depth, parent_run_id as "parentRunId",
      trigger_kind as "triggerKind"
    from app.automation_runs where workspace_id = ${workspaceId} and id = ${wait.runId}
  `);
  if (!run || run.status !== 'waiting' || run.versionId === null || run.occurrence === null) {
    await tx
      .update(automationWaits)
      .set({ status: 'cancelled', updatedAt: now })
      .where(and(eq(automationWaits.workspaceId, workspaceId), eq(automationWaits.id, wait.id)));
    return 'cancelled';
  }
  const lead = await lockItemLead(tx, workspaceId, wait.leadId);
  if (!lead || lead.gone) return cancel('lead_archived');
  const flow = await readVersionedFlow(tx, workspaceId, wait.automationId, run.versionId);
  if (!flow || !flow.enabled || flow.archived) return cancel('flow_switched_off');
  const parsed = flowDefinitionSchemaFor(flow.origin).safeParse(flow.definition);
  if (!parsed.success) return cancel('definition_invalid');
  const fire: FireFlowsContext = {
    ...context,
    // P19: the activator's writes, else the scheduler's.
    actorId: flow.activatedBy ?? context.actorId,
    now: () => now,
    siteHolder: context.siteHolder ?? flowSiteHolder(workspaceId, context.catalog),
  };
  const site = await siteOf(tx, fire);
  const [issue] = checkFlowAgainstSite(parsed.data, site);
  if (issue) return cancel(issue.code, issue.ref);
  const position = positionAfter(parsed.data.steps, wait.stepId);
  if (!position) return cancel('definition_invalid', wait.stepId);

  const state: RunState = {
    id: wait.runId,
    flow,
    definition: parsed.data,
    leadId: wait.leadId,
    leadType: lead.leadType,
    occurrence: run.occurrence,
    depth: Number(run.depth),
    chain: await chainOf(tx, workspaceId, run.parentRunId),
    triggerKind: asTriggerKind(run.triggerKind),
  };
  try {
    await tx.transaction(async (savepoint) => {
      await hooks.insideResume?.();
      await insertStepRun(savepoint, workspaceId, {
        runId: wait.runId,
        stepId: wait.stepId,
        stepKind: 'wait',
        outcome: 'done',
      });
      await savepoint
        .update(automationWaits)
        .set({ status: 'resumed', updatedAt: now })
        .where(and(eq(automationWaits.workspaceId, workspaceId), eq(automationWaits.id, wait.id)));
      await countingRuns(savepoint, fire, async (counted) => {
        const ran = await runSteps(savepoint, counted, state, position);
        if (ran.ended !== 'waiting') {
          await finishRun(savepoint, workspaceId, wait.runId, {
            status: ran.ended,
            ...(ran.ended === 'failed' ? { reason: 'step_failed' as const } : {}),
          });
        }
      });
    });
    return 'resumed';
  } catch (error) {
    hooks.onFailure?.(error);
    const attempts = Math.min(Number(wait.attempts) + 1, RESUME_MAX_ATTEMPTS);
    const givenUp = attempts >= RESUME_MAX_ATTEMPTS;
    await tx
      .update(automationWaits)
      .set({ attempts, updatedAt: now, ...(givenUp ? { status: 'cancelled' } : {}) })
      .where(and(eq(automationWaits.workspaceId, workspaceId), eq(automationWaits.id, wait.id)));
    if (givenUp) {
      // The wait step's own row says so, as a cancelled wait's does (P25).
      await insertStepRun(tx, workspaceId, {
        runId: wait.runId,
        stepId: wait.stepId,
        stepKind: 'wait',
        outcome: 'failed',
        reason: 'resume_failed',
      });
      await finishRun(tx, workspaceId, wait.runId, { status: 'failed', reason: 'resume_failed' });
    }
    return 'failed';
  }
}

interface ClaimedTimer {
  [key: string]: unknown;
  id: string;
  automationId: string;
  leadId: string;
  triggerKind: string;
  occurrence: string;
  subjectId: string | null;
  stage: string | null;
  eventAt: Date | string;
}

/** The due day a `task_overdue` occurrence names (`task:<id>:<YYYY-MM-DD>`). */
function occurrenceDay(occurrence: string): string | undefined {
  const day = occurrence.split(':')[2];
  return day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined;
}

/**
 * Fires a due timer (P7): void when what started it no longer holds (the
 * lead archived, restricted or not submitted; the stay ended; the task
 * closed or moved; the flow off, archived, without an active version, or
 * with another trigger now; its `when` false); deferred when the version
 * active now puts it later; else fired, running the active version from its
 * first step at depth 0 with the timer's occurrence.
 */
export async function fireTimer(
  tx: TenantTransaction,
  context: FireFlowsContext,
  timerId: string,
  now: Date,
  hooks: ItemHooks = {},
): Promise<'fired' | 'void' | 'deferred' | 'skipped'> {
  const { workspaceId } = context;
  const [timer] = await tx.execute<ClaimedTimer>(sql`
    select t.id, t.automation_id as "automationId", t.lead_id as "leadId",
      t.trigger_kind as "triggerKind", t.occurrence, t.subject_id as "subjectId", t.stage,
      t.event_at as "eventAt"
    from app.automation_timers t
    where t.workspace_id = ${workspaceId} and t.id = ${timerId}
      and t.status = 'pending' and t.due_at <= ${now.toISOString()}::timestamptz
    for update skip locked
  `);
  if (!timer) return 'skipped';
  await hooks.afterClaim?.();
  const settle = async (status: 'void' | 'fired') => {
    await tx.execute(sql`
      update app.automation_timers
      set status = ${status}, updated_at = ${now.toISOString()}::timestamptz
      where workspace_id = ${workspaceId} and id = ${timer.id}
    `);
    return status;
  };
  const eventAt = new Date(timer.eventAt);

  const lead = await lockItemLead(tx, workspaceId, timer.leadId);
  if (!lead || lead.gone || !lead.submitted) return settle('void');
  if (timer.triggerKind === 'time_in_stage') {
    if (lead.stage !== timer.stage) return settle('void');
    // A later move ended the stay. The entry itself is not one: its time was kept to the
    // millisecond as `event_at`, so it is left out by id and compared at that precision.
    const entryId = timer.occurrence.startsWith('stay:') ? timer.occurrence.slice(5) : '';
    const moved = await tx.execute(sql`
      select 1 from app.lead_activities a
      where a.workspace_id = ${workspaceId} and a.lead_id = ${timer.leadId}
        and a.kind = 'status_change' and a.id::text <> ${entryId}
        and date_trunc('milliseconds', a.created_at) > ${eventAt.toISOString()}::timestamptz
      limit 1
    `);
    if (moved.length > 0) return settle('void');
  }
  const dueDay = timer.triggerKind === 'task_overdue' ? occurrenceDay(timer.occurrence) : undefined;
  if (timer.triggerKind === 'task_overdue') {
    const open = await tx.execute(sql`
      select 1 from app.lead_tasks k
      where k.workspace_id = ${workspaceId} and k.id = ${timer.subjectId}
        and k.lead_id = ${timer.leadId} and k.status = 'open'
        and to_char(k.due_at at time zone 'UTC', 'YYYY-MM-DD') = ${dueDay ?? ''}
      limit 1
    `);
    if (open.length === 0) return settle('void');
  }

  const flow = (await readLiveFlows(tx, workspaceId)).find(
    (live) => live.id === timer.automationId,
  );
  if (!flow) return settle('void');
  const trigger = storedTrigger(flow.definition);
  if (!trigger || trigger.kind !== timer.triggerKind) return settle('void');
  if (trigger.kind === 'time_in_stage') {
    if (trigger.leadType !== lead.leadType || trigger.stage !== timer.stage) return settle('void');
  } else if (!triggerLeadTypes(trigger).includes(lead.leadType)) {
    return settle('void');
  }

  const fire: FireFlowsContext = {
    ...context,
    actorId: flow.activatedBy ?? context.actorId,
    now: () => now,
    siteHolder: context.siteHolder ?? flowSiteHolder(workspaceId, context.catalog),
  };
  const parsed = flowDefinitionSchemaFor(flow.origin).safeParse(flow.definition);
  if (parsed.success && parsed.data.trigger.when) {
    const site = await siteOf(tx, fire);
    const whenIssue = firstIssue(checkFlowAgainstSite(parsed.data, site), true);
    // A `when` naming something gone is the run's to record (skipped); a false one voids.
    if (!whenIssue) {
      const holds = await evaluateConditionGroup(tx, {
        workspaceId,
        leadId: timer.leadId,
        leadType: lead.leadType,
        group: parsed.data.trigger.when,
        catalog: site.catalog,
      });
      if (!holds) return settle('void');
    }
  }

  const dueAt = timerDueAt(trigger, { eventAt, ...(dueDay ? { dueDay } : {}) });
  if (!dueAt) return settle('void');
  if (dueAt.getTime() > now.getTime()) {
    await tx.execute(sql`
      update app.automation_timers
      set due_at = ${dueAt.toISOString()}::timestamptz, updated_at = ${now.toISOString()}::timestamptz
      where workspace_id = ${workspaceId} and id = ${timer.id}
    `);
    return 'deferred';
  }
  await settle('fired');
  await countingRuns(tx, fire, (counted) =>
    startFlowRun(tx, counted, flow, {
      leadId: timer.leadId,
      leadType: lead.leadType,
      occurrence: timer.occurrence,
      depth: 0,
      chain: [],
      parentRunId: null,
      triggerKind: trigger.kind,
    }),
  );
  return 'fired';
}
