import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

import { DatabaseLeadWorkStore } from '../src/leads/work-store.js';

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

// A distinct id range from every other integration test file sharing this database.
const SITE = '16000000-0000-4000-8000-000000000a01';
const OTHER_SITE = '16000000-0000-4000-8000-000000000a02';
const ACTOR = '26000000-0000-4000-8000-000000000a01';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';

databaseTest('the dashboard counts (leads/stats)', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let work: DatabaseLeadWorkStore;

  /** A lead `daysAgo` days old; the defaults make a live SIM order. */
  const lead = async (
    workspaceId: string,
    daysAgo: number,
    options: {
      stage?: string;
      partnerCode?: string;
      leadType?: string;
      trashed?: boolean;
      restricted?: boolean;
      externalRef?: string;
      company?: string;
    } = {},
  ) => {
    await admin`
      insert into app.leads (
        workspace_id, lead_type, status, stage, consent_version, attribution, external_ref,
        payload, deleted_at, customer_data_restricted_at, created_at, updated_at
      ) values (
        ${workspaceId}, ${options.leadType ?? 'sim_order'}, 'submitted', ${options.stage ?? 'pending'},
        'ci', ${admin.json(options.partnerCode ? { partnerCode: options.partnerCode } : {})},
        ${options.externalRef ?? null},
        ${options.company ? admin.json({ schemaVersion: 1, payload: { company: options.company } }) : null},
        ${options.trashed ? new Date() : null}, ${options.restricted ? new Date() : null},
        now() - make_interval(days => ${daysAgo}), now() - make_interval(days => ${daysAgo})
      )
    `;
  };

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    for (const [id, slug] of [
      [SITE, 'stats-a01'],
      [OTHER_SITE, 'stats-a02'],
    ] as const) {
      await admin`
        insert into app.workspaces (id, slug, name) values (${id}, ${slug}, ${slug})
        on conflict (id) do nothing
      `;
    }
    await admin`delete from app.leads where workspace_id in (${SITE}, ${OTHER_SITE})`;

    // This week: two pending through partner PT-7, one cancelled through it,
    // one completed without a partner, one through a code no application has.
    await lead(SITE, 1, { partnerCode: 'PT-7' });
    await lead(SITE, 2, { partnerCode: 'PT-7', stage: 'verified' });
    await lead(SITE, 2, { partnerCode: 'PT-7', stage: 'cancelled' });
    await lead(SITE, 3, { stage: 'completed' });
    await lead(SITE, 3, { partnerCode: 'MAPLE10' });
    // Earlier: 20 and 60 days ago.
    await lead(SITE, 20, { stage: 'completed', partnerCode: 'PT-7' });
    await lead(SITE, 60, { stage: 'incomplete' });
    // Never counted: trashed, restricted, another type, another site.
    await lead(SITE, 1, { trashed: true });
    await lead(SITE, 1, { restricted: true });
    await lead(SITE, 1, { leadType: 'internet', stage: 'new' });
    await lead(OTHER_SITE, 1);
    // The partner application that names PT-7.
    await lead(SITE, 100, {
      leadType: 'partner_application',
      stage: 'approved',
      externalRef: 'PT-7',
      company: 'Maple Study Abroad',
    });

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({ connectionString: runtimeUrl.toString(), ssl: false });
    work = new DatabaseLeadWorkStore(database);
  });

  afterAll(async () => {
    await database?.close();
    await admin?.end();
  });

  const stats = (days?: number) =>
    work.stats({ workspaceId: SITE, actorId: ACTOR, leadType: 'sim_order', days });

  test('counts the window by stage, per day and by partner, cancellations aside', async () => {
    const week = await stats(7);
    expect(week.total).toBe(5);
    expect(week.stages).toEqual([
      { stage: 'cancelled', total: 1 },
      { stage: 'completed', total: 1 },
      { stage: 'pending', total: 2 },
      { stage: 'verified', total: 1 },
    ]);
    // The cancelled order is in the total, not in the volume or the partners.
    expect(week.daily.reduce((sum, day) => sum + day.total, 0)).toBe(4);
    expect(week.daily.map((day) => day.day)).toEqual([...week.daily.map((d) => d.day)].sort());
    expect(week.partners).toEqual([
      { code: 'PT-7', name: 'Maple Study Abroad', total: 2 },
      { code: 'MAPLE10', name: null, total: 1 },
    ]);
  });

  test('widens with the window, and all time takes everything live', async () => {
    expect((await stats(30)).total).toBe(6);
    const ever = await stats();
    expect(ever.total).toBe(7);
    expect(ever.partners[0]).toEqual({ code: 'PT-7', name: 'Maple Study Abroad', total: 3 });
  });

  test('a type without outcomes counts every stage everywhere', async () => {
    const internet = await work.stats({
      workspaceId: SITE,
      actorId: ACTOR,
      leadType: 'internet',
    });
    expect(internet).toMatchObject({ total: 1, stages: [{ stage: 'new', total: 1 }] });
    expect(internet.daily).toHaveLength(1);
  });
});
