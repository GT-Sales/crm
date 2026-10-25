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
const LEAD = '51000000-0000-4000-8000-000000000d19';
const ORDER = '82000000-0000-4000-8000-000000000d19';
const NOW = new Date('2026-10-22T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';

// REL-19: the prune function removes only rows past their window.
databaseTest('operational retention (migration 0026)', () => {
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
    const job = (workspace: string, key: string, status: string, completedAt: Date | null) => admin`
      insert into app.outbox_jobs (workspace_id, job_type, dedupe_key, payload, status, completed_at, updated_at)
      values (${workspace}, 'analytics_order_submitted', ${key}, ${admin.json({ orderId: crypto.randomUUID() })},
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

    // A tracking code needs an order; the erasure guard covers tracking_challenges,
    // so clearing a previous run's rows uses the same transaction-local flag.
    await admin.begin(async (tx) => {
      await tx`select pg_catalog.set_config('app.operational_prune', 'on', true)`;
      await tx`delete from app.tracking_challenges where workspace_id = ${WORKSPACE}`;
      await tx`delete from app.orders where workspace_id = ${WORKSPACE}`;
      await tx`delete from app.leads where workspace_id = ${WORKSPACE}`;
    });
    await admin`
      insert into app.leads (id, workspace_id, status, consent_version)
      values (${LEAD}, ${WORKSPACE}, 'submitted', 'terms-1')
    `;
    await admin`
      insert into app.orders (
        id, workspace_id, reference, lead_id, status, payment_state, delivery_state,
        version, snapshot, payload, submitted_at
      ) values (
        ${ORDER}, ${WORKSPACE}, 'CP-RETENTION-1', ${LEAD}, 'submitted', 'not_required', 'none',
        1, '{}'::jsonb, '{}'::jsonb, ${daysAgo(30)}
      )
    `;
    const challenge = (codeHash: string, expiresAt: Date) => admin`
      insert into app.tracking_challenges (workspace_id, order_id, email_hash, code_hash, expires_at)
      values (${WORKSPACE}, ${ORDER}, 'synthetic-email-hash', ${codeHash}, ${expiresAt})
    `;
    await challenge('retention-old-code', daysAgo(10));
    await challenge('retention-live-code', daysAgo(-1));

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({ connectionString: runtimeUrl.toString(), ssl: false });
  });

  afterAll(async () => {
    await database?.close();
    await admin?.end();
  });

  test('deletes completed jobs older than 30 days in this workspace only', async () => {
    const result = await new DatabaseOperationalPruner(database).prune({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      now: NOW,
    });
    expect(result).toContainEqual({ tableName: 'outbox_jobs', deleted: 1 });
    // Passes the customer-erasure guard only inside the prune function.
    expect(result).toContainEqual({ tableName: 'tracking_challenges', deleted: 1 });
    const codes = await admin<{ code_hash: string }[]>`
      select code_hash from app.tracking_challenges where workspace_id = ${WORKSPACE}
    `;
    expect(codes.map((row) => row.code_hash)).toEqual(['retention-live-code']);
    expect(result.map((row) => row.tableName).sort()).toEqual(
      [
        'catalogue_sync_events',
        'email_provider_events',
        'outbox_job_alerts',
        'outbox_jobs',
        'quotes',
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

  test('the runtime role cannot switch the guard off by itself', async () => {
    await expect(
      database.withTenantTx({ workspaceId: WORKSPACE, actorId: ACTOR }, async (tx) => {
        await tx.execute(sql`select pg_catalog.set_config('app.operational_prune', 'on', true)`);
        await tx.execute(
          sql`delete from app.tracking_challenges where workspace_id = ${WORKSPACE}`,
        );
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ message: 'customer_erasure_requires_acknowledgement' }),
    });
  });
});
