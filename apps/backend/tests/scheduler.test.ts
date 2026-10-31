import { afterEach, describe, expect, it, vi } from 'vitest';

import { MachineRegistry, type MachineRegistryConfig } from '../src/machines/registry.js';
import {
  createBackendScheduler,
  createScheduler,
  INTAKE_CHECK_INTERVAL_MS,
  SchedulerConfigurationError,
  type SchedulerTask,
  runDataRetention,
  runDocumentCleanup,
  runOutboxWithQueueMonitor,
} from '../src/scheduler.js';
import { INITIAL_QUEUE_HEALTH_STATE, type QueueHealthState } from '../src/jobs/queueMonitor.js';
import { operationalRetentionEnabled } from '../src/retention/operational.js';
import type { IntakeCheckRunInput } from '../src/intake-check/check.js';

const WORKSPACE = '10000000-0000-4000-8000-000000000901';
const ACTOR = '20000000-0000-4000-8000-000000000901';
const SECRET = 'scheduler-secret-value-000000000901';
const TEST_SITE = '16000000-0000-4000-8000-00000000f710';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

it('alerts for a persisted failed queue even when later runs process nothing', async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(0);
    let state: QueueHealthState = INITIAL_QUEUE_HEALTH_STATE;
    const jobs = {
      run: vi.fn(async () => ({ failed: 0, uncertain: 0 })),
      queueHealth: vi.fn(async () => ({ failed: 1, uncertain: 0 })),
    };
    const alerts = { send: vi.fn(async () => {}) };
    const input = { authorizedWorkspaceIds: [WORKSPACE], actorId: ACTOR };
    const tick = () =>
      runOutboxWithQueueMonitor(
        jobs,
        alerts,
        input,
        (next) => {
          state = next;
        },
        () => state,
      );
    await tick();
    expect(alerts.send).not.toHaveBeenCalled();
    vi.setSystemTime(10 * 60_000);
    await tick();
    expect(alerts.send).toHaveBeenCalledOnce();
    expect(jobs.queueHealth).toHaveBeenCalledWith(input);
    expect(alerts.send).toHaveBeenCalledWith(
      expect.objectContaining({ detail: 'failed:1,uncertain:0' }),
    );
  } finally {
    vi.useRealTimers();
  }
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function task(run: SchedulerTask['run']): SchedulerTask {
  return { name: 'outbox', intervalMs: 1_000, run };
}

describe('createScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ticks at the configured interval', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => undefined);
    const scheduler = createScheduler({
      tasks: [task(run)],
      startupDelayMs: 0,
      jitterMs: 0,
      random: () => 0,
    });

    scheduler.start();
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(run).toHaveBeenCalledTimes(5);
    await scheduler.stop();
  });

  it('waits for the startup delay before the first tick', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => undefined);
    const scheduler = createScheduler({
      tasks: [task(run)],
      startupDelayMs: 10_000,
      jitterMs: 0,
      random: () => 0,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });

  it('applies the injected jitter to each tick', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => undefined);
    const scheduler = createScheduler({
      tasks: [task(run)],
      startupDelayMs: 0,
      jitterMs: 5_000,
      random: () => 0.5,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_499);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it('skips a tick while the previous run is still in flight', async () => {
    vi.useFakeTimers();
    const gate = deferred<void>();
    const run = vi.fn(() => gate.promise);
    const scheduler = createScheduler({
      tasks: [task(run)],
      startupDelayMs: 0,
      jitterMs: 0,
      random: () => 0,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);

    // The run is still in flight, so the tick at +1s must be skipped.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(1);

    gate.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it('keeps ticking after a run throws', async () => {
    vi.useFakeTimers();
    const error = new Error('transient failure');
    const run = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const onError = vi.fn();
    const scheduler = createScheduler({
      tasks: [task(run)],
      startupDelayMs: 0,
      jitterMs: 0,
      random: () => 0,
      onError,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith({ name: 'outbox', error });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it('logs a thrown run through the PII-safe logger by default', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const run = vi.fn(async () => {
      throw new Error('sensitive someone@example.com');
    });
    const scheduler = createScheduler({
      tasks: [task(run)],
      startupDelayMs: 0,
      jitterMs: 0,
      random: () => 0,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0]?.[0] ?? '');
    expect(line).toContain('scheduler_task_failed');
    expect(line).not.toContain('someone@example.com');
    spy.mockRestore();
    await scheduler.stop();
  });

  it('stop() resolves only after an in-flight run finishes', async () => {
    vi.useFakeTimers();
    const gate = deferred<void>();
    const run = vi.fn(() => gate.promise);
    const scheduler = createScheduler({
      tasks: [task(run)],
      startupDelayMs: 0,
      jitterMs: 0,
      random: () => 0,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);

    gate.resolve();
    await stopping;
    expect(stopped).toBe(true);
  });
});

describe('createBackendScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const baseEnv = {
    ENABLE_SCHEDULER: '1',
    DEPLOYMENT_ENV: 'production',
    CRON_SECRET: SECRET,
    JOB_RUNNER_SELECTOR: 'runner',
  };

  const runner: MachineRegistryConfig['schedulers'][number] = {
    selector: 'runner',
    secret: SECRET,
    actorId: ACTOR,
    workspaceIds: [WORKSPACE],
    scopes: ['outbox:run'],
    revoked: false,
  };

  function registryWith(entries: MachineRegistryConfig['schedulers']): MachineRegistry {
    return new MachineRegistry({ webhooks: [], schedulers: entries });
  }

  function dependencies(registry: MachineRegistry) {
    return {
      registry,
      runOutbox: vi.fn(async () => undefined),
      runDocumentCleanup: vi.fn(async () => undefined),
      runDataRetention: vi.fn(async () => undefined),
      runIntakeCheck: vi.fn(async (_input: IntakeCheckRunInput): Promise<unknown> => undefined),
    };
  }

  it('is disabled unless ENABLE_SCHEDULER=1', () => {
    const scheduler = createBackendScheduler(dependencies(registryWith([runner])), { env: {} });
    expect(scheduler).toBeUndefined();
  });

  it('refuses to start on a preview deployment', () => {
    expect(() =>
      createBackendScheduler(dependencies(registryWith([runner])), {
        env: { ...baseEnv, DEPLOYMENT_ENV: 'preview' },
      }),
    ).toThrow(SchedulerConfigurationError);
  });

  it('refuses to start without the required scope', () => {
    expect(() =>
      createBackendScheduler(dependencies(registryWith([{ ...runner, scopes: [] }])), {
        env: baseEnv,
      }),
    ).toThrow(/scheduler_scope_missing/);
  });

  it('refuses to start without a selector or secret', () => {
    expect(() =>
      createBackendScheduler(dependencies(registryWith([runner])), {
        env: { ...baseEnv, JOB_RUNNER_SELECTOR: undefined },
      }),
    ).toThrow(/scheduler_selector_missing/);
    expect(() =>
      createBackendScheduler(dependencies(registryWith([runner])), {
        env: { ...baseEnv, CRON_SECRET: undefined },
      }),
    ).toThrow(/scheduler_secret_missing/);
  });

  it('runs every task with the registry actor and workspace set', async () => {
    vi.useFakeTimers();
    const deps = dependencies(registryWith([runner]));
    const scheduler = createBackendScheduler(deps, {
      env: baseEnv,
      startupDelayMs: 0,
      jitterMs: 0,
      random: () => 0,
    });
    expect(scheduler).toBeDefined();

    scheduler?.start();
    await vi.advanceTimersByTimeAsync(0);
    const expected = { actorId: ACTOR, authorizedWorkspaceIds: [WORKSPACE] };
    expect(deps.runOutbox).toHaveBeenCalledWith(expected);
    // The upload sweep and daily retention run with the outbox identity.
    expect(deps.runDocumentCleanup).toHaveBeenCalledWith(expected);
    expect(deps.runDataRetention).toHaveBeenCalledWith(expected);
    expect(deps.runIntakeCheck).not.toHaveBeenCalled();
    await scheduler?.stop();
  });

  const checker = { ...runner, scopes: ['outbox:run', 'synthetic:check'] } satisfies typeof runner;
  const intakeEnv = { ...baseEnv, INTAKE_CHECK_WORKSPACE_ID: TEST_SITE };

  it('registers intake_check every 15 minutes only when INTAKE_CHECK_WORKSPACE_ID is set', async () => {
    expect(INTAKE_CHECK_INTERVAL_MS).toBe(15 * 60_000);
    vi.useFakeTimers();
    const deps = dependencies(registryWith([checker]));
    const scheduler = createBackendScheduler(deps, {
      env: intakeEnv,
      startupDelayMs: 10_000,
      jitterMs: 0,
      random: () => 0,
    });
    scheduler?.start();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(deps.runIntakeCheck).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.runIntakeCheck).toHaveBeenCalledTimes(1);
    expect(deps.runIntakeCheck).toHaveBeenLastCalledWith({
      workspaceId: TEST_SITE,
      actorId: ACTOR,
      requestId: expect.stringMatching(UUID),
    });
    await vi.advanceTimersByTimeAsync(INTAKE_CHECK_INTERVAL_MS);
    expect(deps.runIntakeCheck).toHaveBeenCalledTimes(2);
    const [first, second] = deps.runIntakeCheck.mock.calls.map((call) => call[0].requestId);
    expect(first).not.toBe(second);
    await scheduler?.stop();

    for (const env of [baseEnv, { ...baseEnv, INTAKE_CHECK_WORKSPACE_ID: '' }]) {
      const unset = dependencies(registryWith([checker]));
      const off = createBackendScheduler(unset, {
        env,
        startupDelayMs: 0,
        jitterMs: 0,
        random: () => 0,
      });
      off?.start();
      await vi.advanceTimersByTimeAsync(2 * INTAKE_CHECK_INTERVAL_MS);
      expect(unset.runOutbox).toHaveBeenCalled();
      expect(unset.runIntakeCheck).not.toHaveBeenCalled();
      await off?.stop();
    }
  });

  it('skips an intake tick while the previous run is still in flight', async () => {
    vi.useFakeTimers();
    const deps = dependencies(registryWith([checker]));
    deps.runIntakeCheck.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 20 * 60_000)),
    );
    const scheduler = createBackendScheduler(deps, {
      env: intakeEnv,
      startupDelayMs: 0,
      jitterMs: 0,
      random: () => 0,
    });
    scheduler?.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.runIntakeCheck).toHaveBeenCalledTimes(1);
    // 15 minutes: the first run is still going, so the tick is skipped.
    await vi.advanceTimersByTimeAsync(INTAKE_CHECK_INTERVAL_MS);
    expect(deps.runIntakeCheck).toHaveBeenCalledTimes(1);
    // 20 minutes: it resolves; 30 minutes: the next tick runs.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(deps.runIntakeCheck).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(deps.runIntakeCheck).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    await scheduler?.stop();
  });

  function configurationCode(error: unknown): string | undefined {
    return error instanceof SchedulerConfigurationError ? error.code : undefined;
  }

  it('leaves out the intake check, keeping the other tasks, when the scope is missing', async () => {
    vi.useFakeTimers();
    const deps = dependencies(registryWith([runner]));
    const onError = vi.fn();
    const scheduler = createBackendScheduler(deps, {
      env: intakeEnv,
      startupDelayMs: 0,
      jitterMs: 0,
      random: () => 0,
      onError,
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ name: 'intake_check' });
    expect(configurationCode(onError.mock.calls[0]?.[0]?.error)).toBe('scheduler_scope_missing');
    scheduler?.start();
    await vi.advanceTimersByTimeAsync(INTAKE_CHECK_INTERVAL_MS);
    expect(deps.runOutbox).toHaveBeenCalled();
    expect(deps.runDocumentCleanup).toHaveBeenCalled();
    expect(deps.runDataRetention).toHaveBeenCalled();
    expect(deps.runIntakeCheck).not.toHaveBeenCalled();
    await scheduler?.stop();
  });

  it('an invalid INTAKE_CHECK_WORKSPACE_ID is logged by its code', async () => {
    vi.useFakeTimers();
    const deps = dependencies(registryWith([checker]));
    const onError = vi.fn();
    const scheduler = createBackendScheduler(deps, {
      env: { ...baseEnv, INTAKE_CHECK_WORKSPACE_ID: 'not-a-uuid' },
      startupDelayMs: 0,
      jitterMs: 0,
      random: () => 0,
      onError,
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ name: 'intake_check' });
    expect(configurationCode(onError.mock.calls[0]?.[0]?.error)).toBe(
      'intake_check_workspace_invalid',
    );
    scheduler?.start();
    await vi.advanceTimersByTimeAsync(INTAKE_CHECK_INTERVAL_MS);
    expect(deps.runOutbox).toHaveBeenCalled();
    expect(deps.runIntakeCheck).not.toHaveBeenCalled();
    await scheduler?.stop();
  });

  it('logs a configuration error by its code', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const scheduler = createBackendScheduler(dependencies(registryWith([checker])), {
        env: { ...baseEnv, INTAKE_CHECK_WORKSPACE_ID: 'not-a-uuid' },
      });
      expect(scheduler).toBeDefined();
      expect(spy).toHaveBeenCalledTimes(1);
      const record: unknown = JSON.parse(String(spy.mock.calls[0]?.[0]));
      expect(record).toMatchObject({
        event: 'request_error',
        requestId: 'scheduler:intake_check',
        code: 'intake_check_workspace_invalid',
      });
      expect(String(spy.mock.calls[0]?.[0])).not.toContain('scheduler_task_failed');
      expect(String(spy.mock.calls[0]?.[0])).not.toContain('not-a-uuid');
      await scheduler?.stop();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('runDocumentCleanup', () => {
  it('sweeps each authorized workspace once and totals the result', async () => {
    const sweepExpired = vi.fn(async ({ workspaceId }: { workspaceId: string }) =>
      workspaceId === 'w1'
        ? { expiredIntents: 2, deletedObjects: 3, failedDeletes: 1 }
        : { expiredIntents: 1, deletedObjects: 1, failedDeletes: 0 },
    );
    const result = await runDocumentCleanup(
      { sweepExpired },
      { actorId: 'actor', authorizedWorkspaceIds: ['w1', 'w2', 'w1'] },
    );
    expect(sweepExpired).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ expiredIntents: 3, deletedObjects: 4, failedDeletes: 1 });
  });

  it('does nothing when document storage is not configured', async () => {
    expect(
      await runDocumentCleanup(undefined, { actorId: 'actor', authorizedWorkspaceIds: ['w1'] }),
    ).toEqual({ skipped: 'feature_not_ready' });
  });
});

describe('runDataRetention', () => {
  it('restricts abandoned lead drafts once per authorized workspace', async () => {
    const now = new Date('2026-10-22T00:00:00.000Z');
    const restrictAbandoned = vi.fn(async ({ workspaceId }: { workspaceId: string }) => ({
      restrictedLeads: workspaceId === 'w1' ? 3 : 1,
    }));
    const result = await runDataRetention(
      { abandonedLeads: { restrictAbandoned } },
      { actorId: 'actor', authorizedWorkspaceIds: ['w1', 'w2', 'w1'] },
      now,
    );
    expect(restrictAbandoned).toHaveBeenCalledTimes(2);
    expect(restrictAbandoned).toHaveBeenCalledWith({ workspaceId: 'w1', actorId: 'actor', now });
    expect(result).toEqual({ restrictedLeads: 4, prunedRows: 'disabled' });
  });

  it('prunes operational rows only when the pruner is configured', async () => {
    const now = new Date('2026-10-22T00:00:00.000Z');
    const restrictAbandoned = vi.fn(async () => ({ restrictedLeads: 0 }));
    const prune = vi.fn(async ({ workspaceId }: { workspaceId: string }) => [
      { tableName: 'outbox_jobs', deleted: workspaceId === 'w1' ? 5 : 2 },
      { tableName: 'idempotency_keys', deleted: 1 },
    ]);
    const result = await runDataRetention(
      { abandonedLeads: { restrictAbandoned }, operational: { prune } },
      { actorId: 'actor', authorizedWorkspaceIds: ['w1', 'w2'] },
      now,
    );
    expect(prune).toHaveBeenCalledWith({ workspaceId: 'w2', actorId: 'actor', now });
    expect(result).toEqual({
      restrictedLeads: 0,
      prunedRows: { outbox_jobs: 7, idempotency_keys: 2 },
    });
  });
});

describe('operationalRetentionEnabled', () => {
  it('is off unless OPERATIONAL_RETENTION_ENABLED is exactly 1', () => {
    expect(operationalRetentionEnabled({})).toBe(false);
    expect(operationalRetentionEnabled({ OPERATIONAL_RETENTION_ENABLED: 'true' })).toBe(false);
    expect(operationalRetentionEnabled({ OPERATIONAL_RETENTION_ENABLED: '1' })).toBe(true);
  });
});
