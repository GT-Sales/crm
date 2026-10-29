import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

import {
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

const WORKSPACE = '11000000-0000-4000-8000-000000000e41';
const ACTOR = '21000000-0000-4000-8000-000000000e41';
const ABANDONED = '41000000-0000-4000-8000-000000000e41';
const RECENT = '41000000-0000-4000-8000-000000000e42';
const SUBMITTED = '41000000-0000-4000-8000-000000000e43';
const NOW = new Date('2026-10-29T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';

interface LeadRow {
  id: string;
  fullName: string | null;
  email: string | null;
  payload: unknown;
  customValues: unknown;
  restricted: boolean;
}

// SEC-12: an incomplete lead untouched for 90 days loses every visitor answer,
// custom property values included; newer and submitted leads keep theirs.
databaseTest('abandoned lead retention (restrictAbandoned)', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;

  const insertLead = (id: string, status: string, updatedAt: Date) => admin`
    insert into app.leads (
      id, workspace_id, lead_type, status, consent_version, attribution, full_name, email,
      payload, custom_values, updated_at
    ) values (
      ${id}, ${WORKSPACE}, 'internet', ${status}, 'ci', '{}'::jsonb, 'Ada Visitor',
      'ada@example.test', ${admin.json({ schemaVersion: 1, payload: { city: 'Calgary' } })},
      ${admin.json({ custom_referral_code: 'REF-1', custom_budget: 4500 })}, ${updatedAt}
    )
  `;

  const rows = () => admin<LeadRow[]>`
    select id, full_name as "fullName", email, payload, custom_values as "customValues",
      customer_data_restricted_at is not null as restricted
    from app.leads where workspace_id = ${WORKSPACE} order by id
  `;

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('missing migration URL');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    await admin`delete from app.workspaces where id = ${WORKSPACE}`;
    await admin`
      insert into app.workspaces (id, slug, name)
      values (${WORKSPACE}, 'ci-abandoned-retention', 'CI Abandoned Retention')
    `;
    await insertLead(ABANDONED, 'incomplete', daysAgo(ABANDONED_LEAD_RETENTION_DAYS + 1));
    await insertLead(RECENT, 'incomplete', daysAgo(ABANDONED_LEAD_RETENTION_DAYS - 1));
    await insertLead(SUBMITTED, 'submitted', daysAgo(ABANDONED_LEAD_RETENTION_DAYS + 30));

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({ connectionString: runtimeUrl.toString(), ssl: false });
  });

  afterAll(async () => {
    if (admin) await admin`delete from app.workspaces where id = ${WORKSPACE}`;
    await database?.close();
    await admin?.end();
  });

  test('erases the custom values of an abandoned draft with its answers', async () => {
    const result = await new DatabaseAbandonedLeadPruner(database).restrictAbandoned({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      now: NOW,
    });
    expect(result).toEqual({ restrictedLeads: 1 });

    const kept = { custom_referral_code: 'REF-1', custom_budget: 4500 };
    expect(await rows()).toEqual([
      {
        id: ABANDONED,
        fullName: null,
        email: null,
        payload: null,
        customValues: {},
        restricted: true,
      },
      {
        id: RECENT,
        fullName: 'Ada Visitor',
        email: 'ada@example.test',
        payload: { schemaVersion: 1, payload: { city: 'Calgary' } },
        customValues: kept,
        restricted: false,
      },
      {
        id: SUBMITTED,
        fullName: 'Ada Visitor',
        email: 'ada@example.test',
        payload: { schemaVersion: 1, payload: { city: 'Calgary' } },
        customValues: kept,
        restricted: false,
      },
    ]);

    const [empty] = await admin<{ empty: boolean }[]>`
      select custom_values = '{}'::jsonb as empty from app.leads where id = ${ABANDONED}
    `;
    expect(empty).toEqual({ empty: true });
  });
});
