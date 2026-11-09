import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { STAFF_SEED_IDS } from '@gt-sales/db/seed';
import { LEGACY_IMPORT_ACTOR_ID } from '@gt-sales/contracts';

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

// The runbook's file as the owner applies it (the schedule is a comment there).
const SYNC_SQL = readFileSync(
  fileURLToPath(
    new URL('../../../docs/RUNBOOKS/manual/canadawide-intake-fallback.sql', import.meta.url),
  ),
  'utf8',
);

const CANADAWIDE = STAFF_SEED_IDS.canadaWideWorkspace;
// A distinct id range from every other integration test file sharing this database.
const FALLBACK_INTERNET = '15000000-0000-4000-8000-000000000f21';
const FALLBACK_MOBILITY = '15000000-0000-4000-8000-000000000f22';
const FROM_INTAKE = '15000000-0000-4000-8000-000000000f23';
const SAVED_BY_CRM = '15000000-0000-4000-8000-000000000f24';
const TIMED_OUT_COPY = '15000000-0000-4000-8000-000000000f25';
const TOO_FRESH = '15000000-0000-4000-8000-000000000f26';
const TOO_OLD = '15000000-0000-4000-8000-000000000f27';
const ALL = [
  FALLBACK_INTERNET,
  FALLBACK_MOBILITY,
  FROM_INTAKE,
  SAVED_BY_CRM,
  TIMED_OUT_COPY,
  TOO_FRESH,
  TOO_OLD,
];

/** What the website sends (lib/crm.ts crmLeadIdempotencyKey) and the CRM stores. */
const keyHash = (leadId: string) =>
  createHash('sha256').update(`cw-lead:${leadId}`, 'utf8').digest('hex');

databaseTest('CanadaWide intake fallback sync', () => {
  let admin: ReturnType<typeof postgres>;

  async function sync(): Promise<number> {
    const [row] = await admin<{ imported: number }[]>`
      select app.sync_canadawide_fallback() as imported
    `;
    return row!.imported;
  }

  async function lead(id: string) {
    const [row] = await admin<
      {
        workspace_id: string;
        lead_type: string;
        status: string;
        stage: string;
        email: string;
        contact_id: string | null;
        payload: { schemaVersion: number; payload: Record<string, unknown> };
        consent_version: string;
        created_at: Date;
        updated_at: Date;
      }[]
    >`select * from app.leads where id = ${id}`;
    return row;
  }

  async function audits(): Promise<number> {
    const [row] = await admin<{ n: number }[]>`
      select count(*)::int as n from app.audit_events
      where entity_id in ${admin(ALL)} and actor_label = 'intake fallback sync'
    `;
    return row!.n;
  }

  /** Everything the sync could touch, for a before/after comparison. */
  async function fingerprint(): Promise<string> {
    const [row] = await admin<{ f: string }[]>`
      select md5(coalesce(string_agg(
        l.id::text || l.stage || l.consent_version || l.updated_at::text || coalesce(l.contact_id::text, ''),
        ',' order by l.id), '')) as f
      from app.leads l where l.id in ${admin(ALL)}
    `;
    return row!.f;
  }

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await claimLegacyTables(admin);
    await admin`
      insert into app.workspaces (id, slug, name, domain)
      values (${CANADAWIDE}, 'canadawide', 'CanadaWide', 'canadawideinternet.com')
      on conflict do nothing
    `;
    // Earlier runs: the cascade clears their idempotency keys too.
    await admin`delete from app.leads where id in ${admin(ALL)}`;
    await admin.unsafe(SYNC_SQL);

    // Two leads the website kept while the CRM was down, ten minutes ago.
    await admin`
      insert into public.internet_leads (
        id, created_at, plan, plan_id, landing_city, date_of_birth, email, phone, street_address,
        city, postal_code, consent, consented_at, full_name
      ) values
        (${FALLBACK_INTERNET}, now() - interval '10 minutes', '1Gbps', 'sk-1000', 'saskatchewan',
         '1990-05-15', 'Dana.Fallback@Example.test', '(306) 555-0141', '1 Fallback St', 'Saskatoon',
         'S7K 1A1', true, now() - interval '10 minutes', 'Dana Fallback'),
        -- The CRM saved this one but the website gave up waiting and kept a copy.
        (${TIMED_OUT_COPY}, now() - interval '10 minutes', '1Gbps', 'sk-1000', null,
         '1985-01-02', 'erin.fallback@example.test', '(306) 555-0142', '2 Fallback St',
         'Regina', null, true, now() - interval '10 minutes', 'Erin Fallback'),
        -- Still inside the minimum age: an intake commit could still be landing.
        (${TOO_FRESH}, now(), '1Gbps', 'sk-1000', null, '1985-01-02', 'fran.fallback@example.test',
         '(306) 555-0143', '3 Fallback St', 'Regina', null, true, now(), 'Fran Fallback'),
        -- Older than the window (and than the CRM's idempotency keys).
        (${TOO_OLD}, now() - interval '10 days', '1Gbps', 'sk-1000', null, '1985-01-02',
         'gale.fallback@example.test', '(306) 555-0144', '4 Fallback St', 'Regina', null, true,
         now() - interval '10 days', 'Gale Fallback')
    `;
    await admin`
      insert into public.mobility_leads (
        id, created_at, full_name, first_name, last_name, email, phone, keep_number, sim_type,
        street_address, city, postal_code, plan_id, line_count, current_provider
      ) values (
        ${FALLBACK_MOBILITY}, now() - interval '9 minutes', 'Hana Fallback', 'Hana', 'Fallback',
        'hana.fallback@example.test', '(306) 555-0145', true, 'esim', '5 Fallback St',
        'Saskatoon', 'S7K 1A2', '150 GB $45', 2, 'Rogers'
      )
    `;

    // A lead the CRM's intake saved: the 0002 mirror writes its legacy row.
    // And the CRM's own copy of TIMED_OUT_COPY, under the CRM's id, with the
    // website's key `cw-lead:<TIMED_OUT_COPY>` beside it.
    await admin`
      insert into app.leads (
        id, workspace_id, lead_type, status, stage, full_name, email, phone, country_code,
        payload, attribution, consent_version, created_at, updated_at
      ) values
        (${FROM_INTAKE}, ${CANADAWIDE}, 'internet', 'submitted', 'new', 'Ivy Intake',
         'ivy.intake@example.test', '(306) 555-0146', 'CA',
         ${admin.json({
           schemaVersion: 1,
           payload: {
             planId: 'sk-1000',
             planLabel: '1Gbps',
             dateOfBirth: '1980-03-04',
             streetAddress: '6 Intake St',
             city: 'Saskatoon',
             consent: true,
           },
         })},
         '{}'::jsonb, 'cw-internet-contact-2026-10', now() - interval '8 minutes',
         now() - interval '8 minutes'),
        (${SAVED_BY_CRM}, ${CANADAWIDE}, 'internet', 'submitted', 'new', 'Erin Fallback',
         'erin.fallback@example.test', '(306) 555-0142', 'CA',
         ${admin.json({
           schemaVersion: 1,
           payload: {
             planId: 'sk-1000',
             planLabel: '1Gbps',
             dateOfBirth: '1985-01-02',
             streetAddress: '2 Fallback St',
             city: 'Regina',
             consent: true,
           },
         })},
         '{}'::jsonb, 'cw-internet-contact-2026-10', now() - interval '10 minutes',
         now() - interval '10 minutes')
    `;
    await admin`
      insert into app.idempotency_keys (
        workspace_id, scope, key_hash, request_fingerprint, lead_id, status, completed_at
      ) values (
        ${CANADAWIDE}, 'lead_submission', ${keyHash(TIMED_OUT_COPY)}, ${`sha256:${'0'.repeat(64)}`},
        ${SAVED_BY_CRM}, 'completed', now()
      )
    `;
  }, 120_000); // long enough to wait for another suite to release the legacy tables

  afterAll(async () => {
    await admin`delete from app.leads where id in ${admin(ALL)}`;
    await admin`
      delete from app.contacts where email in (
        'dana.fallback@example.test', 'erin.fallback@example.test', 'hana.fallback@example.test'
      ) and not exists (select 1 from app.leads l where l.contact_id = app.contacts.id)
    `;
    await releaseLegacyTables(admin);
    await admin.end();
  });

  test('imports each fallback row once, under its own id, and leaves CRM leads alone', async () => {
    const auditsBefore = await audits();
    const intakeBefore = await lead(FROM_INTAKE);
    const savedBefore = await lead(SAVED_BY_CRM);

    expect(await sync()).toBe(2);

    const internet = await lead(FALLBACK_INTERNET);
    expect(internet).toMatchObject({
      workspace_id: CANADAWIDE,
      lead_type: 'internet',
      status: 'submitted',
      stage: 'new',
      email: 'Dana.Fallback@Example.test',
      consent_version: 'cw-intake-fallback',
    });
    expect(internet!.payload).toEqual({
      schemaVersion: 1,
      payload: {
        planId: 'sk-1000',
        planLabel: '1Gbps',
        landingCity: 'saskatchewan',
        dateOfBirth: '1990-05-15',
        streetAddress: '1 Fallback St',
        city: 'Saskatoon',
        postalCode: 'S7K 1A1',
        consent: true,
        consentedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      },
    });
    const [contact] = await admin<{ email: string; full_name: string }[]>`
      select email, full_name from app.contacts where id = ${internet!.contact_id}
    `;
    expect(contact).toEqual({ email: 'dana.fallback@example.test', full_name: 'Dana Fallback' });

    const mobility = await lead(FALLBACK_MOBILITY);
    expect(mobility).toMatchObject({
      lead_type: 'mobility',
      consent_version: 'cw-intake-fallback',
    });
    expect(mobility!.payload.payload).toMatchObject({
      planLabel: '150 GB $45',
      lineCount: 2,
      firstName: 'Hana',
      keepNumber: true,
      simType: 'esim',
    });

    // One audit event each, by the old admin's actor.
    expect((await audits()) - auditsBefore).toBe(2);
    const [audit] = await admin<{ actor_id: string; action: string; after: unknown }[]>`
      select actor_id, action, after from app.audit_events
      where entity_id = ${FALLBACK_INTERNET} and actor_label = 'intake fallback sync'
    `;
    expect(audit).toMatchObject({ actor_id: LEGACY_IMPORT_ACTOR_ID, action: 'lead.created' });

    // No timeline entry: the lead stays New, like one from the intake.
    const [activities] = await admin<{ n: number }[]>`
      select count(*)::int as n from app.lead_activities
      where lead_id in (${FALLBACK_INTERNET}, ${FALLBACK_MOBILITY})
    `;
    expect(activities!.n).toBe(0);

    // Not imported: the CRM's copy exists (by key), too fresh, too old.
    expect(await lead(TIMED_OUT_COPY)).toBeUndefined();
    expect(await lead(TOO_FRESH)).toBeUndefined();
    expect(await lead(TOO_OLD)).toBeUndefined();

    // The CRM's own leads are untouched.
    expect(await lead(FROM_INTAKE)).toEqual(intakeBefore);
    expect(await lead(SAVED_BY_CRM)).toEqual(savedBefore);

    // The 0002 mirror met the existing legacy rows and added nothing.
    const [legacy] = await admin<{ internet: number; mobility: number }[]>`
      select
        (select count(*)::int from public.internet_leads) as internet,
        (select count(*)::int from public.mobility_leads) as mobility
    `;
    expect(legacy).toEqual({ internet: 6, mobility: 1 });
  });

  test('a second run is a no-op', async () => {
    const before = await fingerprint();
    const auditsBefore = await audits();
    const [contactsBefore] = await admin<
      { n: number }[]
    >`select count(*)::int as n from app.contacts`;

    expect(await sync()).toBe(0);

    expect(await fingerprint()).toBe(before);
    expect(await audits()).toBe(auditsBefore);
    const [contactsAfter] = await admin<
      { n: number }[]
    >`select count(*)::int as n from app.contacts`;
    expect(contactsAfter).toEqual(contactsBefore);
  });

  test('a fallback row past its minimum age is picked up on a later run', async () => {
    await admin`update public.internet_leads set created_at = now() - interval '3 minutes' where id = ${TOO_FRESH}`;
    expect(await sync()).toBe(1);
    expect((await lead(TOO_FRESH))?.consent_version).toBe('cw-intake-fallback');
    expect(await sync()).toBe(0);
  });

  test('refuses a window the idempotency keys do not cover', async () => {
    await expect(admin`select app.sync_canadawide_fallback(7)`).rejects.toThrow(
      /p_days must be 1 to 6/,
    );
    await expect(admin`select app.sync_canadawide_fallback(0)`).rejects.toThrow(
      /p_days must be 1 to 6/,
    );
  });
});
