import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  codePropertyCatalog,
  createLeadResponseSchema,
  updateLeadResponseSchema,
} from '@gt-sales/contracts';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { STAFF_SEED_IDS } from '@gt-sales/db/seed';

import { createApp } from '../src/app.js';
import type { StaffSessionVerifier, VerifiedStaffSession } from '../src/auth/session.js';
import { DatabaseLeadStore } from '../src/leads/store.js';
import { DatabaseLeadWorkStore } from '../src/leads/work-store.js';
import { DatabasePlanStore } from '../src/plans/store.js';
import { DatabasePropertyStore } from '../src/properties/store.js';
import { DatabaseStaffStore } from '../src/staff/store.js';
import { generateServiceSecret } from '../src/website/credential.js';
import { DatabaseWebsiteCredentialStore } from '../src/website/store.js';
import {
  GCS_TABLES_DDL,
  claimGetCanadaSimTables,
  dropGetCanadaSimTables,
  releaseGetCanadaSimTables,
} from './support/legacy-getcanadasim.js';
import { getDisposableTestDatabaseUrl, TEST_RUNTIME_PASSWORD } from '@gt-sales/db/test-helpers';

const migrationUrl = getDisposableTestDatabaseUrl();
const databaseTest = migrationUrl ? describe : describe.skip;

const MIGRATION_SQL = readFileSync(
  fileURLToPath(
    new URL('../../../packages/db/drizzle/0041_getcanadasim_legacy_mirror.sql', import.meta.url),
  ),
  'utf8',
);

/** Migration 0048 (issue #85): the copy once a rescued order gets its name and email. */
const ELIGIBLE_MIGRATION_SQL = readFileSync(
  fileURLToPath(
    new URL(
      '../../../packages/db/drizzle/0048_getcanadasim_mirror_when_eligible.sql',
      import.meta.url,
    ),
  ),
  'utf8',
);

/** A migration's backfill, between `-- BACKFILL BEGIN` and `-- BACKFILL END`, verbatim. */
function backfillBlock(sql = MIGRATION_SQL): string {
  const begin = sql.indexOf('-- BACKFILL BEGIN');
  const end = sql.indexOf('-- BACKFILL END');
  if (begin < 0 || end < begin) throw new Error('no BACKFILL block in the migration');
  return sql.slice(begin, end);
}

// A distinct id range from every other integration test file sharing this database.
// The site is the synthetic seed's Get Canada Sim (same id, slug, name and
// domain), as in the import suite: the mirror keys on the slug.
const GCS_CANDIDATE = STAFF_SEED_IDS.getCanadaSimWorkspace;
const OTHER_SITE = '16000000-0000-4000-8000-000000000b02';
const CREDENTIAL = '16000000-0000-4000-8000-000000000b11';
const PLAN = '16000000-0000-4000-8000-000000000b21';
const PARTNER = '16000000-0000-4000-8000-000000000b31';
const STAFF = '26000000-0000-4000-8000-000000000b01';
/** Every customer of this suite, so a rerun finds and removes its leads. */
const EMAIL_DOMAIN = '@gcs-mirror.example.test';
const email = (name: string) => `${name}${EMAIL_DOMAIN}`;

/** Signs nobody in: this suite only calls the website routes. */
class NoStaffVerifier implements StaffSessionVerifier {
  async verify(): Promise<VerifiedStaffSession | undefined> {
    return undefined;
  }
}

interface OrderRow {
  id: string;
  order_no: string;
  full_name: string;
  email: string;
  phone: string;
  plan: string | null;
  delivery: string;
  arrival: string | null;
  permit_type: string | null;
  reference: string | null;
  notes: string | null;
  passport_path: string | null;
  permit_path: string | null;
  status: string;
  same_created_at: boolean;
  partner_id: string | null;
  canada_address: string | null;
  flight_booked: boolean | null;
  shipping_address: string | null;
  got_visa: boolean | null;
  archived_at: Date | null;
  country_code: string | null;
  sim_number: string | null;
  commission_status: string | null;
  admin_note: string | null;
  viewed_at: Date | null;
  ip_address: string | null;
}

databaseTest('Get Canada Sim legacy mirror (migration 0041)', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let server: Server;
  let baseUrl: string;
  let site: string;
  let leadStore: DatabaseLeadStore;
  let work: DatabaseLeadWorkStore;
  const website = generateServiceSecret();

  const call = async (
    method: string,
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(`${baseUrl}/api/v1/website${path}`, {
      method,
      headers: {
        authorization: `Bearer ${website.secret}`,
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    });
    const json: unknown = await response.json();
    return { status: response.status, body: json };
  };

  /** The old admin's row for a lead, with the lead's creation time compared. */
  const orderRow = async (id: string): Promise<OrderRow | undefined> => {
    const [row] = await admin<OrderRow[]>`
      select o.id, o.order_no::text as order_no, o.full_name, o.email, o.phone, o.plan,
             o.delivery, o.arrival::text as arrival, o.permit_type, o.reference, o.notes,
             o.passport_path, o.permit_path, o.status,
             o.created_at = (select l.created_at from app.leads l where l.id = o.id) as same_created_at,
             o.partner_id, o.canada_address, o.flight_booked, o.shipping_address, o.got_visa,
             o.archived_at, o.country_code, o.sim_number, o.commission_status, o.admin_note,
             o.viewed_at, o.ip_address
      from public.orders o where o.id = ${id}
    `;
    return row;
  };

  /** Everything on a legacy row, to show nothing rewrote it. */
  const orderFingerprint = async (id: string) => {
    const [row] = await admin<{ digest: string }[]>`
      select md5(row_to_json(o)::text) as digest from public.orders o where o.id = ${id}
    `;
    return row?.digest;
  };

  const externalRef = async (id: string) => {
    const [row] = await admin<{ externalRef: string | null }[]>`
      select external_ref as "externalRef" from app.leads where id = ${id}
    `;
    return row?.externalRef;
  };

  /** The order number the next counter-issued SIM order takes: far past any the site holds. */
  const nextOrderNo = async (): Promise<number> => {
    const [row] = await admin<{ top: number }[]>`
      select greatest(
        coalesce(max(substring(l.external_ref from '^MS-([0-9]+)$')::bigint), 0),
        (select coalesce(max(order_no), 0) from public.orders),
        70000
      )::int as top
      from app.leads l where l.workspace_id = ${site} and l.lead_type = 'sim_order'
    `;
    const top = (row?.top ?? 70000) + 100;
    await admin`
      insert into app.site_counters (workspace_id, counter, last_value)
      values (${site}, 'sim_order_ref', ${top})
      on conflict (workspace_id, counter) do update set last_value = excluded.last_value
    `;
    return top + 1;
  };

  /** A lead written straight into app.leads, as an import or another code path would. */
  const insertLead = async (lead: {
    workspaceId?: string;
    leadType?: string;
    status?: string;
    stage?: string;
    fullName?: string | null;
    email?: string | null;
    phone?: string | null;
    externalRef: string | null;
    payload?: Record<string, postgres.JSONValue>;
    orderDetails?: Record<string, postgres.JSONValue>;
    attribution?: Record<string, postgres.JSONValue>;
    deletedAt?: string | null;
    id?: string;
  }): Promise<string> => {
    const id = lead.id ?? randomUUID();
    await admin`
      insert into app.leads (id, workspace_id, lead_type, status, stage, full_name, email, phone,
        external_ref, payload, order_details, attribution, consent_version, deleted_at)
      values (${id}, ${lead.workspaceId ?? site}, ${lead.leadType ?? 'sim_order'},
        ${lead.status ?? 'submitted'}, ${lead.stage ?? 'pending'},
        ${lead.fullName === undefined ? 'Direct Insert' : lead.fullName},
        ${lead.email === undefined ? email(`direct-${id.slice(0, 8)}`) : lead.email},
        ${lead.phone ?? null}, ${lead.externalRef},
        ${admin.json({ schemaVersion: 1, payload: lead.payload ?? { delivery: 'esim' } })},
        ${admin.json(lead.orderDetails ?? {})}, ${admin.json(lead.attribution ?? {})},
        'ci-gcs-mirror', ${lead.deletedAt ?? null})
    `;
    return id;
  };

  const cleanLeads = async () => {
    await admin`
      delete from app.leads
      where workspace_id in (${site}, ${OTHER_SITE}) and email like ${`%${EMAIL_DOMAIN}`}
    `;
    await admin`delete from app.leads where consent_version = 'ci-gcs-mirror'`;
  };

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    // Waits for the import suite, which uses the same tables and site.
    await claimGetCanadaSimTables(admin);
    // `getcanadasim` may already exist in a reused database; the mirror keys on the slug.
    await admin`
      insert into app.workspaces (id, slug, name, domain)
      values (${GCS_CANDIDATE}, 'getcanadasim', 'Get Canada Sim', 'getcanadasim.com'),
             (${OTHER_SITE}, 'ci-gcs-mirror-other', 'CI GCS Mirror Other', null)
      on conflict do nothing
    `;
    const [row] = await admin<{ id: string }[]>`
      select id from app.workspaces where slug = 'getcanadasim'
    `;
    if (!row) throw new Error('expected the getcanadasim workspace');
    site = row.id;
    await cleanLeads();
    await admin`
      insert into app.plans (id, workspace_id, lead_type, name, price_minor, billing_period, custom_values)
      values (${PLAN}, ${site}, 'sim_order', 'CI mirror plan', 4000, 'month',
              ${admin.json({ custom_website_slug: 'unlimited-data-rogers' })})
      on conflict (id) do update set active = true
    `;
    await admin`delete from app.service_credentials where id = ${CREDENTIAL}`;
    await admin`
      insert into app.service_credentials (id, workspace_id, secret_hash, scopes)
      values (${CREDENTIAL}, ${site}, ${website.secretHash}, array['leads:write'])
    `;
    await admin`
      insert into public.partners (id, partner_no, company, contact_name, email, phone)
      values (${PARTNER}, 7, 'Maple Study Abroad', 'Priya Agent', ${email('priya')}, '000')
    `;

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      maxConnections: 2,
      ssl: false,
    });
    leadStore = new DatabaseLeadStore(database);
    work = new DatabaseLeadWorkStore(database);
    const planStore = new DatabasePlanStore(database);
    server = createApp({
      staff: {
        sessionVerifier: new NoStaffVerifier(),
        store: new DatabaseStaffStore(database),
        credentialStore: new DatabaseWebsiteCredentialStore(database),
        leadStore,
        leadWorkStore: work,
        planStore,
        propertyStore: new DatabasePropertyStore(database),
      },
      website: {
        auth: {
          resolveCredential: database.resolveWebsiteCredential,
          // The limiter is not under test; its windows would outlive a run.
          rateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
          botCheck: () => true,
        },
        leads: { store: leadStore },
        plans: { store: planStore },
      },
    }).listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected TCP server');
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 120_000); // long enough to wait for the import suite to release the tables

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await database?.close();
    await cleanLeads();
    await admin`delete from app.service_credentials where id = ${CREDENTIAL}`;
    await admin`delete from app.site_counters where workspace_id = ${site} and counter = 'sim_order_ref'`;
    await releaseGetCanadaSimTables(admin);
    await admin.end();
  });

  test('the checkout’s draft reaches the old admin only when it is submitted, with every field', async () => {
    const orderNo = await nextOrderNo();
    // Step 1: the draft, before the customer has given everything.
    const created = await call('POST', '/leads', {
      leadType: 'sim_order',
      consentVersion: 'getcanadasim-order-2026-10',
      contact: { fullName: 'Arjun Patel' },
      form: { schemaVersion: 1, payload: { planId: 'unlimited-data-rogers' } },
      attribution: { partnerCode: 'PT-7', utmSource: 'partner' },
    });
    expect(created.status).toBe(201);
    const draft = createLeadResponseSchema.parse(created.body);
    const leadId = draft.lead.id;
    const grant = draft.draftGrant?.token;
    if (!grant) throw new Error('expected a draft grant');
    expect(draft.lead.externalRef).toBe(`MS-${orderNo}`);
    expect(await orderRow(leadId)).toBeUndefined();

    // Step 2: a save fills the contact and the form; still a draft, still not copied.
    const form = {
      schemaVersion: 1,
      payload: {
        planId: 'unlimited-data-rogers',
        planLabel: 'Unlimited Data · $40, Rogers',
        delivery: 'esim',
        arrivalDate: '2026-12-02',
        permitType: 'student',
        gotVisa: true,
        flightBooked: false,
        canadaAddress: 'Toronto',
        reference: 'Batch 12',
      },
    };
    const saved = await call(
      'PATCH',
      `/leads/${leadId}`,
      {
        contact: {
          fullName: 'Arjun Patel',
          email: email('arjun'),
          phone: '+91 99999 00001',
          countryCode: 'IN',
        },
        form,
        order: { planId: PLAN, quantity: 1 },
      },
      { 'x-draft-grant': grant },
    );
    expect(saved.status).toBe(200);
    expect(await orderRow(leadId)).toBeUndefined();

    // Step 3: the submit; the old admin has the order with what was submitted.
    const submitted = await call(
      'PATCH',
      `/leads/${leadId}`,
      { submit: true },
      { 'x-draft-grant': grant, 'Idempotency-Key': `gcs-mirror-${leadId}` },
    );
    expect(submitted.status).toBe(200);
    expect(updateLeadResponseSchema.parse(submitted.body).lead.status).toBe('submitted');
    expect(await orderRow(leadId)).toEqual({
      id: leadId,
      order_no: String(orderNo),
      full_name: 'Arjun Patel',
      email: email('arjun'),
      phone: '+91 99999 00001',
      plan: 'unlimited-data-rogers',
      delivery: 'esim',
      arrival: '2026-12-02',
      permit_type: 'student',
      reference: 'Batch 12',
      notes: null,
      // Documents stay in the CRM.
      passport_path: null,
      permit_path: null,
      status: 'pending',
      same_created_at: true,
      partner_id: PARTNER,
      canada_address: 'Toronto',
      flight_booked: false,
      shipping_address: null,
      got_visa: true,
      archived_at: null,
      country_code: 'IN',
      sim_number: null,
      commission_status: null,
      admin_note: null,
      viewed_at: null,
      ip_address: null,
    });

    // A retry of the submit replays it: the row is not written twice.
    const before = await orderFingerprint(leadId);
    const replay = await call(
      'PATCH',
      `/leads/${leadId}`,
      { submit: true },
      { 'x-draft-grant': grant, 'Idempotency-Key': `gcs-mirror-${leadId}` },
    );
    expect(replay).toMatchObject({ status: 200, body: { replayed: true } });
    expect(await orderFingerprint(leadId)).toBe(before);
  });

  test('a one-shot submitted order is copied at once; no phone and an unknown partner code are fine', async () => {
    const orderNo = await nextOrderNo();
    const created = await call('POST', '/leads', {
      leadType: 'sim_order',
      consentVersion: 'getcanadasim-order-2026-10',
      contact: { fullName: 'Mailed Sim', email: email('mailed') },
      form: {
        schemaVersion: 1,
        payload: { delivery: 'pickup', shippingAddress: '1 Bay St, Toronto ON' },
      },
      attribution: { partnerCode: 'friend-of-priya' },
      order: { planId: PLAN, quantity: 1 },
      submit: true,
    });
    expect(created.status).toBe(201);
    const leadId = createLeadResponseSchema.parse(created.body).lead.id;
    expect(await orderRow(leadId)).toMatchObject({
      order_no: String(orderNo),
      full_name: 'Mailed Sim',
      phone: '',
      delivery: 'pickup',
      shipping_address: '1 Bay St, Toronto ON',
      status: 'pending',
      partner_id: null,
      same_created_at: true,
    });
  });

  test('a rescued checkout is copied when staff move it on', async () => {
    const created = await leadStore.createLead({
      workspaceId: site,
      actorId: CREDENTIAL,
      requestId: randomUUID(),
      leadType: 'sim_order',
      consentVersion: 'ci',
      contact: { fullName: 'Ravi Rescued', email: email('ravi') },
      order: { planId: PLAN, quantity: 1 },
    });
    expect(await orderRow(created.lead.id)).toBeUndefined();
    const moved = await work.updateLead({
      workspaceId: site,
      actorId: STAFF,
      requestId: randomUUID(),
      leadId: created.lead.id,
      stage: 'pending',
      catalog: codePropertyCatalog,
    });
    expect(moved.status).toBe('updated');
    expect(await orderRow(created.lead.id)).toMatchObject({
      full_name: 'Ravi Rescued',
      status: 'pending',
      // The table's own default for a rescued draft that never chose.
      delivery: 'esim',
    });
  });

  test('a rescued order with no name or email is copied once staff complete them, and only once (#85)', async () => {
    // The customer gave neither before staff rescued the checkout.
    const created = await leadStore.createLead({
      workspaceId: site,
      actorId: CREDENTIAL,
      requestId: randomUUID(),
      leadType: 'sim_order',
      consentVersion: 'ci-gcs-mirror',
      order: { planId: PLAN, quantity: 1 },
    });
    const leadId = created.lead.id;
    const staffEdit = (input: Partial<Parameters<DatabaseLeadWorkStore['updateLead']>[0]>) =>
      work.updateLead({
        workspaceId: site,
        actorId: STAFF,
        requestId: randomUUID(),
        leadId,
        catalog: codePropertyCatalog,
        ...input,
      });
    expect((await staffEdit({ stage: 'pending' })).status).toBe('updated');
    expect(await orderRow(leadId)).toBeUndefined();

    // A name alone is not enough for the old table.
    expect((await staffEdit({ contact: { fullName: 'Nameless Rescued' } })).status).toBe('updated');
    expect(await orderRow(leadId)).toBeUndefined();

    // With the email the order becomes eligible and is copied, under its number.
    expect((await staffEdit({ contact: { email: email('nameless') } })).status).toBe('updated');
    const ref = await externalRef(leadId);
    expect(await orderRow(leadId)).toMatchObject({
      order_no: ref?.replace('MS-', ''),
      full_name: 'Nameless Rescued',
      email: email('nameless'),
      status: 'pending',
    });

    // The old admin works it; a later correction in the CRM never reaches it.
    await admin`update public.orders set admin_note = 'Called' where id = ${leadId}`;
    const worked = await orderFingerprint(leadId);
    expect((await staffEdit({ contact: { fullName: 'Renamed Rescued' } })).status).toBe('updated');
    await admin`update app.leads set email = null where id = ${leadId}`;
    await admin`update app.leads set email = ${email('nameless-2')} where id = ${leadId}`;
    expect(await orderFingerprint(leadId)).toBe(worked);
    const [count] = await admin<{ count: number }[]>`
      select count(*)::int as count from public.orders where order_no = ${Number(ref?.replace('MS-', ''))}
    `;
    expect(count?.count).toBe(1);
  });

  test('0048’s pass copies every submitted order skipped before it that now has a name and email, once (#85)', async () => {
    // Skipped by 0041 while nameless, completed before 0048 (its row is not there).
    const completed = await insertLead({ externalRef: `MS-${await nextOrderNo()}` });
    await admin`delete from public.orders where id = ${completed}`;
    // Still nameless: stays skipped.
    const nameless = await insertLead({
      externalRef: `MS-${await nextOrderNo()}`,
      fullName: null,
    });
    // Already in the old table and worked there: left as it is.
    const worked = await insertLead({ externalRef: `MS-${await nextOrderNo()}` });
    await admin`update public.orders set status = 'verified', admin_note = 'Mine' where id = ${worked}`;
    const workedBefore = await orderFingerprint(worked);

    await admin.unsafe(backfillBlock(ELIGIBLE_MIGRATION_SQL));
    expect(await orderRow(completed)).toMatchObject({
      full_name: 'Direct Insert',
      status: 'pending',
      same_created_at: true,
    });
    expect(await orderRow(nameless)).toBeUndefined();
    expect(await orderFingerprint(worked)).toBe(workedBefore);

    // Run again: nothing changes.
    const copied = await orderFingerprint(completed);
    await admin.unsafe(backfillBlock(ELIGIBLE_MIGRATION_SQL));
    expect(await orderFingerprint(completed)).toBe(copied);
    expect(await orderFingerprint(worked)).toBe(workedBefore);
    expect(await orderRow(nameless)).toBeUndefined();
  });

  test('after the copy the old admin’s edits stay: the CRM never writes the row again', async () => {
    const created = await call('POST', '/leads', {
      leadType: 'sim_order',
      consentVersion: 'getcanadasim-order-2026-10',
      contact: { fullName: 'Edited There', email: email('edited'), phone: '647 555 0100' },
      form: { schemaVersion: 1, payload: { delivery: 'esim', planId: '75gb-fido' } },
      order: { planId: PLAN, quantity: 1 },
      submit: true,
    });
    const leadId = createLeadResponseSchema.parse(created.body).lead.id;
    // The old admin works the order.
    await admin`
      update public.orders
      set status = 'verified', admin_note = 'Called, visa fine', admin_note_at = now(),
          phone = '647 555 0199', viewed_at = now()
      where id = ${leadId}
    `;
    const edited = await orderFingerprint(leadId);

    // The CRM works it too: a stage move, a contact edit, and the archive.
    const move = await work.updateLead({
      workspaceId: site,
      actorId: STAFF,
      requestId: randomUUID(),
      leadId,
      stage: 'cancelled',
      catalog: codePropertyCatalog,
    });
    expect(move.status).toBe('updated');
    await admin`
      update app.leads set full_name = 'Renamed Here', phone = '000', deleted_at = now()
      where id = ${leadId}
    `;
    // A status flip back and forth is no second copy either.
    await admin`update app.leads set status = 'incomplete' where id = ${leadId}`;
    await admin`update app.leads set status = 'submitted' where id = ${leadId}`;
    await admin.unsafe(backfillBlock());

    expect(await orderFingerprint(leadId)).toBe(edited);
    expect(await orderRow(leadId)).toMatchObject({
      full_name: 'Edited There',
      phone: '647 555 0199',
      status: 'verified',
      admin_note: 'Called, visa fine',
      archived_at: null,
    });
  });

  test('a lead whose id is already in public.orders leaves that row as it is', async () => {
    const id = randomUUID();
    const orderNo = (await nextOrderNo()) + 5;
    await admin`
      insert into public.orders (id, order_no, full_name, email, phone, delivery, status, admin_note)
      values (${id}, ${orderNo}, 'Old Checkout', ${email('old')}, '111', 'esim', 'on_hold', 'Keep me')
    `;
    const before = await orderFingerprint(id);
    // The import's insert of the same order, under its own id and number.
    await insertLead({ id, externalRef: `MS-${orderNo}`, fullName: 'Old Checkout' });
    expect(await orderFingerprint(id)).toBe(before);
  });

  test('an order number the old table already holds is skipped, and the CRM still saves the order', async () => {
    const orderNo = await nextOrderNo();
    const squatter = randomUUID();
    await admin`
      insert into public.orders (id, order_no, full_name, email, phone, delivery)
      values (${squatter}, ${orderNo}, 'Old Number', ${email('squatter')}, '222', 'esim')
    `;
    const before = await orderFingerprint(squatter);
    const created = await call('POST', '/leads', {
      leadType: 'sim_order',
      consentVersion: 'getcanadasim-order-2026-10',
      contact: { fullName: 'Same Number', email: email('same-number') },
      form: { schemaVersion: 1, payload: { delivery: 'esim' } },
      order: { planId: PLAN, quantity: 1 },
      submit: true,
    });
    expect(created.status).toBe(201);
    const leadId = createLeadResponseSchema.parse(created.body).lead.id;
    expect(await externalRef(leadId)).toBe(`MS-${orderNo}`);
    expect(await orderRow(leadId)).toBeUndefined();
    expect(await orderFingerprint(squatter)).toBe(before);
  });

  test('a legacy-side error or a lead the old table cannot hold never fails the CRM’s write', async () => {
    // A SIM number past the old column's 40 characters fails its check.
    const tooLong = await insertLead({
      externalRef: `MS-${await nextOrderNo()}`,
      payload: { delivery: 'esim', simNumber: '9'.repeat(41) },
    });
    // No name: the old table requires one.
    const nameless = await insertLead({
      externalRef: `MS-${await nextOrderNo()}`,
      fullName: null,
    });
    const leads = await admin<{ id: string }[]>`
      select id from app.leads where id in (${tooLong}, ${nameless})
    `;
    expect(leads).toHaveLength(2);
    expect(await orderRow(tooLong)).toBeUndefined();
    expect(await orderRow(nameless)).toBeUndefined();
  });

  test('other sites, other lead types, drafts and references the website chose are left alone', async () => {
    const otherSite = await insertLead({
      workspaceId: OTHER_SITE,
      externalRef: `MS-${await nextOrderNo()}`,
    });
    const partnerApplication = await insertLead({
      leadType: 'partner_application',
      stage: 'new',
      externalRef: `MS-${await nextOrderNo()}`,
    });
    const draft = await insertLead({
      status: 'incomplete',
      stage: 'incomplete',
      externalRef: `MS-${await nextOrderNo()}`,
    });
    const ownRef = await insertLead({ externalRef: 'GCS-ORDER-1' });
    const unnumbered = await insertLead({ externalRef: null });
    const rows = await admin`
      select id from public.orders
      where id in (${otherSite}, ${partnerApplication}, ${draft}, ${ownRef}, ${unnumbered})
    `;
    expect(rows).toHaveLength(0);
  });

  test('the backfill copies only the submitted orders that are missing, through the same mapping', async () => {
    const worked = await insertLead({
      externalRef: `MS-${await nextOrderNo()}`,
      stage: 'verified',
      phone: '647 555 0111',
      payload: { delivery: 'esim', simNumber: '8912000000000000001' },
      orderDetails: {
        planId: PLAN,
        plan: { properties: { custom_website_slug: '75gb-chatr' } },
        paymentStatus: 'paid',
        carrierCommission: 'received',
      },
      attribution: { partnerCode: 'PT-7' },
    });
    const archived = await insertLead({
      externalRef: `MS-${await nextOrderNo()}`,
      stage: 'cancelled',
      deletedAt: '2026-11-15T10:00:00Z',
    });
    const present = await insertLead({ externalRef: `MS-${await nextOrderNo()}` });
    const draft = await insertLead({
      status: 'incomplete',
      stage: 'incomplete',
      externalRef: `MS-${await nextOrderNo()}`,
    });
    // As before 0041: the orders the CRM took since the switch are not in the old table.
    await admin`delete from public.orders where id in (${worked}, ${archived})`;
    await admin`update public.orders set status = 'delivered' where id = ${present}`;
    const presentBefore = await orderFingerprint(present);

    await admin.unsafe(backfillBlock());
    expect(await orderRow(worked)).toMatchObject({
      status: 'verified',
      phone: '647 555 0111',
      plan: '75gb-chatr',
      sim_number: '8912000000000000001',
      commission_status: 'commission_received',
      partner_id: PARTNER,
      same_created_at: true,
    });
    expect(await orderRow(archived)).toMatchObject({ status: 'cancelled' });
    expect((await orderRow(archived))?.archived_at?.toISOString()).toBe('2026-11-15T10:00:00.000Z');
    expect(await orderFingerprint(present)).toBe(presentBefore);
    expect(await orderRow(draft)).toBeUndefined();

    // Run again: nothing changes.
    const fingerprints = [await orderFingerprint(worked), await orderFingerprint(archived)];
    await admin.unsafe(backfillBlock());
    expect([await orderFingerprint(worked), await orderFingerprint(archived)]).toEqual(
      fingerprints,
    );
  });

  test('without public.orders the mirror and the backfill do nothing', async () => {
    await dropGetCanadaSimTables(admin);
    try {
      const created = await call('POST', '/leads', {
        leadType: 'sim_order',
        consentVersion: 'getcanadasim-order-2026-10',
        contact: { fullName: 'No Legacy', email: email('no-legacy') },
        form: { schemaVersion: 1, payload: { delivery: 'esim' } },
        order: { planId: PLAN, quantity: 1 },
        submit: true,
      });
      expect(created.status).toBe(201);
      await expect(admin.unsafe(backfillBlock())).resolves.toBeDefined();
    } finally {
      await admin.unsafe(GCS_TABLES_DDL);
    }
  });
});
