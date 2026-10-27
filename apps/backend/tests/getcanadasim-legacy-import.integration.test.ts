import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { InMemoryR2DocumentStore, sha256Hex } from '@gt-sales/adapters';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { LEGACY_IMPORT_ACTOR_ID, leadDetailSchema, leadTaskSchema } from '@gt-sales/contracts';
import { OutboxRunner } from '@gt-sales/jobs';

import { createLegacyDocumentImportHandler } from '../src/documents/import-job.js';
import { DatabaseDocumentContextResolver } from '../src/documents/resolver.js';
import { DocumentService } from '../src/documents/service.js';
import { DatabaseDocumentStore } from '../src/documents/store.js';
import { DatabaseOutboxStore } from '../src/jobs/store.js';
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
  create table public.order_edit_requests (
    id uuid primary key default gen_random_uuid(),
    request_no bigint generated always as identity,
    order_id uuid not null references public.orders (id) on delete cascade,
    email text not null,
    changes jsonb not null,
    status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
    reviewed_at timestamptz,
    created_at timestamptz not null default now()
  );
`;

// Next to the legacy CanadaWide tables' key (745284915).
const GCS_TABLES_LOCK_KEY = 745284916;

/**
 * Supabase Storage's object index, the columns the import reads, for a
 * database that has none (CI, local); a real project already has it.
 */
const STORAGE_DDL = `
  create schema if not exists storage;
  create table if not exists storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text,
    name text,
    version text,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
  );
`;

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
    await admin`drop table if exists public.order_edit_requests, public.orders, public.partners`;
    await admin.unsafe(GCS_TABLES_DDL);
    await admin.unsafe(STORAGE_DDL);
    await admin`delete from storage.objects where name like ${'%/15000000-0000-4000-8000-000000000a%'}`;
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
    // A reused database keeps an earlier run's copies; their keys would repeat.
    await admin`
      delete from app.outbox_jobs
      where workspace_id = ${site} and job_type = 'legacy_document_import'
    `;
    await admin`delete from app.files where record_id in ${admin(LEADS)}`;
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
        partner_id, sim_number, ip_address, viewed_at)
      values
        (${PENDING}, 101, 'Arjun Patel', 'ARJUN@example.test ', '+91 99999 00001',
         'unlimited-data-rogers', 'esim', '2026-11-02', 'student', 'Batch 12',
         'Please call after 6pm IST', 'pending', '2026-10-20T09:00:00Z', 'Toronto', true,
         'Called, waiting on visa', '2026-10-21T10:00:00Z', true, '2026-10-30',
         'Check visa status', 'in', ${PARTNER}, null, '203.0.113.9', '2026-10-20T11:00:00Z'),
        (${PAID}, 104, 'Kept Person', ${SHARED_EMAIL}, '647 555 0104', '50gb-fido', 'pickup',
         null, 'worker', null, 'Shipping address: 1 Bay St, Toronto ON', 'paid',
         '2026-09-01T09:00:00Z', null, null, null, null, null, '2026-09-05', null, 'CA',
         null, '4165550104', null, null)
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

    await admin`update public.orders set commission_status = 'invoiced' where id = ${PAID}`;
    // Two change requests from /track on the paid order: one approved (an
    // address, the arrival, and new documents), one still waiting.
    await admin`
      insert into public.order_edit_requests (order_id, email, changes, status, reviewed_at, created_at)
      values
        (${PAID}, ${SHARED_EMAIL},
         ${admin.json({ arrival: '2026-09-10', canada_address: 'Calgary', passport_path: `orders/${PAID}/passport-2.pdf`, permit_path: `orders/${PAID}/permit-2.pdf` })},
         'approved', '2026-09-03T10:00:00Z', '2026-09-02T10:00:00Z'),
        (${PAID}, ${SHARED_EMAIL}, ${admin.json({ phone: '647 555 0199' })}, 'pending', null,
         '2026-09-04T10:00:00Z')
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
    await admin`delete from storage.objects where name like ${'%/15000000-0000-4000-8000-000000000a%'}`;
    await admin`delete from app.leads where id in ${admin(LEADS)}`;
    await admin`drop table if exists public.order_edit_requests, public.orders, public.partners`;
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
    // Opened in the old admin (`viewed_at`): opened here too, so not New.
    expect(page?.lead.isNew).toBe(false);
    expect(page?.activities).toEqual([
      expect.objectContaining({
        kind: 'note',
        actorId: LEGACY_IMPORT_ACTOR_ID,
        body: 'Called, waiting on visa',
        createdAt: '2026-10-21T10:00:00.000Z',
      }),
      expect.objectContaining({
        kind: 'system',
        actorId: LEGACY_IMPORT_ACTOR_ID,
        event: 'opened',
        createdAt: '2026-10-20T11:00:00.000Z',
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
        commissionStatus: 'invoiced',
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
    // Nobody opened it in the old admin: New here until someone does.
    const page = await work.getLead({
      workspaceId: site,
      actorId: STAFF,
      leadId: OLD_CHECKOUT,
      includeWork: true,
    });
    expect(page?.lead.isNew).toBe(true);
    expect(page?.activities).toEqual([]);
    const archived = await lead(ARCHIVED);
    expect(archived?.stage).toBe('pending');
    expect(archived?.deleted_at?.toISOString()).toBe('2026-08-15T09:00:00.000Z');
  });

  test('a partner application keeps its company, its stage and its number', async () => {
    const page = await work.getLead({
      workspaceId: site,
      actorId: STAFF,
      leadId: PARTNER,
      includeWork: false,
    });
    // Handled in the old admin, which had no badge for them: not New.
    expect(page?.lead.isNew).toBe(false);
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
    // Opening a lead in the CRM is not working it: the old admin's changes still arrive.
    await expect(
      work.markOpened({
        workspaceId: site,
        actorId: STAFF,
        requestId: '35000000-0000-4000-8000-000000000a02',
        leadId: OLD_CHECKOUT,
      }),
    ).resolves.toMatchObject({ status: 'opened', activity: { kind: 'system' } });
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
    ).toEqual(['Visa approved', 'Called, waiting on visa', 'system']);
    expect(page?.tasks.map((task) => task.status)).toEqual(['cancelled']);
    // The customer finished the checkout in the old admin's time: no longer incomplete.
    expect(await lead(OLD_CHECKOUT)).toMatchObject({ status: 'submitted', stage: 'pending' });
    // Opened once, by the CRM's staff: the import adds no second entry.
    const opened = await admin<{ actor_id: string }[]>`
      select actor_id from app.lead_activities
      where lead_id = ${OLD_CHECKOUT} and kind = 'system' and data ->> 'event' = 'opened'
    `;
    expect(opened).toEqual([{ actor_id: STAFF }]);
    // Worked in the CRM: the CRM's view wins.
    expect(await lead(WORKED)).toMatchObject({ stage: 'verified' });
  });

  test('copies each document the old admin keeps onto its lead, verified, once', async () => {
    const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
    const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const passport = `orders/${PENDING}/passport.pdf`;
    const files: [string, Uint8Array, string][] = [
      [passport, PDF, 'v1'],
      [`orders/${PENDING}/permit-1.jpg`, JPEG, 'v1'],
      [`orders/${PAID}/sim-photo.jpg`, JPEG, 'v1'],
      [`partners/${PARTNER}/license.pdf`, PDF, 'v1'],
      // A restricted lead's file is never copied.
      [`orders/${OLD_CHECKOUT}/passport.pdf`, PDF, 'v1'],
    ];
    const r2 = new InMemoryR2DocumentStore();
    for (const [name, bytes, version] of files) {
      r2.putObject(name, bytes);
      await admin`
        insert into storage.objects (bucket_id, name, version, created_at, updated_at)
        values ('documents', ${name}, ${version}, '2026-10-20T09:30:00Z', '2026-10-20T09:30:00Z')
      `;
    }
    await admin`
      update public.orders set passport_path = ${passport},
        permit_path = ${`orders/${PENDING}/permit-1.jpg`}
      where id = ${PENDING}
    `;
    await admin`update public.orders set sim_photo_path = ${`orders/${PAID}/sim-photo.jpg`} where id = ${PAID}`;
    // Named, but not in storage: nothing to copy.
    await admin`update public.orders set billing_contract_path = ${`orders/${PAID}/billing-contract.pdf`} where id = ${PAID}`;
    await admin`update public.partners set license_path = ${`partners/${PARTNER}/license.pdf`} where id = ${PARTNER}`;
    await admin`update public.orders set passport_path = ${`orders/${OLD_CHECKOUT}/passport.pdf`} where id = ${OLD_CHECKOUT}`;
    await admin`update app.leads set customer_data_restricted_at = now() where id = ${OLD_CHECKOUT}`;

    const queued = () => admin<{ payload: Record<string, string> }[]>`
      select payload from app.outbox_jobs
      where workspace_id = ${site} and job_type = 'legacy_document_import'
      order by payload ->> 'sourceKey', created_at
    `;
    const reconciliation = await runImport();
    expect(Number(reconciliation['documents_queued'])).toBe(4);
    expect(
      (await queued()).map((job) => [job.payload['documentType'], job.payload['sourceKey']]),
    ).toEqual([
      ['passport', passport],
      ['visa', `orders/${PENDING}/permit-1.jpg`],
      ['sim_photo', `orders/${PAID}/sim-photo.jpg`],
      ['business_licence', `partners/${PARTNER}/license.pdf`],
    ]);
    expect((await queued())[0]?.payload).toEqual({
      leadId: PENDING,
      documentType: 'passport',
      sourceKey: passport,
      uploadedAt: '2026-10-20T09:30:00.000Z',
    });
    // Unchanged files are never queued twice.
    await runImport();
    expect(await queued()).toHaveLength(4);

    const documents = new DocumentService(
      new DatabaseDocumentStore(database),
      r2,
      new DatabaseDocumentContextResolver(database),
      { bucket: 'documents' },
    );
    const runner = new OutboxRunner({
      store: new DatabaseOutboxStore(database),
      handlers: new Map([['legacy_document_import', createLegacyDocumentImportHandler(documents)]]),
    });
    const run = await runner.run({ authorizedWorkspaceIds: [site], actorId: STAFF });
    expect(run).toMatchObject({ claimed: 4, completed: 4, failed: 0 });
    expect(Number((await runImport())['crm_documents'])).toBe(4);

    const page = await work.getLead({
      workspaceId: site,
      actorId: STAFF,
      leadId: PENDING,
      includeWork: true,
    });
    expect(
      [...(page?.documents ?? [])]
        .map((document) => [document.documentType, document.contentType, document.createdAt])
        .sort(),
    ).toEqual([
      ['passport', 'application/pdf', '2026-10-20T09:30:00.000Z'],
      ['visa', 'image/jpeg', '2026-10-20T09:30:00.000Z'],
    ]);
    const [file] = await admin<{ uploaded_by: string; checksum_sha256: string }[]>`
      select uploaded_by, checksum_sha256 from app.files
      where record_id = ${PENDING} and document_type = 'passport'
    `;
    expect(file).toEqual({ uploaded_by: LEGACY_IMPORT_ACTOR_ID, checksum_sha256: sha256Hex(PDF) });
    // The old admin's own object is where it was.
    expect(r2.getObject(passport)).toEqual(PDF);

    // Replaced in the old admin (same name, new bytes): copied again, as the current one.
    const REPLACED = new Uint8Array([...PDF, 0x0a]);
    r2.putObject(passport, REPLACED);
    await admin`
      update storage.objects set version = 'v2', updated_at = '2026-10-26T08:00:00Z'
      where bucket_id = 'documents' and name = ${passport}
    `;
    await runImport();
    expect(await runner.run({ authorizedWorkspaceIds: [site], actorId: STAFF })).toMatchObject({
      claimed: 1,
      completed: 1,
    });
    const replaced = await work.getLead({
      workspaceId: site,
      actorId: STAFF,
      leadId: PENDING,
      includeWork: true,
    });
    expect(
      replaced?.documents.find((document) => document.documentType === 'passport'),
    ).toMatchObject({
      revision: 2,
      sizeBytes: REPLACED.byteLength,
      createdAt: '2026-10-26T08:00:00.000Z',
    });
    expect(Number((await runImport())['crm_documents'])).toBe(4);
  });

  test('a customer’s change requests become the order’s history, values left out', async () => {
    const page = await work.getLead({
      workspaceId: site,
      actorId: STAFF,
      leadId: PAID,
      includeWork: true,
    });
    const changes = (page?.activities ?? []).filter(
      (entry) => entry.kind === 'system' && entry.event.startsWith('change_'),
    );
    expect(changes).toEqual([
      expect.objectContaining({
        event: 'change_requested',
        requestNo: 2,
        fields: ['phone'],
        documents: [],
        createdAt: '2026-09-04T10:00:00.000Z',
      }),
      expect.objectContaining({
        event: 'change_approved',
        requestNo: 1,
        createdAt: '2026-09-03T10:00:00.000Z',
      }),
      expect.objectContaining({
        event: 'change_requested',
        requestNo: 1,
        fields: ['arrivalDate', 'canadaAddress'],
        documents: ['passport', 'visa'],
        actorId: LEGACY_IMPORT_ACTOR_ID,
      }),
    ]);
    expect(JSON.stringify(changes)).not.toContain('Calgary');
    expect(JSON.stringify(changes)).not.toContain('0199');

    // The old admin decides the waiting one: the next run brings the decision, once.
    await admin`
      update public.order_edit_requests set status = 'rejected', reviewed_at = '2026-09-05T10:00:00Z'
      where status = 'pending'
    `;
    const reconciliation = await runImport();
    expect(Number(reconciliation['change_requests'])).toBe(2);
    await runImport();
    const decided = await work.getLead({
      workspaceId: site,
      actorId: STAFF,
      leadId: PAID,
      includeWork: true,
    });
    expect(
      decided?.activities
        .filter((entry) => entry.kind === 'system' && entry.event.startsWith('change_'))
        .map((entry) => (entry.kind === 'system' ? `${entry.event}:${entry.requestNo}` : '')),
    ).toEqual([
      'change_rejected:2',
      'change_requested:2',
      'change_approved:1',
      'change_requested:1',
    ]);
  });
});
