import { randomUUID } from 'node:crypto';

import { createOwnerAlertChannelFromEnv, type OwnerAlertChannel } from '@gt-sales/adapters';
import type { MachineScopeName } from '@gt-sales/types';
import { z } from 'zod';

import { AUTOMATION_TICK_INTERVAL_MS, runAutomationTick } from './automations/tick.js';
import { loadDeploymentEnvironment } from './config/deployment.js';
import { createDocumentServiceFromEnv } from './documents/factory.js';
import { customerEmailEnvironmentFromEnv } from './email/senders.js';
import type { DocumentService } from './documents/service.js';
import {
  INITIAL_INTAKE_ALERT_STATE,
  runIntakeCheckWithAlert,
  type IntakeAlertState,
} from './intake-check/alert-rule.js';
import { runIntakeCheck, type IntakeCheckRunInput } from './intake-check/check.js';
import { DatabaseIntakeCheckStore } from './intake-check/store.js';
import { DatabaseLeadStore } from './leads/store.js';
import { DatabaseAbandonedLeadPruner } from './retention/abandoned-leads.js';
import { DatabaseOperationalPruner, operationalRetentionEnabled } from './retention/operational.js';
import { isConnectionLevelError, logRequestError } from './http/logger.js';
import {
  INITIAL_QUEUE_HEALTH_STATE,
  trackQueueHealth,
  type QueueHealthState,
} from './jobs/queueMonitor.js';
import type { MachineRegistry } from './machines/registry.js';
import { createDefaultJobsRouteDependencies } from './routes/jobs.js';

/**
 * In-process scheduler for the long-lived Railway deployment. Railway cron has
 * a five-minute floor and no minute-level precision, but the outbox needs a
 * 60-second cadence, so the jobs run on timers inside the service.
 *
 * Identity is resolved exactly as the HTTP routes resolve it: through the
 * server-only machine registry, selected by `JOB_RUNNER_SELECTOR`, verified
 * with `CRON_SECRET`, and required to hold `outbox:run`. The authorized
 * workspace set and actor id come from that verified entry — never from a
 * database tenant scan.
 */

export const OUTBOX_INTERVAL_MS = 60_000;
/** Abandoned uploads expire after a 24-hour grace, so hourly is plenty. */
export const DOCUMENT_CLEANUP_INTERVAL_MS = 60 * 60_000;
/** Retention windows are measured in days, so once a day. */
export const DATA_RETENTION_INTERVAL_MS = 24 * 60 * 60_000;
/** The intake check (spec §4): a broken intake is heard about within 15 minutes. */
export const INTAKE_CHECK_INTERVAL_MS = 15 * 60_000;

const DEFAULT_STARTUP_DELAY_MS = 10_000;
const DEFAULT_JITTER_MS = 5_000;
const OUTBOX_PREFIX = 'scheduler:outbox';
const DOCUMENT_CLEANUP_PREFIX = 'scheduler:document_cleanup';
const DATA_RETENTION_PREFIX = 'scheduler:data_retention';
const INTAKE_CHECK_PREFIX = 'scheduler:intake_check';
const AUTOMATIONS_PREFIX = 'scheduler:automations';
const SCHEDULER_ROUTE = 'scheduler';
const SCHEDULER_ERROR_PREFIXES: Record<SchedulerTaskName, string> = {
  outbox: OUTBOX_PREFIX,
  document_cleanup: DOCUMENT_CLEANUP_PREFIX,
  data_retention: DATA_RETENTION_PREFIX,
  intake_check: INTAKE_CHECK_PREFIX,
  automations: AUTOMATIONS_PREFIX,
};

export type SchedulerTaskName =
  'outbox' | 'document_cleanup' | 'data_retention' | 'intake_check' | 'automations';

export { AUTOMATION_TICK_INTERVAL_MS };

export interface SchedulerTask {
  name: SchedulerTaskName;
  intervalMs: number;
  run(): Promise<unknown>;
}

export interface SchedulerErrorInput {
  name: SchedulerTaskName;
  error: unknown;
}

export interface SchedulerOptions {
  tasks: readonly SchedulerTask[];
  startupDelayMs?: number;
  jitterMs?: number;
  random?: () => number;
  onError?(input: SchedulerErrorInput): void;
}

export interface Scheduler {
  start(): void;
  /** Stops scheduling and resolves only once any in-flight run has finished. */
  stop(): Promise<void>;
}

interface TaskState {
  task: SchedulerTask;
  timer: ReturnType<typeof setTimeout> | undefined;
  inFlight: Promise<void> | undefined;
}

/** A misconfiguration, not a run failure. Its message is always a bounded code. */
export class SchedulerConfigurationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'SchedulerConfigurationError';
  }
}

/**
 * PII-safe default: a raw error is never serialized. A connection-level
 * failure is retryable and everything else is not, matching the HTTP routes.
 * A configuration error (a task left out at start) is logged by its own code.
 */
function logSchedulerError(input: SchedulerErrorInput): void {
  logRequestError({
    requestId: SCHEDULER_ERROR_PREFIXES[input.name],
    route: SCHEDULER_ROUTE,
    code:
      input.error instanceof SchedulerConfigurationError
        ? input.error.code
        : 'scheduler_task_failed',
    flag: isConnectionLevelError(input.error) ? 'retryable' : 'not_retryable',
  });
}

/** Builds the timer engine. Independent timers, no shared tick. */
export function createScheduler(options: SchedulerOptions): Scheduler {
  const startupDelayMs = options.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS;
  const jitterMs = options.jitterMs ?? DEFAULT_JITTER_MS;
  const random = options.random ?? Math.random;
  const onError = options.onError ?? logSchedulerError;
  const states: TaskState[] = options.tasks.map((task) => ({
    task,
    timer: undefined,
    inFlight: undefined,
  }));

  let started = false;
  let stopped = false;

  const delayFor = (baseMs: number): number => baseMs + Math.floor(random() * jitterMs);

  const schedule = (state: TaskState, delayMs: number): void => {
    state.timer = setTimeout(() => {
      void tick(state);
    }, delayMs);
  };

  const tick = async (state: TaskState): Promise<void> => {
    if (stopped) return;
    state.timer = undefined;
    // Cadence is fixed: the next tick is scheduled from this one, before the
    // run starts. A tick that lands while the previous run is still in flight
    // is skipped, not queued — the runner already enforces a run deadline, so
    // the next scheduled tick is the right place to resume.
    schedule(state, delayFor(state.task.intervalMs));
    if (state.inFlight) return;
    state.inFlight = (async () => {
      try {
        await state.task.run();
      } catch (error) {
        onError({ name: state.task.name, error });
      }
    })();
    try {
      await state.inFlight;
    } finally {
      state.inFlight = undefined;
    }
  };

  return {
    start(): void {
      if (started || stopped) return;
      started = true;
      for (const state of states) schedule(state, delayFor(startupDelayMs));
    },
    async stop(): Promise<void> {
      stopped = true;
      for (const state of states) {
        if (state.timer !== undefined) {
          clearTimeout(state.timer);
          state.timer = undefined;
        }
      }
      await Promise.all(states.map((state) => state.inFlight ?? Promise.resolve()));
    },
  };
}

export interface SchedulerRunInput {
  authorizedWorkspaceIds: readonly string[];
  actorId: string;
}

export interface BackendSchedulerDependencies {
  registry: MachineRegistry;
  runOutbox(input: SchedulerRunInput): Promise<unknown>;
  /** Expires abandoned uploads and deletes their storage objects. */
  runDocumentCleanup(input: SchedulerRunInput): Promise<unknown>;
  /** Daily retention: abandoned lead drafts and operational rows. */
  runDataRetention(input: SchedulerRunInput): Promise<unknown>;
  /** One intake check run on the test site, alerting the owner on failure and recovery. */
  runIntakeCheck(input: IntakeCheckRunInput): Promise<unknown>;
  /** One pass over the due automation waits and timers of every authorised site. */
  runAutomationTick(input: SchedulerRunInput): Promise<unknown>;
}

export interface BackendSchedulerConfig {
  env?: NodeJS.ProcessEnv;
  startupDelayMs?: number;
  jitterMs?: number;
  random?: () => number;
  onError?(input: SchedulerErrorInput): void;
}

function resolveIdentity(
  registry: MachineRegistry,
  selector: string | undefined,
  secret: string | undefined,
  scope: MachineScopeName,
): SchedulerRunInput {
  if (!selector) throw new SchedulerConfigurationError('scheduler_selector_missing');
  if (!secret) throw new SchedulerConfigurationError('scheduler_secret_missing');
  const identity = registry.resolveScheduler({ selector, secret });
  if (!identity.ok) throw new SchedulerConfigurationError('scheduler_identity_invalid');
  if (!identity.hasScope(scope)) throw new SchedulerConfigurationError('scheduler_scope_missing');
  return { actorId: identity.actorId, authorizedWorkspaceIds: identity.workspaceIds };
}

/**
 * Builds the backend scheduler when `ENABLE_SCHEDULER=1`; otherwise returns
 * `undefined` (the default). Throws a {@link SchedulerConfigurationError} when
 * enabled but misconfigured, including a preview deployment — a preview must
 * never act as a scheduler.
 */
export function createBackendScheduler(
  dependencies: BackendSchedulerDependencies,
  config: BackendSchedulerConfig = {},
): Scheduler | undefined {
  const env = config.env ?? process.env;
  if (env['ENABLE_SCHEDULER'] !== '1') return undefined;
  if (loadDeploymentEnvironment(env) === 'preview') {
    throw new SchedulerConfigurationError('scheduler_preview_refused');
  }
  const secret = env['CRON_SECRET'];
  const outbox = resolveIdentity(
    dependencies.registry,
    env['JOB_RUNNER_SELECTOR'],
    secret,
    'outbox:run',
  );
  const tasks: SchedulerTask[] = [
    {
      name: 'outbox',
      intervalMs: OUTBOX_INTERVAL_MS,
      run: () => dependencies.runOutbox(outbox),
    },
    {
      // Reuses the outbox identity: same verified actor, same workspace set.
      name: 'document_cleanup',
      intervalMs: DOCUMENT_CLEANUP_INTERVAL_MS,
      run: () => dependencies.runDocumentCleanup(outbox),
    },
    {
      name: 'data_retention',
      intervalMs: DATA_RETENTION_INTERVAL_MS,
      run: () => dependencies.runDataRetention(outbox),
    },
    {
      // Automation waits and time triggers, with the outbox identity (spec §5).
      name: 'automations',
      intervalMs: AUTOMATION_TICK_INTERVAL_MS,
      run: () => dependencies.runAutomationTick(outbox),
    },
  ];

  // The intake check is optional (R5): set but misconfigured, it is left out
  // and logged once by its code, and the tasks above run regardless.
  const intakeWorkspaceId = env['INTAKE_CHECK_WORKSPACE_ID'];
  if (intakeWorkspaceId) {
    try {
      if (!z.uuid().safeParse(intakeWorkspaceId).success) {
        throw new SchedulerConfigurationError('intake_check_workspace_invalid');
      }
      // The site comes from deployment config, so it need not be in the
      // entry's `workspaceIds`; the identity must hold `synthetic:check`.
      const identity = resolveIdentity(
        dependencies.registry,
        env['JOB_RUNNER_SELECTOR'],
        secret,
        'synthetic:check',
      );
      tasks.push({
        name: 'intake_check',
        intervalMs: INTAKE_CHECK_INTERVAL_MS,
        run: () =>
          dependencies.runIntakeCheck({
            workspaceId: intakeWorkspaceId,
            actorId: identity.actorId,
            requestId: randomUUID(),
          }),
      });
    } catch (error) {
      (config.onError ?? logSchedulerError)({ name: 'intake_check', error });
    }
  }

  return createScheduler({
    tasks,
    startupDelayMs: config.startupDelayMs,
    jitterMs: config.jitterMs,
    random: config.random,
    onError: config.onError,
  });
}

/**
 * Wires the real runners by reusing the exact dependencies the HTTP routes
 * build, so the scheduler and the manual endpoints run identical handler code.
 */
export function createDefaultSchedulerDependencies(): BackendSchedulerDependencies {
  const jobs = createDefaultJobsRouteDependencies();
  const alerts = createOwnerAlertChannelFromEnv();
  const documents = createDocumentServiceFromEnv();
  const abandonedLeads = new DatabaseAbandonedLeadPruner();
  const operational = operationalRetentionEnabled() ? new DatabaseOperationalPruner() : undefined;
  let queueHealth = INITIAL_QUEUE_HEALTH_STATE;
  let intakeAlerts: IntakeAlertState = INITIAL_INTAKE_ALERT_STATE;
  const intakeCheck = { leads: new DatabaseLeadStore(), store: new DatabaseIntakeCheckStore() };
  const automations = { environment: customerEmailEnvironmentFromEnv() };
  return {
    registry: jobs.registry,
    runOutbox: (input) =>
      runOutboxWithQueueMonitor(
        jobs,
        alerts,
        input,
        (state) => (queueHealth = state),
        () => queueHealth,
      ),
    runDocumentCleanup: (input) => runDocumentCleanup(documents, input),
    runDataRetention: (input) =>
      runDataRetention({ abandonedLeads, operational }, input, new Date()),
    runIntakeCheck: (input) =>
      runIntakeCheckWithAlert(
        () => runIntakeCheck(intakeCheck, input),
        alerts,
        () => intakeAlerts,
        (state) => {
          intakeAlerts = state;
        },
      ),
    runAutomationTick: (input) => runAutomationTick(automations, input),
  };
}

export interface DataRetentionDependencies {
  abandonedLeads: Pick<DatabaseAbandonedLeadPruner, 'restrictAbandoned'>;
  /** Present only when OPERATIONAL_RETENTION_ENABLED=1. */
  operational?: Pick<DatabaseOperationalPruner, 'prune'>;
}

/** One pass per authorized workspace; returns counts only, never row data. */
export async function runDataRetention(
  dependencies: DataRetentionDependencies,
  input: SchedulerRunInput,
  now: Date,
): Promise<{ restrictedLeads: number; prunedRows: Record<string, number> | 'disabled' }> {
  let restrictedLeads = 0;
  const pruned: Record<string, number> = {};
  for (const workspaceId of new Set(input.authorizedWorkspaceIds)) {
    const leads = await dependencies.abandonedLeads.restrictAbandoned({
      workspaceId,
      actorId: input.actorId,
      now,
    });
    restrictedLeads += leads.restrictedLeads;
    if (dependencies.operational) {
      for (const table of await dependencies.operational.prune({
        workspaceId,
        actorId: input.actorId,
        now,
      })) {
        pruned[table.tableName] = (pruned[table.tableName] ?? 0) + table.deleted;
      }
    }
  }
  return { restrictedLeads, prunedRows: dependencies.operational ? pruned : 'disabled' };
}

/**
 * One sweep per authorized workspace. Without object storage configured there
 * are no uploads to clean, so the task reports that and does nothing.
 */
export async function runDocumentCleanup(
  documents: Pick<DocumentService, 'sweepExpired'> | undefined,
  input: SchedulerRunInput,
): Promise<
  | { skipped: 'feature_not_ready' }
  | { expiredIntents: number; deletedObjects: number; failedDeletes: number }
> {
  if (!documents) return { skipped: 'feature_not_ready' };
  const totals = { expiredIntents: 0, deletedObjects: 0, failedDeletes: 0 };
  for (const workspaceId of new Set(input.authorizedWorkspaceIds)) {
    const result = await documents.sweepExpired({ workspaceId, actorId: input.actorId });
    totals.expiredIntents += result.expiredIntents;
    totals.deletedObjects += result.deletedObjects;
    totals.failedDeletes += result.failedDeletes;
  }
  return totals;
}

/**
 * Wraps the real outbox runner with the failed-job-queue-growth alert. Kept as
 * a small standalone function (rather than inline in the closure above) purely
 * for readability — the actual detection logic lives in the pure, unit-tested
 * {@link trackQueueHealth}.
 */
export async function runOutboxWithQueueMonitor(
  jobs: {
    run(input: SchedulerRunInput): Promise<unknown>;
    queueHealth(input: SchedulerRunInput): Promise<{ failed: number; uncertain: number }>;
  },
  alerts: OwnerAlertChannel,
  input: SchedulerRunInput,
  setState: (state: QueueHealthState) => void,
  getState: () => QueueHealthState,
): Promise<unknown> {
  const summary = await jobs.run(input);
  const queue = await jobs.queueHealth(input);
  const outcome = trackQueueHealth(getState(), queue, Date.now());
  setState(outcome.nextState);
  if (outcome.shouldAlert) {
    await alerts
      .send({
        kind: 'job_queue_stuck',
        detail: `failed:${queue.failed},uncertain:${queue.uncertain}`,
        occurredAt: new Date().toISOString(),
      })
      .catch(() => {
        // Best-effort — the outbox run itself already succeeded/failed independently.
      });
  }
  return summary;
}
