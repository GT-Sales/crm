import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { attributionSchema, sourceReportRowSchema } from '@gt-sales/contracts';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';
import { z } from 'zod';

import { deriveSource } from '../src/leads/source.js';
import { DatabaseLeadWorkStore } from '../src/leads/work-store.js';
import { DatabaseReportStore, sourceLabelSql } from '../src/reports/store.js';

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
const SITE = '16000000-0000-4000-8000-00000000f601';
const OTHER_SITE = '16000000-0000-4000-8000-00000000f602';
const EDGE_SITE = '16000000-0000-4000-8000-00000000f603';
const ACTOR = '26000000-0000-4000-8000-00000000f601';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';

const ODD_SOURCE = '\'"<b>x</b> %_\\'.padEnd(120, 'z');
const LONG_MEDIUM = 'm'.repeat(120);
const LONG_HOST = `${'h'.repeat(249)}.com`;

databaseTest('the source report (reports/sources)', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let reports: DatabaseReportStore;
  let work: DatabaseLeadWorkStore;

  /** A lead `daysAgo` days old; the defaults make a new, submitted internet lead. */
  const lead = async (
    workspaceId: string,
    daysAgo: number,
    attribution: Record<string, unknown>,
    options: {
      stage?: string;
      status?: string;
      leadType?: string;
      archived?: boolean;
      restricted?: boolean;
    } = {},
  ) => {
    await admin`
      insert into app.leads (
        workspace_id, lead_type, status, stage, consent_version, attribution,
        deleted_at, customer_data_restricted_at, created_at, updated_at
      ) values (
        ${workspaceId}, ${options.leadType ?? 'internet'}, ${options.status ?? 'submitted'},
        ${options.stage ?? 'new'}, 'ci', ${admin.json(JSON.parse(JSON.stringify(attribution)))},
        ${options.archived ? new Date() : null}, ${options.restricted ? new Date() : null},
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
      [SITE, 'report-f601'],
      [OTHER_SITE, 'report-f602'],
      [EDGE_SITE, 'report-f603'],
    ] as const) {
      await admin`
        insert into app.workspaces (id, slug, name) values (${id}, ${slug}, ${slug})
        on conflict (id) do nothing
      `;
    }
    await admin`delete from app.leads where workspace_id in (${SITE}, ${OTHER_SITE}, ${EDGE_SITE})`;

    await lead(SITE, 1, { partnerCode: 'PT-7', partnerCodeMatched: true }, { stage: 'won' });
    await lead(SITE, 1, { partnerCode: 'PT-7' });
    await lead(
      SITE,
      2,
      { utmSource: 'google', utmMedium: 'cpc', utmCampaign: 'fall' },
      { stage: 'installed' },
    );
    await lead(SITE, 2, { utmSource: 'google', utmMedium: 'cpc' }, { status: 'incomplete' });
    await lead(SITE, 20, { utmSource: 'newsletter' }, { stage: 'contacted' });
    await lead(SITE, 60, { referrerHost: 'facebook.com' }, { stage: 'lost' });
    await lead(SITE, 3, {});
    await lead(SITE, 3, { landingPath: '/plans' });
    // Never counted in the internet report.
    await lead(SITE, 1, { utmSource: 'google', utmMedium: 'cpc' }, { archived: true });
    await lead(SITE, 1, { utmSource: 'google', utmMedium: 'cpc' }, { restricted: true });
    await lead(SITE, 1, { utmSource: 'google' }, { leadType: 'sim_order', stage: 'pending' });
    await lead(OTHER_SITE, 1, { utmSource: 'google', utmMedium: 'cpc' });

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({ connectionString: runtimeUrl.toString(), ssl: false });
    reports = new DatabaseReportStore(database);
    work = new DatabaseLeadWorkStore(database);
  });

  afterAll(async () => {
    await admin?.end();
    await database?.close();
  });

  const report = (workspaceId: string, days?: number, leadType = 'internet') =>
    reports.sourceReport({ workspaceId, actorId: ACTOR, leadType, days });

  const counts = (received: number, submitted: number, madeIt: number) => ({
    received,
    submitted,
    madeIt,
  });

  test('counts per source over all time', async () => {
    const result = await report(SITE);
    expect(result.totals).toEqual(counts(8, 7, 2));
    expect(result.withSourceData).toBe(7);
    const bySource = new Map(result.rows.map((row) => [row.source, row]));
    expect(bySource.get('partner:PT-7')).toEqual({
      source: 'partner:PT-7',
      kind: 'partner',
      ...counts(1, 1, 1),
      campaigns: [],
    });
    expect(bySource.get('partner:PT-7 (unmatched)')).toEqual({
      source: 'partner:PT-7 (unmatched)',
      kind: 'partner',
      ...counts(1, 1, 0),
      campaigns: [],
    });
    expect(bySource.get('utm:google/cpc')).toEqual({
      source: 'utm:google/cpc',
      kind: 'utm',
      ...counts(2, 1, 1),
      campaigns: [
        { campaign: 'fall', other: false, ...counts(1, 1, 1) },
        { campaign: null, other: false, ...counts(1, 0, 0) },
      ],
    });
    expect(bySource.get('utm:newsletter')).toEqual({
      source: 'utm:newsletter',
      kind: 'utm',
      ...counts(1, 1, 0),
      campaigns: [{ campaign: null, other: false, ...counts(1, 1, 0) }],
    });
    expect(bySource.get('referrer:facebook.com')).toEqual({
      source: 'referrer:facebook.com',
      kind: 'referrer',
      ...counts(1, 1, 0),
      campaigns: [],
    });
    expect(bySource.get('direct')).toEqual({
      source: 'direct',
      kind: 'direct',
      ...counts(2, 2, 0),
      campaigns: [],
    });
    expect(result.rows).toHaveLength(6);
    // The busiest first.
    expect(result.rows.map((row) => row.received)).toEqual([2, 2, 1, 1, 1, 1]);
  });

  test('the windows', async () => {
    expect((await report(SITE, 7)).totals.received).toBe(6);
    expect((await report(SITE, 30)).totals.received).toBe(7);
    expect((await report(SITE, 90)).totals.received).toBe(8);
  });

  test("totals match the dashboard's stats for every window", async () => {
    for (const days of [undefined, 7, 30, 90]) {
      const stats = await work.stats({
        workspaceId: SITE,
        actorId: ACTOR,
        leadType: 'internet',
        days,
      });
      expect((await report(SITE, days)).totals.received, String(days)).toBe(stats.total);
    }
  });

  test("another site's leads, other types, archived and restricted leads are never counted", async () => {
    const other = await report(OTHER_SITE);
    expect(other.totals).toEqual(counts(1, 1, 0));
    expect(other.rows).toEqual([
      {
        source: 'utm:google/cpc',
        kind: 'utm',
        ...counts(1, 1, 0),
        campaigns: [{ campaign: null, other: false, ...counts(1, 1, 0) }],
      },
    ]);
    const simOrders = await report(SITE, undefined, 'sim_order');
    expect(simOrders.totals).toEqual(counts(1, 1, 0));
  });

  test('made it means activated, installed, completed or won', async () => {
    await admin`delete from app.leads where workspace_id = ${EDGE_SITE}`;
    for (const stage of ['activated', 'completed', 'delivered', 'cancelled']) {
      await lead(EDGE_SITE, 1, {}, { leadType: 'sim_order', stage });
    }
    const result = await report(EDGE_SITE, undefined, 'sim_order');
    expect(result.totals).toEqual(counts(4, 4, 2));
    expect(result.withSourceData).toBe(0);
    expect(result.rows).toEqual([
      { source: 'direct', kind: 'direct', ...counts(4, 4, 2), campaigns: [] },
    ]);
  });

  test("odd characters and the maximum length group under deriveSource's label", async () => {
    await admin`delete from app.leads where workspace_id = ${EDGE_SITE}`;
    const utm = { utmSource: ODD_SOURCE, utmMedium: LONG_MEDIUM };
    const referrer = { referrerHost: LONG_HOST };
    await lead(EDGE_SITE, 1, utm);
    await lead(EDGE_SITE, 1, utm);
    await lead(EDGE_SITE, 1, referrer);
    const result = await report(EDGE_SITE);
    const utmLabel = deriveSource(attributionSchema.parse(utm));
    const referrerLabel = deriveSource(attributionSchema.parse(referrer));
    expect(utmLabel).toHaveLength(245);
    expect(referrerLabel).toHaveLength(262);
    expect(result.rows.map((row) => [row.source, row.received])).toEqual([
      [utmLabel, 2],
      [referrerLabel, 1],
    ]);
    for (const row of result.rows) expect(sourceReportRowSchema.parse(row)).toEqual(row);
  });

  test("the SQL label is deriveSource's", async () => {
    const cases: Record<string, unknown>[] = [
      {},
      { partnerCode: 'P' },
      { partnerCode: 'P', partnerCodeMatched: true },
      { partnerCode: 'P', partnerCodeMatched: false },
      { partnerCode: '', utmSource: 'g' },
      { utmSource: 'g' },
      { utmSource: 'g', utmMedium: '' },
      { utmSource: 'g', utmMedium: 'cpc', referrerHost: 'bing.com' },
      { referrerHost: 'bing.com' },
      { landingPath: '/' },
    ];
    for (const attribution of cases) {
      const rows = await database.withTenantTx({ workspaceId: EDGE_SITE, actorId: ACTOR }, (tx) =>
        tx.execute(
          sql`select ${sourceLabelSql(sql`${JSON.stringify(attribution)}::jsonb`)} as label`,
        ),
      );
      const [row] = z.array(z.object({ label: z.string() })).parse(rows);
      expect(row?.label, JSON.stringify(attribution)).toBe(
        deriveSource(attributionSchema.parse(attribution)),
      );
    }
  });

  test('the 50-source cap sums the rest into Other', async () => {
    await admin`delete from app.leads where workspace_id = ${EDGE_SITE}`;
    for (let index = 1; index <= 55; index += 1) {
      await lead(EDGE_SITE, 1, { utmSource: `s${String(index).padStart(2, '0')}` });
    }
    for (let index = 0; index < 4; index += 1) await lead(EDGE_SITE, 1, { utmSource: 's01' });
    const result = await report(EDGE_SITE);
    expect(result.totals.received).toBe(59);
    expect(result.rows).toHaveLength(51);
    expect(result.rows[0]).toMatchObject({ source: 'utm:s01', received: 5 });
    expect(result.rows[50]).toEqual({
      source: 'other',
      kind: 'other',
      ...counts(5, 5, 0),
      campaigns: [],
    });
  });
});
