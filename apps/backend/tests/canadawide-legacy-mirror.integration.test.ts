import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';

import { DatabaseLeadStore } from '../src/leads/store.js';
import { claimLegacyTables, releaseLegacyTables } from './support/legacy-canadawide.js';

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
const CANADAWIDE_CANDIDATE = '12000000-0000-4000-8000-000000000c01';
const OTHER_WORKSPACE = '12000000-0000-4000-8000-000000000c02';
const ACTOR = '22000000-0000-4000-8000-000000000c01';
const REQUEST_ID = '32000000-0000-4000-8000-000000000c01';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';

const contact = {
  fullName: 'Avery Example',
  email: 'avery.mirror@example.test',
  phone: '403 555 0101',
  countryCode: 'CA',
};

const internetPayload = {
  planId: 'ab-1gbps',
  planLabel: '1Gbps',
  landingCity: 'calgary',
  dateOfBirth: '1990-04-12',
  streetAddress: '12 Example Street',
  city: 'Calgary',
  postalCode: 'T2P 1J9',
  currentProvider: 'Shaw',
  consent: true,
  consentedAt: '2026-10-26T10:00:00.000Z',
};

const mobilityPayload = {
  planId: 'cw-100gb',
  planLabel: '100 GB $40',
  lineCount: 2,
  firstName: 'Avery',
  lastName: 'Example',
  keepNumber: true,
  simType: 'esim',
  currentProvider: 'Rogers',
  streetAddress: '12 Example Street',
  aptUnit: '4B',
  city: 'Calgary',
  postalCode: 'T2P 1J9',
};

databaseTest('CanadaWide legacy mirror (migration 0002)', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let store: DatabaseLeadStore;
  let canadawide: string;

  const lead = (workspaceId: string, leadType: string, payload: Record<string, unknown>) =>
    store.createLead({
      workspaceId,
      actorId: ACTOR,
      requestId: REQUEST_ID,
      leadType,
      contact,
      form: { schemaVersion: 1, payload },
      consentVersion: 'cw-internet-v1',
      submit: true,
    });

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    await claimLegacyTables(admin);
    // `canadawide` may already exist in a reused database; the mirror keys on the slug.
    await admin`
      insert into app.workspaces (id, slug, name)
      values (${CANADAWIDE_CANDIDATE}, 'canadawide', 'CanadaWide'),
             (${OTHER_WORKSPACE}, 'ci-mirror-other', 'CI Mirror Other')
      on conflict do nothing
    `;
    const [row] = await admin<{ id: string }[]>`
      select id from app.workspaces where slug = 'canadawide'
    `;
    if (!row) throw new Error('expected the canadawide workspace');
    canadawide = row.id;

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      maxConnections: 1,
      ssl: false,
    });
    store = new DatabaseLeadStore(database);
  }, 120_000); // long enough to wait for the import suite to release the legacy tables

  afterAll(async () => {
    await database.close();
    await releaseLegacyTables(admin);
    await admin.end();
  });

  test('copies a CanadaWide internet lead into internet_leads under the same id', async () => {
    const created = await lead(canadawide, 'internet', internetPayload);
    const [row] = await admin`
      select plan, plan_id, landing_city, full_name, date_of_birth::text as dob, email, phone,
             street_address, apt_unit, city, postal_code, current_provider, consent,
             consented_at, status, created_at = (select created_at from app.leads where id = ${created.lead.id}) as same_time
      from public.internet_leads where id = ${created.lead.id}
    `;
    expect(row).toMatchObject({
      plan: '1Gbps',
      plan_id: 'ab-1gbps',
      landing_city: 'calgary',
      full_name: 'Avery Example',
      dob: '1990-04-12',
      email: 'avery.mirror@example.test',
      phone: '403 555 0101',
      street_address: '12 Example Street',
      apt_unit: null,
      city: 'Calgary',
      postal_code: 'T2P 1J9',
      current_provider: 'Shaw',
      consent: true,
      status: 'new',
      same_time: true,
    });
    expect(new Date(String(row?.consented_at)).toISOString()).toBe('2026-10-26T10:00:00.000Z');
  });

  test('copies a CanadaWide mobility lead into mobility_leads, plan label included', async () => {
    const created = await lead(canadawide, 'mobility', mobilityPayload);
    const [row] = await admin`
      select plan_id, line_count, full_name, first_name, last_name, keep_number, sim_type,
             current_provider, street_address, apt_unit, city, postal_code, status
      from public.mobility_leads where id = ${created.lead.id}
    `;
    expect(row).toEqual({
      plan_id: '100 GB $40',
      line_count: 2,
      full_name: 'Avery Example',
      first_name: 'Avery',
      last_name: 'Example',
      keep_number: true,
      sim_type: 'esim',
      current_provider: 'Rogers',
      street_address: '12 Example Street',
      apt_unit: '4B',
      city: 'Calgary',
      postal_code: 'T2P 1J9',
      status: 'new',
    });
  });

  test('leaves other sites and other lead types alone', async () => {
    const otherSite = await lead(OTHER_WORKSPACE, 'internet', internetPayload);
    const otherType = await store.createLead({
      workspaceId: canadawide,
      actorId: ACTOR,
      requestId: REQUEST_ID,
      leadType: 'sim_order',
      consentVersion: 'terms-2026-09',
    });
    const rows = await admin`
      select id from public.internet_leads where id in (${otherSite.lead.id}, ${otherType.lead.id})
      union all
      select id from public.mobility_leads where id in (${otherSite.lead.id}, ${otherType.lead.id})
    `;
    expect(rows).toHaveLength(0);
  });

  test('lets a historical legacy row be imported under its own id without a duplicate', async () => {
    const [legacy] = await admin<{ id: string }[]>`
      insert into public.internet_leads (plan, date_of_birth, email, phone, street_address, city, full_name, status)
      values ('Legacy plan', '1985-01-02', 'legacy@example.test', '403 555 0199', '1 Old Road', 'Edmonton', 'Legacy Customer', 'contacted')
      returning id
    `;
    if (!legacy) throw new Error('expected a legacy row');
    await admin`
      insert into app.leads (id, workspace_id, lead_type, status, full_name, email, phone, payload, consent_version)
      values (${legacy.id}, ${canadawide}, 'internet', 'submitted', 'Legacy Customer',
              'legacy@example.test', '403 555 0199',
              ${admin.json({ schemaVersion: 1, payload: { ...internetPayload, planLabel: 'Imported' } })},
              'legacy-import')
    `;
    const rows = await admin<{ plan: string; status: string }[]>`
      select plan, status from public.internet_leads where id = ${legacy.id}
    `;
    expect(rows).toEqual([{ plan: 'Legacy plan', status: 'contacted' }]);
  });

  test('is a no-op where the legacy tables do not exist', async () => {
    await admin`drop table if exists public.mobility_id_uploads, public.internet_leads, public.mobility_leads`;
    await expect(lead(canadawide, 'internet', internetPayload)).resolves.toMatchObject({
      lead: { status: 'submitted' },
    });
    await expect(lead(canadawide, 'mobility', mobilityPayload)).resolves.toMatchObject({
      lead: { status: 'submitted' },
    });
  });
});
