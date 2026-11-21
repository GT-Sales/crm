import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

import {
  ABANDONED_LEAD_BATCH_SIZE,
  ABANDONED_LEAD_RETENTION_DAYS,
  DatabaseAbandonedLeadPruner,
} from '../src/retention/abandoned-leads.js';

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

const WORKSPACE = '11000000-0000-4000-8000-000000000e51';
const ACTOR = '21000000-0000-4000-8000-000000000e51';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';
const NOW = new Date('2026-11-14T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const LEFTOVERS = 5;

// Audit #107: a run that finds a full batch of newly due drafts and some
// older restricted leads still holding their contacts hands the erasure
// function more than its 1000-id limit; it used to roll back on every run.
databaseTest('abandoned lead retention with more than one erasure batch', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;

  const cleanUp = async () => {
    await admin`delete from app.workspaces where id = ${WORKSPACE}`;
    await admin`delete from app.contacts where email like 'bulk-erasure-%@example.test'`;
  };

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('missing migration URL');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    await cleanUp();
    await admin`
      insert into app.workspaces (id, slug, name)
      values (${WORKSPACE}, 'ci-erasure-batches', 'CI Erasure Batches')
    `;
    const total = ABANDONED_LEAD_BATCH_SIZE + LEFTOVERS;
    await admin`
      insert into app.contacts (id, email, full_name)
      select ('60000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
        'bulk-erasure-' || n || '@example.test', 'Bulk Visitor'
      from generate_series(1, ${total}::int) n
    `;
    const old = new Date(NOW.getTime() - (ABANDONED_LEAD_RETENTION_DAYS + 5) * DAY);
    // A full batch of newly due drafts...
    await admin`
      insert into app.leads (id, workspace_id, lead_type, status, consent_version, full_name, email,
        contact_id, updated_at)
      select ('61000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, ${WORKSPACE},
        'internet', 'incomplete', 'ci', 'Bulk Visitor', 'bulk@example.test',
        ('60000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, ${old}
      from generate_series(1, ${ABANDONED_LEAD_BATCH_SIZE}::int) n
    `;
    // ...and older restricted leads that still point at a contact.
    await admin`
      insert into app.leads (id, workspace_id, lead_type, status, consent_version,
        contact_id, customer_data_restricted_at, updated_at)
      select ('61000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, ${WORKSPACE},
        'internet', 'incomplete', 'ci',
        ('60000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, ${old}, ${old}
      from generate_series(${ABANDONED_LEAD_BATCH_SIZE + 1}::int, ${total}::int) n
    `;
    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({ connectionString: runtimeUrl.toString(), ssl: false });
  });

  afterAll(async () => {
    await cleanUp().catch(() => undefined);
    await database?.close();
    await admin?.end();
  });

  test('restricts the full batch and finishes the older leads in the same run', async () => {
    const result = await new DatabaseAbandonedLeadPruner(database).restrictAbandoned({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      now: NOW,
    });
    expect(result).toMatchObject({
      restrictedLeads: ABANDONED_LEAD_BATCH_SIZE,
      finishedLeads: LEFTOVERS,
    });

    const [after] = await admin<{ restricted: number; linked: number; contacts: number }[]>`
      select
        (select count(*)::int from app.leads
          where workspace_id = ${WORKSPACE} and customer_data_restricted_at is not null) as restricted,
        (select count(*)::int from app.leads
          where workspace_id = ${WORKSPACE} and contact_id is not null) as linked,
        (select count(*)::int from app.contacts
          where email like 'bulk-erasure-%@example.test') as contacts
    `;
    // Every lead restricted, none still linked, and the contacts no lead
    // references any more are gone, from both erasure batches.
    expect(after).toEqual({
      restricted: ABANDONED_LEAD_BATCH_SIZE + LEFTOVERS,
      linked: 0,
      contacts: 0,
    });
  });
});
