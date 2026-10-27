import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import {
  LEGACY_IMPORT_ACTOR_ID,
  leadActivitySchema,
  leadDetailSchema,
  leadTaskSchema,
} from '@gt-sales/contracts';

import { DatabaseLeadWorkStore } from '../src/leads/work-store.js';
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

const IMPORT_SQL = readFileSync(
  fileURLToPath(new URL('../../../packages/db/sql/canadawide-legacy-import.sql', import.meta.url)),
  'utf8',
);

// A distinct id range from every other integration test file sharing this database.
const CANADAWIDE_CANDIDATE = '14000000-0000-4000-8000-000000000f01';
const WON = '14000000-0000-4000-8000-000000000f11';
const TRASHED = '14000000-0000-4000-8000-000000000f12';
const MOBILITY = '14000000-0000-4000-8000-000000000f13';
const SAME_PERSON = '14000000-0000-4000-8000-000000000f14';
const FROM_INTAKE = '14000000-0000-4000-8000-000000000f15';
const STAFF = '24000000-0000-4000-8000-000000000f01';
const LEADS = [WON, TRASHED, MOBILITY, SAME_PERSON, FROM_INTAKE];
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';

databaseTest('CanadaWide historical import', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let work: DatabaseLeadWorkStore;
  let canadawide: string;

  async function runImport() {
    const results = await admin.unsafe(IMPORT_SQL);
    return results;
  }

  async function leadRow(id: string) {
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
        deleted_at: Date | null;
        created_at: Date;
        updated_at: Date;
      }[]
    >`select * from app.leads where id = ${id}`;
    if (!row) throw new Error(`lead ${id} was not imported`);
    return row;
  }

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    await claimLegacyTables(admin);
    await admin`
      insert into app.workspaces (id, slug, name)
      values (${CANADAWIDE_CANDIDATE}, 'canadawide', 'CanadaWide')
      on conflict do nothing
    `;
    const [site] = await admin<
      { id: string }[]
    >`select id from app.workspaces where slug = 'canadawide'`;
    if (!site) throw new Error('expected the canadawide workspace');
    canadawide = site.id;
    // The cascade clears any earlier run's timeline and tasks for these leads.
    await admin`delete from app.leads where id in ${admin(LEADS)}`;

    await admin`
      insert into public.internet_leads (
        id, created_at, plan, plan_id, landing_city, date_of_birth, email, phone, street_address,
        apt_unit, city, postal_code, current_provider, consent, consented_at, status, notes,
        notes_updated_at, reminder_at, reminder_note, reminder_done_at, full_name,
        preferred_installation_time, deleted_at
      ) values
        (${WON}, '2026-03-02T15:00:00Z', '1Gbps + TV', 'ab-1gbps-tv', 'calgary', '1988-07-01',
         'Avery.Legacy@Example.test ', '403 555 0201', '1 Legacy Way', '', 'Calgary', 'T2P 1J9',
         'Shaw', true, '2026-03-02T15:00:00Z', 'won', '  Called twice, installed.  ',
         '2026-03-05T10:00:00Z', '2026-03-04', 'Confirm the install', '2026-03-04T18:30:00Z',
         'Avery Legacy', 'Weekday mornings', null),
        (${TRASHED}, '2026-04-10T09:00:00Z', '500Mbps', null, null, '1975-01-20',
         'blake.legacy@example.test', '403 555 0202', '2 Legacy Way', null, 'Airdrie', null,
         null, false, null, 'non_serviceable_address', null, null, '2026-11-02', null, null,
         'Blake Legacy', null, '2026-04-11T08:00:00Z'),
        (${SAME_PERSON}, '2026-05-01T12:00:00Z', '1Gbps', 'ab-1gbps', null, '1988-07-01',
         'avery.legacy@example.test', '403 555 0299', '1 Legacy Way', null, 'Calgary', null,
         null, true, '2026-05-01T12:00:00Z', 'new', null, null, null, null, null,
         'Avery L.', null, null)
    `;
    await admin`
      insert into public.mobility_leads (
        id, full_name, email, phone, keep_number, sim_type, street_address, city, postal_code,
        created_at, plan_id, line_count, status, notes, notes_updated_at, current_provider,
        apt_unit, first_name, last_name
      ) values (
        ${MOBILITY}, 'Casey Legacy', 'casey.legacy@example.test', '780 555 0203', true, 'esim',
        '3 Legacy Way', 'Edmonton', 'T5J 0N3', '2026-06-15T16:00:00Z', '100 GB $40', 2,
        'contacted', 'Wants two lines.', '2026-06-16T09:00:00Z', 'Rogers', '12', 'Casey', 'Legacy'
      )
    `;

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      maxConnections: 1,
      ssl: false,
    });
    work = new DatabaseLeadWorkStore(database);
  }, 120_000); // long enough to wait for the mirror suite to release the legacy tables

  afterAll(async () => {
    await database?.close();
    await admin`delete from app.leads where id in ${admin(LEADS)}`;
    await releaseLegacyTables(admin);
    await admin.end();
  });

  test('every legacy row becomes a submitted CanadaWide lead under its own id', async () => {
    await runImport();

    const won = await leadRow(WON);
    expect(won).toMatchObject({
      workspace_id: canadawide,
      lead_type: 'internet',
      status: 'submitted',
      stage: 'won',
      email: 'Avery.Legacy@Example.test',
      consent_version: 'cw-legacy-import',
      deleted_at: null,
    });
    expect(won.created_at.toISOString()).toBe('2026-03-02T15:00:00.000Z');
    // Last activity is the note's time, not the import's.
    expect(won.updated_at.toISOString()).toBe('2026-03-05T10:00:00.000Z');
    expect(won.payload).toEqual({
      schemaVersion: 1,
      payload: {
        planId: 'ab-1gbps-tv',
        planLabel: '1Gbps + TV',
        landingCity: 'calgary',
        dateOfBirth: '1988-07-01',
        streetAddress: '1 Legacy Way',
        city: 'Calgary',
        postalCode: 'T2P 1J9',
        currentProvider: 'Shaw',
        preferredInstallationTime: 'Weekday mornings',
        consent: true,
        consentedAt: '2026-03-02T15:00:00.000Z',
      },
    });

    const trashed = await leadRow(TRASHED);
    expect(trashed.stage).toBe('non_serviceable_address');
    expect(trashed.deleted_at?.toISOString()).toBe('2026-04-11T08:00:00.000Z');

    const mobility = await leadRow(MOBILITY);
    expect(mobility).toMatchObject({ lead_type: 'mobility', stage: 'contacted' });
    expect(mobility.payload.payload).toEqual({
      planLabel: '100 GB $40',
      lineCount: 2,
      firstName: 'Casey',
      lastName: 'Legacy',
      keepNumber: true,
      simType: 'esim',
      currentProvider: 'Rogers',
      streetAddress: '3 Legacy Way',
      aptUnit: '12',
      city: 'Edmonton',
      postalCode: 'T5J 0N3',
    });
  });

  test('one person with two leads becomes one contact, named from the latest lead', async () => {
    const won = await leadRow(WON);
    const again = await leadRow(SAME_PERSON);
    expect(won.contact_id).not.toBeNull();
    expect(again.contact_id).toBe(won.contact_id);
    const [contact] = await admin<{ email: string; full_name: string }[]>`
      select email, full_name from app.contacts where id = ${won.contact_id}
    `;
    expect(contact).toEqual({ email: 'avery.legacy@example.test', full_name: 'Avery L.' });
  });

  test('the note and the reminder arrive as a timeline entry and a task', async () => {
    const won = await work.getLead({
      workspaceId: canadawide,
      actorId: STAFF,
      leadId: WON,
      includeWork: true,
    });
    if (!won) throw new Error('expected the lead');
    expect(leadDetailSchema.safeParse(won.lead).success).toBe(true);
    // Worked in the old admin, which had no "New" badge: opened, so not New.
    expect(won.lead.isNew).toBe(false);
    expect(won.activities).toEqual([
      expect.objectContaining({
        kind: 'note',
        body: 'Called twice, installed.',
        actorId: LEGACY_IMPORT_ACTOR_ID,
        createdAt: '2026-03-05T10:00:00.000Z',
      }),
      expect.objectContaining({
        kind: 'system',
        event: 'opened',
        actorId: LEGACY_IMPORT_ACTOR_ID,
        createdAt: '2026-03-02T15:00:00.000Z',
      }),
    ]);
    expect(won.activities.every((entry) => leadActivitySchema.safeParse(entry).success)).toBe(true);
    expect(won.tasks).toEqual([
      expect.objectContaining({
        title: 'Confirm the install',
        dueAt: '2026-03-04T12:00:00.000Z',
        status: 'done',
        completedAt: '2026-03-04T18:30:00.000Z',
        createdBy: LEGACY_IMPORT_ACTOR_ID,
      }),
    ]);
    expect(won.tasks.every((task) => leadTaskSchema.safeParse(task).success)).toBe(true);

    const trashed = await work.getLead({
      workspaceId: canadawide,
      actorId: STAFF,
      leadId: TRASHED,
      includeWork: true,
    });
    // A reminder with no note still becomes a task.
    expect(trashed?.tasks).toEqual([
      expect.objectContaining({ title: 'Follow up', status: 'open', completedAt: null }),
    ]);
  });

  test('a second run changes nothing and writes nothing twice', async () => {
    const before = await admin<
      { leads: number; activities: number; tasks: number; legacy: number }[]
    >`
      select
        (select count(*)::int from app.leads where id in ${admin(LEADS)}) as leads,
        (select count(*)::int from app.lead_activities where lead_id in ${admin(LEADS)}) as activities,
        (select count(*)::int from app.lead_tasks where lead_id in ${admin(LEADS)}) as tasks,
        (select count(*)::int from public.internet_leads) + (select count(*)::int from public.mobility_leads) as legacy
    `;
    await runImport();
    const after = await admin<typeof before>`
      select
        (select count(*)::int from app.leads where id in ${admin(LEADS)}) as leads,
        (select count(*)::int from app.lead_activities where lead_id in ${admin(LEADS)}) as activities,
        (select count(*)::int from app.lead_tasks where lead_id in ${admin(LEADS)}) as tasks,
        (select count(*)::int from public.internet_leads) + (select count(*)::int from public.mobility_leads) as legacy
    `;
    expect(after).toEqual(before);
    // Two notes, and one "opened" entry per lead.
    expect(before[0]).toEqual({ leads: 4, activities: 6, tasks: 2, legacy: 4 });
  });

  test('later runs carry the old admin’s changes, except onto leads worked in the CRM', async () => {
    // Staff keep using the old admin until the cutover…
    await admin`
      update public.internet_leads
      set status = 'lost', notes = 'Called twice, installed. Cancelled later.',
          notes_updated_at = '2026-07-01T10:00:00Z'
      where id = ${WON}
    `;
    await admin`update public.internet_leads set reminder_at = null where id = ${TRASHED}`;
    // …while someone already worked the mobility lead in the CRM.
    const noted = await work.addNote({
      workspaceId: canadawide,
      actorId: STAFF,
      requestId: '34000000-0000-4000-8000-000000000f01',
      leadId: MOBILITY,
      body: 'Called from the CRM.',
    });
    expect(noted.status).toBe('created');
    await admin`update public.mobility_leads set status = 'won' where id = ${MOBILITY}`;

    await runImport();

    expect((await leadRow(WON)).stage).toBe('lost');
    const notes = await admin<{ body: string }[]>`
      select body from app.lead_activities
      where lead_id = ${WON} and kind = 'note' order by created_at
    `;
    // The edited note is a second entry; the first is never rewritten.
    expect(notes.map((note) => note.body)).toEqual([
      'Called twice, installed.',
      'Called twice, installed. Cancelled later.',
    ]);

    const [cleared] = await admin<{ status: string }[]>`
      select status from app.lead_tasks where lead_id = ${TRASHED}
    `;
    expect(cleared?.status).toBe('cancelled');

    expect((await leadRow(MOBILITY)).stage).toBe('contacted');
  });

  test('the mirror trigger never copies an imported lead back into the legacy tables', async () => {
    const [counts] = await admin<{ internet: number; mobility: number }[]>`
      select
        (select count(*)::int from public.internet_leads) as internet,
        (select count(*)::int from public.mobility_leads) as mobility
    `;
    expect(counts).toEqual({ internet: 3, mobility: 1 });
  });

  test('a lead from the CRM’s own intake stays New, though the mirror copied it over', async () => {
    await admin`
      insert into app.leads (id, workspace_id, lead_type, status, full_name, email, phone,
        payload, consent_version)
      values (${FROM_INTAKE}, ${canadawide}, 'internet', 'submitted', 'Intake Person',
        'intake.person@example.test', '403 555 0204',
        ${admin.json({
          schemaVersion: 1,
          payload: {
            planId: 'ab-1gbps',
            planLabel: '1Gbps',
            dateOfBirth: '1990-04-12',
            streetAddress: '4 Intake Way',
            city: 'Calgary',
            consent: true,
            consentedAt: '2026-10-26T10:00:00.000Z',
          },
        })},
        'cw-internet-v1')
    `;
    const [mirrored] = await admin<{ count: number }[]>`
      select count(*)::int as count from public.internet_leads where id = ${FROM_INTAKE}
    `;
    expect(mirrored?.count).toBe(1);

    await runImport();

    const page = await work.getLead({
      workspaceId: canadawide,
      actorId: STAFF,
      leadId: FROM_INTAKE,
      includeWork: true,
    });
    expect(page?.lead.isNew).toBe(true);
    expect(page?.activities).toEqual([]);

    // Opening it in the CRM is not working it: the old admin's changes still arrive.
    await expect(
      work.markOpened({
        workspaceId: canadawide,
        actorId: STAFF,
        requestId: '34000000-0000-4000-8000-000000000f02',
        leadId: FROM_INTAKE,
      }),
    ).resolves.toMatchObject({ status: 'opened', activity: { actorId: STAFF } });
    await admin`update public.internet_leads set status = 'contacted' where id = ${FROM_INTAKE}`;
    await runImport();
    expect((await leadRow(FROM_INTAKE)).stage).toBe('contacted');
  });
});
