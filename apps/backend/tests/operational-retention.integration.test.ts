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
const DAY = 24 * 60 * 60 * 1000;
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
    expect(result.map((row) => row.tableName).sort()).toEqual(
      ['email_provider_events', 'outbox_job_alerts', 'outbox_jobs'].sort(),
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
    const [grants] = await admin<{ jobs: boolean; events: boolean }[]>`
      select
        has_table_privilege('app_runtime', 'app.outbox_jobs', 'delete') as jobs,
        has_table_privilege('app_runtime', 'app.email_provider_events', 'delete') as events
    `;
    expect(grants).toEqual({ jobs: false, events: false });
  });
});
