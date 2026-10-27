import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { LEGACY_IMPORT_ACTOR_ID, leadDetailSchema, leadTaskSchema } from '@gt-sales/contracts';

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

const IMPORT_SQL = readFileSync(
  fileURLToPath(
    new URL('../../../packages/db/sql/getcanadasim-legacy-import.sql', import.meta.url),
  ),
  'utf8',
);

/**
 * Get Canada Sim's `orders` and `partners` with production's columns, NOT
 * NULL rules, defaults and checks (read from the live catalog, 2026-10-27).
 * Only this suite creates them, under its own advisory lock.
 */
const GCS_TABLES_DDL = `
  create table public.partners (
    id uuid primary key default gen_random_uuid(),
    partner_no bigint not null unique,
    company text not null,
    contact_name text not null,
    email text not null,
    phone text not null,
    website text,
    country text,
    business_type text,
    volume text,
    message text,
    status text not null default 'new'
      check (status in ('new', 'contacted', 'approved', 'declined')),
    created_at timestamptz not null default now(),
    license_path text,
    commission_rate numeric not null default 0,
    payment_settings jsonb
  );
  create table public.orders (
    id uuid primary key default gen_random_uuid(),
    order_no bigint not null unique,
    full_name text not null,
    email text not null,
    phone text not null,
    plan text,
    delivery text not null check (delivery in ('esim', 'pickup')),
    arrival date,
    permit_type text,
    reference text,
    notes text,
    passport_path text,
    permit_path text,
    status text not null default 'pending' check (status in (
      'incomplete', 'pending', 'verified', 'on_hold', 'delivered', 'activated',
      'completed', 'invoiced', 'paid', 'cancelled'
    )),
    created_at timestamptz not null default now(),
    partner_id uuid references public.partners (id),
    canada_address text,
    flight_booked boolean,
    partner_note text,
    partner_note_at timestamptz,
    admin_note text,
    admin_note_at timestamptz,
    shipping_address text,
    got_visa boolean,
    reminder_at date,
    reminder_note text,
    reminder_done_at timestamptz,
    archived_at timestamptz,
    sim_photo_path text,
    ip_address text,
    country_code text,
    sim_number text check (sim_number is null or char_length(sim_number) <= 40),
    billing_contract_path text,
    viewed_at timestamptz,
    commission_status text check (
      commission_status is null or commission_status in ('invoiced', 'commission_received', 'claw_back')
    )
  );
`;

// Next to the legacy CanadaWide tables' key (745284915).
const GCS_TABLES_LOCK_KEY = 745284916;

// A distinct id range from every other integration test file sharing this database.
const GCS_CANDIDATE = '15000000-0000-4000-8000-000000000a01';
const PARTNER = '15000000-0000-4000-8000-000000000a11';
const PENDING = '15000000-0000-4000-8000-000000000a21';
const OLD_CHECKOUT = '15000000-0000-4000-8000-000000000a22';
const ARCHIVED = '15000000-0000-4000-8000-000000000a23';
const PAID = '15000000-0000-4000-8000-000000000a24';
const WORKED = '15000000-0000-4000-8000-000000000a25';
const STAFF = '25000000-0000-4000-8000-000000000a01';
const LEADS = [PARTNER, PENDING, OLD_CHECKOUT, ARCHIVED, PAID, WORKED];
const SHARED_EMAIL = 'kept.name@example.test';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';

databaseTest('Get Canada Sim historical import', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let work: DatabaseLeadWorkStore;
  let site: string;

  /** Runs the script; its last result is the reconciliation row. */
  async function runImport(): Promise<Record<string, unknown>> {
    const results: unknown = await admin.unsafe(IMPORT_SQL);
    const last: unknown = Array.isArray(results) ? results.at(-1) : undefined;
    const row: unknown = Array.isArray(last) ? last[0] : undefined;
    if (typeof row !== 'object' || row === null) throw new Error('no reconciliation row');
    return Object.fromEntries(Object.entries(row));
  }

  async function lead(id: string) {
    const [row] = await admin<
      {
        lead_type: string;
        status: string;
        stage: string;
        full_name: string | null;
        email: string | null;
        phone: string | null;
        country_code: string | null;
        external_ref: string | null;
        payload: unknown;
        attribution: unknown;
        deleted_at: Date | null;
        contact_email: string | null;
      }[]
    >`
      select l.lead_type, l.status, l.stage, l.full_name, l.email, l.phone, l.country_code,
             l.external_ref, l.payload, l.attribution, l.deleted_at, c.email as contact_email
      from app.leads l left join app.contacts c on c.id = l.contact_id
      where l.id = ${id}
    `;
    return row;
  }

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    await admin`select pg_advisory_lock(${GCS_TABLES_LOCK_KEY})`;
    await admin`drop table if exists public.orders, public.partners`;
    await admin.unsafe(GCS_TABLES_DDL);
    // `getcanadasim` may already exist in a reused database; the import keys on the slug.
    await admin`
      insert into app.workspaces (id, slug, name)
      values (${GCS_CANDIDATE}, 'getcanadasim', 'Get Canada Sim')
      on conflict do nothing
    `;
    const [row] = await admin<{ id: string }[]>`
      select id from app.workspaces where slug = 'getcanadasim'
    `;
    if (!row) throw new Error('expected the getcanadasim workspace');
    site = row.id;
    await admin`delete from app.leads where id in ${admin(LEADS)}`;
    // Someone the CRM already knows, under another name: the import must not rename them.
    await admin`
      insert into app.contacts (email, full_name, phone, country_code)
      values (${SHARED_EMAIL}, 'Name Kept', '403 555 0100', 'CA')
      on conflict (email) do update set full_name = 'Name Kept', phone = '403 555 0100', country_code = 'CA'
    `;

    await admin`
      insert into public.partners (id, partner_no, company, contact_name, email, phone, website,
        country, business_type, volume, message, status, created_at, commission_rate)
      values (${PARTNER}, 7, 'Maple Study Abroad', 'Priya Agent', 'Priya@Agency.example.test',
        '+91 98765 43210', 'agency.example.test', 'India', 'Education agency', '20-50 a month',
        'We send students every intake.', 'approved', '2026-08-18T10:00:00Z', 10)
    `;
    await admin`
      insert into public.orders (id, order_no, full_name, email, phone, plan, delivery, arrival,
        permit_type, reference, notes, status, created_at, canada_address, flight_booked,
        admin_note, admin_note_at, got_visa, reminder_at, reminder_note, country_code,
        partner_id, sim_number, ip_address)
      values
        (${PENDING}, 101, 'Arjun Patel', 'ARJUN@example.test ', '+91 99999 00001',
         'unlimited-data-rogers', 'esim', '2026-11-02', 'student', 'Batch 12',
         'Please call after 6pm IST', 'pending', '2026-10-20T09:00:00Z', 'Toronto', true,
         'Called, waiting on visa', '2026-10-21T10:00:00Z', true, '2026-10-30',
         'Check visa status', 'in', ${PARTNER}, null, '203.0.113.9'),
        (${PAID}, 104, 'Kept Person', ${SHARED_EMAIL}, '647 555 0104', '50gb-fido', 'pickup',
         null, 'worker', null, 'Shipping address: 1 Bay St, Toronto ON', 'paid',
         '2026-09-01T09:00:00Z', null, null, null, null, null, '2026-09-05', null, 'CA',
         null, '4165550104', null)
    `;
    await admin`
      insert into public.orders (id, order_no, full_name, email, phone, plan, delivery, status,
        created_at, archived_at, reminder_at, reminder_done_at)
      values
        (${OLD_CHECKOUT}, 102, 'Old Checkout', 'old.checkout@example.test', '000', null, 'esim',
         'incomplete', '2026-07-01T09:00:00Z', null, null, null),
        (${ARCHIVED}, 103, 'Dead Lead', 'dead.lead@example.test', '111', 'unlimited-data-rogers',
         'esim', 'pending', '2026-08-01T09:00:00Z', '2026-08-15T09:00:00Z', null, null),
        (${WORKED}, 105, 'Worked Here', 'worked.here@example.test', '222', '75gb-fido', 'esim',
         'verified', '2026-10-01T09:00:00Z', null, '2026-10-02', '2026-10-03T09:00:00Z')
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
  }, 120_000);

  afterAll(async () => {
    await database?.close();
    await admin`delete from app.leads where id in ${admin(LEADS)}`;
    await admin`drop table if exists public.orders, public.partners`;
    await admin`select pg_advisory_unlock(${GCS_TABLES_LOCK_KEY})`;
    await admin.end();
  });

  test('brings every order and partner application over, and reconciles', async () => {
    const reconciliation = await runImport();
    expect(Number(reconciliation['rows_missing'])).toBe(0);
    expect(Number(reconciliation['stage_mismatches'])).toBe(0);
    expect(Number(reconciliation['crm_orders'])).toBeGreaterThanOrEqual(5);
    expect(Number(reconciliation['crm_partners'])).toBeGreaterThanOrEqual(1);
  });

  test('an order keeps its number, status, contact and form', async () => {
    const row = await lead(PENDING);
    expect(row).toMatchObject({
      lead_type: 'sim_order',
      status: 'submitted',
      stage: 'pending',
      full_name: 'Arjun Patel',
      email: 'ARJUN@example.test',
      phone: '+91 99999 00001',
      country_code: 'IN',
      external_ref: 'MS-101',
      deleted_at: null,
      contact_email: 'arjun@example.test',
      attribution: { partnerCode: 'PT-7', partnerCodeMatched: true },
      payload: {
        schemaVersion: 1,
        payload: {
          planId: 'unlimited-data-rogers',
          planLabel: 'Unlimited Data · $40, Rogers',
          delivery: 'esim',
          arrivalDate: '2026-11-02',
          permitType: 'student',
          gotVisa: true,
          flightBooked: true,
          canadaAddress: 'Toronto',
          reference: 'Batch 12',
          customerNotes: 'Please call after 6pm IST',
        },
      },
    });
    // Nothing the CRM does not model yet is copied: no IP address.
    expect(JSON.stringify(row)).not.toContain('203.0.113.9');

    const page = await work.getLead({
      workspaceId: site,
      actorId: STAFF,
      leadId: PENDING,
      includeWork: true,
    });
    expect(leadDetailSchema.safeParse(page?.lead).success).toBe(true);
    expect(page?.activities).toEqual([
      expect.objectContaining({
        kind: 'note',
        actorId: LEGACY_IMPORT_ACTOR_ID,
        body: 'Called, waiting on visa',
        createdAt: '2026-10-21T10:00:00.000Z',
      }),
    ]);
    expect(page?.tasks).toEqual([
      expect.objectContaining({
        title: 'Check visa status',
        dueAt: '2026-10-30T12:00:00.000Z',
        status: 'open',
      }),
    ]);
    expect(page?.tasks.every((task) => leadTaskSchema.safeParse(task).success)).toBe(true);
  });

  test('reads the old shipping address from the notes, and keeps a known person as they are', async () => {
    const row = await lead(PAID);
    expect(row).toMatchObject({
      stage: 'paid',
      external_ref: 'MS-104',
      contact_email: SHARED_EMAIL,
    });
    expect(row?.payload).toEqual({
      schemaVersion: 1,
      payload: {
        planId: '50gb-fido',
        delivery: 'pickup',
        permitType: 'worker',
        shippingAddress: '1 Bay St, Toronto ON',
        simNumber: '4165550104',
      },
    });
    const [contact] = await admin<{ full_name: string; phone: string }[]>`
      select full_name, phone from app.contacts where email = ${SHARED_EMAIL}
    `;
    expect(contact).toEqual({ full_name: 'Name Kept', phone: '403 555 0100' });
  });

  test('an unfinished checkout stays incomplete, and an archived order is in the trash', async () => {
    expect(await lead(OLD_CHECKOUT)).toMatchObject({
      status: 'incomplete',
      stage: 'incomplete',
      external_ref: 'MS-102',
    });
    const archived = await lead(ARCHIVED);
    expect(archived?.stage).toBe('pending');
    expect(archived?.deleted_at?.toISOString()).toBe('2026-08-15T09:00:00.000Z');
  });

  test('a partner application keeps its company, its stage and its number', async () => {
    expect(await lead(PARTNER)).toMatchObject({
      lead_type: 'partner_application',
      status: 'submitted',
      stage: 'approved',
      full_name: 'Priya Agent',
      external_ref: 'PT-7',
      contact_email: 'priya@agency.example.test',
      payload: {
        schemaVersion: 1,
        payload: {
          company: 'Maple Study Abroad',
          website: 'agency.example.test',
          country: 'India',
          businessType: 'Education agency',
          volume: '20-50 a month',
          message: 'We send students every intake.',
        },
      },
    });
  });

  test('a second run changes nothing', async () => {
    const fingerprint = () => admin<{ digest: string }[]>`
      select md5(string_agg(row_to_json(x)::text, '|' order by x.id)) as digest
      from (
        select l.id, l.status, l.stage, l.payload, l.deleted_at, l.updated_at,
               (select json_agg(a.body order by a.id) from app.lead_activities a where a.lead_id = l.id) as notes,
               (select json_agg(row_to_json(k) order by k.id) from app.lead_tasks k where k.lead_id = l.id) as tasks
        from app.leads l where l.id in ${admin(LEADS)}
      ) x
    `;
    const [before] = await fingerprint();
    await runImport();
    const [after] = await fingerprint();
    expect(after?.digest).toBe(before?.digest);
  });

  test('later runs carry the old admin over, except onto a lead worked in the CRM', async () => {
    await work.addNote({
      workspaceId: site,
      actorId: STAFF,
      requestId: '35000000-0000-4000-8000-000000000a01',
      leadId: WORKED,
      body: 'Handled in the CRM now',
    });
    await admin`
      update public.orders set status = 'activated', admin_note = 'Visa approved',
        admin_note_at = '2026-10-25T10:00:00Z', reminder_at = null, reminder_note = null,
        phone = '+91 99999 00002'
      where id = ${PENDING}
    `;
    await admin`update public.orders set status = 'pending' where id = ${OLD_CHECKOUT}`;
    await admin`update public.orders set status = 'cancelled' where id = ${WORKED}`;
    await runImport();

    expect(await lead(PENDING)).toMatchObject({ stage: 'activated', phone: '+91 99999 00002' });
    const page = await work.getLead({
      workspaceId: site,
      actorId: STAFF,
      leadId: PENDING,
      includeWork: true,
    });
    expect(
      page?.activities.map((entry) => (entry.kind === 'note' ? entry.body : entry.kind)),
    ).toEqual(['Visa approved', 'Called, waiting on visa']);
    expect(page?.tasks.map((task) => task.status)).toEqual(['cancelled']);
    // The customer finished the checkout in the old admin's time: no longer incomplete.
    expect(await lead(OLD_CHECKOUT)).toMatchObject({ status: 'submitted', stage: 'pending' });
    // Worked in the CRM: the CRM's view wins.
    expect(await lead(WORKED)).toMatchObject({ stage: 'verified' });
  });
});
