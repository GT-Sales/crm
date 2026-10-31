import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

import { DatabaseOperationalPruner } from '../src/retention/operational.js';

function getDisposableTestDatabaseUrl(): string | undefined {
  const migrationUrl = process.env.TEST_MIGRATION_DATABASE_URL;
  const destructiveTestsEnabled = process.env.DB_TEST_ALLOW_DESTRUCTIVE === '1';
  if (!migrationUrl && !destructiveTestsEnabled && !process.env.CI) return undefined;
  if (!migrationUrl || !destructiveTestsEnabled) {
    throw new Error(
      'Database integration tests require TEST_MIGRATION_DATABASE_URL and DB_TEST_ALLOW_DESTRUCTIVE=1 together.',
    );
  }
  const databaseName = decodeURIComponent(new URL(migrationUrl).pathname.slice(1));
  if (!databaseName.endsWith('_test')) {
    throw new Error('TEST_MIGRATION_DATABASE_URL must name a disposable database ending in _test.');
  }
  return migrationUrl;
}

const migrationUrl = getDisposableTestDatabaseUrl();
const databaseTest = migrationUrl ? describe : describe.skip;

const WORKSPACE = '11000000-0000-4000-8000-000000000d19';
const OTHER_WORKSPACE = '11000000-0000-4000-8000-000000000d20';
const ACTOR = '21000000-0000-4000-8000-000000000d19';
const NOW = new Date('2026-10-22T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';

// The prune function removes only operational rows past their window, and only
// for the workspace of the caller's own tenant transaction.
databaseTest('operational retention (app.prune_operational_rows)', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('missing migration URL');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    await admin`
      insert into app.workspaces (id, slug, name)
      values
        (${WORKSPACE}, 'ci-operational-retention', 'CI Operational Retention'),
        (${OTHER_WORKSPACE}, 'ci-operational-retention-b', 'CI Operational Retention B')
      on conflict (id) do nothing
    `;
    await admin`delete from app.outbox_jobs where workspace_id in (${WORKSPACE}, ${OTHER_WORKSPACE})`;
    await admin`delete from app.email_provider_events where workspace_id in (${WORKSPACE}, ${OTHER_WORKSPACE})`;
    const job = (workspace: string, key: string, status: string, completedAt: Date | null) => admin`
      insert into app.outbox_jobs (workspace_id, job_type, dedupe_key, payload, status, completed_at, updated_at)
      values (${workspace}, 'analytics_lead_saved', ${key}, ${admin.json({ leadId: crypto.randomUUID() })},
        ${status}, ${completedAt}, ${completedAt ?? NOW})
    `;
    await job(WORKSPACE, 'retention:old-completed', 'completed', daysAgo(40));
    await job(WORKSPACE, 'retention:recent-completed', 'completed', daysAgo(10));
    await job(WORKSPACE, 'retention:old-failed', 'failed', null);
    await admin`
      update app.outbox_jobs set updated_at = ${daysAgo(40)}
      where workspace_id = ${WORKSPACE} and dedupe_key = 'retention:old-failed'
    `;
    await job(OTHER_WORKSPACE, 'retention:other-old-completed', 'completed', daysAgo(40));

    const providerEvent = (eventId: string, appliedAt: Date | null) => admin`
      insert into app.email_provider_events
        (workspace_id, provider_event_id, provider, provider_account, event_type, received_at, applied_at)
      values (${WORKSPACE}, ${eventId}, 'resend', 'ci', 'delivered', ${appliedAt ?? NOW}, ${appliedAt})
    `;
    await providerEvent('retention-old-event', daysAgo(200));
    await providerEvent('retention-recent-event', daysAgo(20));
    await providerEvent('retention-unapplied-event', null);

    // Idempotency keys after 7 days, automation runs after 90 days.
    await admin`delete from app.idempotency_keys where workspace_id in (${WORKSPACE}, ${OTHER_WORKSPACE})`;
    await admin`delete from app.leads where workspace_id in (${WORKSPACE}, ${OTHER_WORKSPACE})`;
    const idempotencyKey = (workspace: string, digit: string, createdAt: Date) => admin`
      insert into app.idempotency_keys (workspace_id, scope, key_hash, request_fingerprint, created_at)
      values (${workspace}, 'lead_submission', ${digit.repeat(64)}, ${`sha256:${'0'.repeat(64)}`},
        ${createdAt})
    `;
    await idempotencyKey(WORKSPACE, '8', daysAgo(8));
    await idempotencyKey(WORKSPACE, '6', daysAgo(6));
    await idempotencyKey(OTHER_WORKSPACE, '9', daysAgo(8));
    const [lead] = await admin<{ id: string }[]>`
      insert into app.leads (workspace_id, lead_type, status, stage, consent_version)
      values (${WORKSPACE}, 'sim_order', 'submitted', 'pending', 'ci')
      returning id
    `;
    if (!lead) throw new Error('the lead was not inserted');
    const automationRun = (reason: string, createdAt: Date) => admin`
      insert into app.automation_runs (workspace_id, automation_key, lead_id, outcome, reason, created_at)
      values (${WORKSPACE}, 'order_received', ${lead.id}, 'skipped', ${reason}, ${createdAt})
    `;
    await automationRun('no_sender', daysAgo(91));
    await automationRun('no_customer_email', daysAgo(89));

    // Flow runs 90 days after they finish (a waiting one never), their step
    // runs and waits with them; fired and void timers 90 days after they ended.
    await admin`delete from app.automations where workspace_id in (${WORKSPACE}, ${OTHER_WORKSPACE})`;
    const [flow] = await admin<{ id: string }[]>`
      insert into app.automations (workspace_id, key, updated_by)
      values (${WORKSPACE}, 'order_received', ${ACTOR})
      returning id
    `;
    if (!flow) throw new Error('the flow was not inserted');
    const flowRun = async (
      detail: string,
      status: string,
      createdAt: Date,
      finishedAt: Date | null,
    ) => {
      const [row] = await admin<{ id: string }[]>`
        insert into app.automation_runs
          (workspace_id, automation_key, automation_id, lead_id, status, detail, occurrence,
           created_at, finished_at)
        values (${WORKSPACE}, 'order_received', ${flow.id}, ${lead.id}, ${status}, ${detail},
          ${detail}, ${createdAt}, ${finishedAt})
        returning id
      `;
      if (!row) throw new Error('the run was not inserted');
      await admin`
        insert into app.automation_step_runs (workspace_id, run_id, step_id, step_kind, outcome, created_at)
        values (${WORKSPACE}, ${row.id}, 's_wait', 'wait', 'waiting', ${createdAt})
      `;
      await admin`
        insert into app.automation_waits
          (workspace_id, run_id, automation_id, lead_id, step_id, resume_at, status)
        values (${WORKSPACE}, ${row.id}, ${flow.id}, ${lead.id}, 's_wait', ${createdAt},
          ${status === 'waiting' ? 'pending' : 'resumed'})
      `;
    };
    await flowRun('flow_waiting_old', 'waiting', daysAgo(200), null);
    await flowRun('flow_finished_old', 'completed', daysAgo(200), daysAgo(91));
    await flowRun('flow_finished_recent', 'completed', daysAgo(200), daysAgo(10));
    const timer = (occurrence: string, status: string, updatedAt: Date) => admin`
      insert into app.automation_timers
        (workspace_id, automation_id, lead_id, trigger_kind, occurrence, event_at, due_at, status,
         updated_at)
      values (${WORKSPACE}, ${flow.id}, ${lead.id}, 'after_submitted', ${occurrence},
        ${daysAgo(300)}, ${daysAgo(299)}, ${status}, ${updatedAt})
    `;
    await timer('fired_old', 'fired', daysAgo(91));
    await timer('void_old', 'void', daysAgo(91));
    await timer('fired_recent', 'fired', daysAgo(89));
    await timer('pending_old', 'pending', daysAgo(200));

    // Tracking challenges 24 hours after they expire; change requests are kept.
    await admin`delete from app.tracking_challenges where workspace_id in (${WORKSPACE}, ${OTHER_WORKSPACE})`;
    const challenge = (workspace: string, emailDigit: string, expiresAt: Date) => admin`
      insert into app.tracking_challenges (workspace_id, email_hash, code_hash, expires_at, created_at)
      values (${workspace}, ${emailDigit.repeat(64)}, ${'c'.repeat(64)}, ${expiresAt},
        ${new Date(expiresAt.getTime() - 10 * 60 * 1000)})
    `;
    await challenge(WORKSPACE, 'a', new Date(NOW.getTime() - 25 * HOUR));
    await challenge(WORKSPACE, 'b', new Date(NOW.getTime() - 23 * HOUR));
    await challenge(OTHER_WORKSPACE, 'd', new Date(NOW.getTime() - 25 * HOUR));
    await admin`
      insert into app.change_requests
        (workspace_id, lead_id, request_no, status, created_by, resolved_by, resolved_at, created_at, updated_at)
      values (${WORKSPACE}, ${lead.id}, 1, 'approved', ${ACTOR}, ${ACTOR}, ${daysAgo(400)},
        ${daysAgo(400)}, ${daysAgo(400)})
    `;

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({ connectionString: runtimeUrl.toString(), ssl: false });
  });

  afterAll(async () => {
    await database?.close();
    await admin?.end();
  });

  test('deletes old completed jobs and applied provider events in this workspace only', async () => {
    const result = await new DatabaseOperationalPruner(database).prune({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      now: NOW,
    });
    expect(result).toContainEqual({ tableName: 'outbox_jobs', deleted: 1 });
    expect(result).toContainEqual({ tableName: 'email_provider_events', deleted: 1 });
    expect(result).toContainEqual({ tableName: 'idempotency_keys', deleted: 1 });
    expect(result).toContainEqual({ tableName: 'automation_runs', deleted: 2 });
    expect(result).toContainEqual({ tableName: 'automation_timers', deleted: 2 });
    expect(result).toContainEqual({ tableName: 'tracking_challenges', deleted: 1 });
    expect(result.map((row) => row.tableName).sort()).toEqual(
      [
        'automation_runs',
        'automation_timers',
        'email_provider_events',
        'idempotency_keys',
        'outbox_job_alerts',
        'outbox_jobs',
        'tracking_challenges',
      ].sort(),
    );
    const remaining = await admin<{ dedupe_key: string }[]>`
      select dedupe_key from app.outbox_jobs
      where workspace_id in (${WORKSPACE}, ${OTHER_WORKSPACE}) order by dedupe_key
    `;
    expect(remaining.map((row) => row.dedupe_key)).toEqual([
      'retention:old-failed',
      'retention:other-old-completed',
      'retention:recent-completed',
    ]);
    const events = await admin<{ provider_event_id: string }[]>`
      select provider_event_id from app.email_provider_events
      where workspace_id = ${WORKSPACE} order by provider_event_id
    `;
    expect(events.map((row) => row.provider_event_id)).toEqual([
      'retention-recent-event',
      'retention-unapplied-event',
    ]);
    const keys = await admin<{ workspace_id: string; key_hash: string }[]>`
      select workspace_id, key_hash from app.idempotency_keys
      where workspace_id in (${WORKSPACE}, ${OTHER_WORKSPACE}) order by key_hash
    `;
    expect(keys).toEqual([
      { workspace_id: WORKSPACE, key_hash: '6'.repeat(64) },
      { workspace_id: OTHER_WORKSPACE, key_hash: '9'.repeat(64) },
    ]);
    const runs = await admin<{ label: string }[]>`
      select coalesce(reason, detail) as label from app.automation_runs
      where workspace_id = ${WORKSPACE} order by label
    `;
    expect(runs.map((row) => row.label)).toEqual([
      'flow_finished_recent',
      'flow_waiting_old',
      'no_customer_email',
    ]);
    const steps = await admin<{ count: number }[]>`
      select count(*)::int as count from app.automation_step_runs where workspace_id = ${WORKSPACE}
    `;
    expect(steps[0]?.count).toBe(2);
    const waits = await admin<{ status: string }[]>`
      select status from app.automation_waits where workspace_id = ${WORKSPACE} order by status
    `;
    expect(waits.map((row) => row.status)).toEqual(['pending', 'resumed']);
    const timers = await admin<{ occurrence: string }[]>`
      select occurrence from app.automation_timers where workspace_id = ${WORKSPACE}
      order by occurrence
    `;
    expect(timers.map((row) => row.occurrence)).toEqual(['fired_recent', 'pending_old']);
    const challenges = await admin<{ workspace_id: string; email_hash: string }[]>`
      select workspace_id, email_hash from app.tracking_challenges
      where workspace_id in (${WORKSPACE}, ${OTHER_WORKSPACE}) order by email_hash
    `;
    expect(challenges).toEqual([
      { workspace_id: WORKSPACE, email_hash: 'b'.repeat(64) },
      { workspace_id: OTHER_WORKSPACE, email_hash: 'd'.repeat(64) },
    ]);
    const requests = await admin<{ request_no: number }[]>`
      select request_no from app.change_requests where workspace_id = ${WORKSPACE}
    `;
    expect(requests).toEqual([{ request_no: 1 }]);
  });

  test('refuses a workspace other than the transaction tenant', async () => {
    await expect(
      database.withTenantTx({ workspaceId: WORKSPACE, actorId: ACTOR }, (tx) =>
        tx.execute(sql`select * from app.prune_operational_rows(${OTHER_WORKSPACE}::uuid, now())`),
      ),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ message: 'workspace_context_mismatch' }),
    });
  });

  test('the runtime role holds no direct delete grant on the pruned tables', async () => {
    const [grants] = await admin<
      {
        jobs: boolean;
        events: boolean;
        keys: boolean;
        runs: boolean;
        challenges: boolean;
        steps: boolean;
        waits: boolean;
        timers: boolean;
      }[]
    >`
      select
        has_table_privilege('app_runtime', 'app.outbox_jobs', 'delete') as jobs,
        has_table_privilege('app_runtime', 'app.email_provider_events', 'delete') as events,
        has_table_privilege('app_runtime', 'app.idempotency_keys', 'delete') as keys,
        has_table_privilege('app_runtime', 'app.automation_runs', 'delete') as runs,
        has_table_privilege('app_runtime', 'app.tracking_challenges', 'delete') as challenges,
        has_table_privilege('app_runtime', 'app.automation_step_runs', 'delete') as steps,
        has_table_privilege('app_runtime', 'app.automation_waits', 'delete') as waits,
        has_table_privilege('app_runtime', 'app.automation_timers', 'delete') as timers
    `;
    expect(grants).toEqual({
      jobs: false,
      events: false,
      keys: false,
      runs: false,
      challenges: false,
      steps: false,
      waits: false,
      timers: false,
    });
  });
});
