import type { Server } from 'node:http';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  LEAD_EXPORT_CONTENT_TYPE,
  apiErrorResponseSchema,
  type ExportLeadsRequest,
  type LeadExportFilter,
} from '@gt-sales/contracts';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';
import type { StaffRoleName } from '@gt-sales/types';
import { z } from 'zod';

import { createApp } from '../src/app.js';
import { DatabaseLeadExportStore } from '../src/leads/export/store.js';
import { DatabaseLeadStore } from '../src/leads/store.js';
import { DatabasePropertyStore } from '../src/properties/store.js';
import type { StaffAccessSnapshot } from '../src/staff/authorization.js';
import type { StaffStore } from '../src/staff/store.js';
import type { WebsiteCredentialStore } from '../src/website/store.js';
import { headersOf, readXlsx, rowByHeader, serialToDate, type ReadSheet } from './support/xlsx.js';

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

// A distinct id range for the leads export.
const SITE = '17000000-0000-4000-8000-00000000e901';
const OTHER_SITE = '17000000-0000-4000-8000-00000000e902';
const ACTOR = '27000000-0000-4000-8000-00000000e901';
const COLLEAGUE = '27000000-0000-4000-8000-00000000e902';
const FORMER = '27000000-0000-4000-8000-00000000e903';
const MEMBERSHIP = '37000000-0000-4000-8000-00000000e901';
const PLAN = '47000000-0000-4000-8000-00000000e901';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';

type Json = Parameters<ReturnType<typeof postgres>['json']>[0];
type JsonObject = Record<string, Json>;

const lead = (n: number) => `97000000-0000-4000-8000-00000000e9${String(n).padStart(2, '0')}`;
const SIM_ADA = lead(1);
const SIM_FORMULA = lead(2);
const SIM_PLAIN = lead(3);
const SIM_ARCHIVED = lead(4);
const SIM_RESTRICTED = lead(5);
const NET_ONE = lead(6);
const NET_TWO = lead(7);
const OTHER_SITE_LEAD = lead(8);

/** Text a customer wrote, which an audit row or a log must never hold. */
const CUSTOMER_TEXT = ['Ada Example', 'ada@example.test', '604 555 0100', '12 Maple Street'];

databaseTest('leads export (POST /leads/export against the database)', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let server: Server;
  let baseUrl: string;
  let leadStore: DatabaseLeadStore;
  let propertyStore: DatabasePropertyStore;

  const access: StaffAccessSnapshot = {
    membershipId: MEMBERSHIP,
    status: 'active',
    roles: ['owner'],
    permissions: [],
  };
  const as = (role: StaffRoleName, permissions: StaffAccessSnapshot['permissions'] = []) => {
    access.roles = [role];
    access.permissions = permissions;
  };

  const staffStore: StaffStore = {
    bootstrapStaff: async () => [],
    loadStaffAccess: async (actorId, workspaceId) =>
      actorId === ACTOR && (workspaceId === SITE || workspaceId === OTHER_SITE)
        ? { ...access }
        : undefined,
    inviteStaff: async () => {
      throw new Error('unused');
    },
    revokeStaff: async () => 'not_found',
    listAssignableMembers: async () => [],
    setDisplayName: async () => 0,
  };
  const noopCredentialStore: WebsiteCredentialStore = {
    createCredential: async () => {
      throw new Error('unused');
    },
    listCredentials: async () => [],
    revokeCredential: async () => ({ status: 'not_found' }),
  };

  const insertLead = async (input: {
    id: string;
    workspaceId?: string;
    leadType: string;
    stage: string;
    status?: string;
    fullName?: string;
    email?: string;
    phone?: string;
    externalRef: string;
    assignee?: string;
    payload?: JsonObject;
    custom?: JsonObject;
    order?: JsonObject;
    attribution?: JsonObject;
    createdAt: string;
    archived?: boolean;
    restricted?: boolean;
  }) => {
    await admin`
      insert into app.leads (
        id, workspace_id, lead_type, status, stage, full_name, email, phone, external_ref,
        assigned_actor_id, consent_version, attribution, payload, custom_values, order_details,
        created_at, updated_at, deleted_at, customer_data_restricted_at
      ) values (
        ${input.id}, ${input.workspaceId ?? SITE}, ${input.leadType},
        ${input.status ?? 'submitted'}, ${input.stage},
        ${input.fullName ?? null}, ${input.email ?? null}, ${input.phone ?? null},
        ${input.externalRef}, ${input.assignee ?? null}, 'ci',
        ${admin.json(input.attribution ?? {})},
        ${admin.json({ schemaVersion: 1, payload: input.payload ?? {} })},
        ${admin.json(input.custom ?? {})},
        ${admin.json(input.order ?? {})},
        ${input.createdAt}, ${input.createdAt},
        ${input.archived ? new Date() : null},
        ${input.restricted ? new Date() : null}
      )
    `;
  };

  const frozenPlan = {
    planId: PLAN,
    name: 'Unlimited 40',
    priceMinor: 4000,
    currency: 'CAD',
    billingPeriod: 'month',
    paymentRequired: true,
    requiredDocuments: [],
    properties: {},
    commission: { type: 'fixed', amountMinor: 1500 },
    frozenAt: '2026-11-01T10:00:00.000Z',
  };

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });

    await admin`delete from app.workspaces where id in (${SITE}, ${OTHER_SITE})`;
    await admin`
      insert into app.workspaces (id, slug, name)
      values (${SITE}, 'export-site-e901', 'Export Site'),
             (${OTHER_SITE}, 'export-site-e902', 'Export Other')
    `;
    await admin`
      insert into app.memberships (workspace_id, user_id, membership_type, status, display_name, accepted_at)
      values (${SITE}, ${ACTOR}, 'staff', 'active', 'Olive Owner', now()),
             (${SITE}, ${COLLEAGUE}, 'staff', 'active', 'Sam Staff', now())
    `;
    await admin`
      insert into app.properties (workspace_id, object, key, origin, label, kind, position, sensitive, hidden)
      values (${SITE}, 'lead', 'custom_loyalty', 'custom', 'Loyalty number', 'text', 1, false, false),
             (${SITE}, 'lead', 'custom_budget', 'custom', 'Budget', 'money', 2, false, false),
             (${SITE}, 'lead', 'custom_passport', 'custom', 'Passport number', 'text', 3, true, false),
             (${SITE}, 'lead', 'custom_gone', 'custom', 'Hidden one', 'text', 4, false, true)
    `;

    await insertLead({
      id: SIM_ADA,
      leadType: 'sim_order',
      stage: 'pending',
      fullName: 'Ada Example',
      email: 'ada@example.test',
      phone: '+1 604 555 0100',
      externalRef: 'MS-0101',
      assignee: COLLEAGUE,
      payload: {
        delivery: 'pickup',
        arrivalDate: '2026-12-01',
        permitType: 'student',
        gotVisa: true,
        shippingAddress: '12 Maple Street\nVancouver BC V5K 0A1',
        simNumber: '8912345678901234567',
      },
      custom: {
        custom_loyalty: '000123',
        custom_budget: 12550,
        custom_passport: 'P1234567',
        custom_gone: 'not shown',
      },
      order: {
        planId: PLAN,
        plan: frozenPlan,
        quantity: 2,
        paymentStatus: 'paid',
        carrierCommission: 'invoiced',
        courier: 'Canada Post',
        trackingNumber: '00123456789012345678',
        dispatchedAt: '2026-11-03',
      },
      attribution: {
        utmSource: 'google',
        utmMedium: 'cpc',
        utmCampaign: 'fall',
        partnerCode: 'MAPLE10',
      },
      createdAt: '2026-11-03T10:20:30.000Z',
    });
    await insertLead({
      id: SIM_FORMULA,
      leadType: 'sim_order',
      stage: 'verified',
      fullName: '=HYPERLINK("http://evil.test","Click")',
      email: 'formula@example.test',
      phone: '-1+cmd|calc',
      externalRef: 'MS-0102',
      assignee: FORMER,
      payload: { canadaAddress: '@SUM(1+1)', reference: '+cmd' },
      createdAt: '2026-11-02T10:00:00.000Z',
    });
    await insertLead({
      id: SIM_PLAIN,
      leadType: 'sim_order',
      stage: 'pending',
      status: 'incomplete',
      externalRef: 'MS-0103',
      createdAt: '2026-11-01T10:00:00.000Z',
    });
    await insertLead({
      id: SIM_ARCHIVED,
      leadType: 'sim_order',
      stage: 'cancelled',
      fullName: 'Archie Archived',
      externalRef: 'MS-0104',
      createdAt: '2026-10-30T10:00:00.000Z',
      archived: true,
    });
    await insertLead({
      id: SIM_RESTRICTED,
      leadType: 'sim_order',
      stage: 'pending',
      fullName: 'Rhea Restricted',
      externalRef: 'MS-0105',
      createdAt: '2026-10-29T10:00:00.000Z',
      restricted: true,
    });
    await insertLead({
      id: NET_ONE,
      leadType: 'internet',
      stage: 'new',
      fullName: 'Ned Net',
      email: 'ned@example.test',
      phone: '4035550111',
      externalRef: 'CW-1',
      payload: {
        planId: 'ab-1gbps',
        planLabel: '1Gbps + TV',
        dateOfBirth: '1990-04-05',
        streetAddress: '9 Elm Road',
        city: 'Calgary',
        postalCode: 'T2P 1J9',
        consent: true,
        consentedAt: '2026-11-02T09:00:00.000Z',
      },
      createdAt: '2026-11-02T09:00:00.000Z',
    });
    await insertLead({
      id: NET_TWO,
      leadType: 'internet',
      stage: 'new',
      fullName: 'Nia Net',
      externalRef: 'CW-2',
      payload: { planId: 'ab-1gbps', planLabel: '1Gbps + TV', city: 'Edmonton' },
      createdAt: '2026-11-01T09:00:00.000Z',
    });
    await insertLead({
      id: OTHER_SITE_LEAD,
      workspaceId: OTHER_SITE,
      leadType: 'sim_order',
      stage: 'pending',
      fullName: 'Otto Other',
      externalRef: 'MS-9999',
      createdAt: '2026-11-03T12:00:00.000Z',
    });

    await admin`
      insert into app.lead_tasks (workspace_id, lead_id, title, due_at, created_by)
      values (${SITE}, ${SIM_ADA}, 'Call Ada', '2026-11-14T12:00:00Z', ${ACTOR}),
             (${SITE}, ${SIM_ADA}, 'Send SIM', '2026-11-20T12:00:00Z', ${ACTOR})
    `;
    await admin`
      insert into app.lead_activities (workspace_id, lead_id, actor_id, kind, body, data, created_at)
      values (${SITE}, ${SIM_ADA}, ${ACTOR}, 'note', 'Ada Example called about 12 Maple Street', null, '2026-11-04T08:00:00Z'),
             (${SITE}, ${SIM_ADA}, ${ACTOR}, 'note', 'second note', null, '2026-11-05T08:00:00Z'),
             (${SITE}, ${SIM_ADA}, ${ACTOR}, 'status_change', null, ${admin.json({ from: 'incomplete', to: 'pending' })}, '2026-11-04T09:30:00Z')
    `;

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({ connectionString: runtimeUrl.toString(), ssl: false });
    leadStore = new DatabaseLeadStore(database);
    propertyStore = new DatabasePropertyStore(database);

    server = createApp({
      staff: {
        sessionVerifier: {
          verify: async () => ({ actorId: ACTOR, verifiedEmail: 'owner@example.test' }),
        },
        store: staffStore,
        credentialStore: noopCredentialStore,
        leadStore,
        propertyStore,
        // A cap of five leads, so the refusal is tested without thousands of rows.
        leadExportStore: new DatabaseLeadExportStore(database, 5),
        // A 500 in these tests should say why.
        errorTracker: { captureException: (error) => console.error(error) },
      },
    }).listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected TCP server');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await database?.close();
    await admin?.end();
  });

  beforeEach(async () => {
    as('owner');
    await admin`delete from app.audit_events where workspace_id in (${SITE}, ${OTHER_SITE}) and action = 'lead.exported'`;
  });

  function post(body: ExportLeadsRequest, workspaceId = SITE) {
    return fetch(`${baseUrl}/api/v1/staff/workspaces/${workspaceId}/leads/export`, {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function exportSheets(body: ExportLeadsRequest): Promise<{
    sheets: ReadSheet[];
    response: Response;
  }> {
    const response = await post(body);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(LEAD_EXPORT_CONTENT_TYPE);
    return { sheets: readXlsx(new Uint8Array(await response.arrayBuffer())), response };
  }

  const references = (sheet: ReadSheet) => sheet.rows.slice(1).map((row) => row[0]?.raw ?? '');

  const byFilter = (filter: LeadExportFilter, fields: string[] = []): ExportLeadsRequest => ({
    scope: { kind: 'filter', filter },
    fields,
  });

  const audits = () =>
    admin<{ actor_id: string; entity: string; entity_id: string; after: unknown }[]>`
      select actor_id, entity, entity_id, after from app.audit_events
      where workspace_id = ${SITE} and action = 'lead.exported' order by created_at
    `;

  /** Every lead the list shows for the filters, over all its pages, by reference. */
  async function listedReferences(filter: LeadExportFilter): Promise<string[]> {
    const catalog = await propertyStore.catalog({
      workspaceId: SITE,
      actorId: ACTOR,
      requestId: SITE,
    });
    const found: string[] = [];
    for (let page = 1; ; page += 1) {
      const result = await leadStore.listLeads({
        workspaceId: SITE,
        actorId: ACTOR,
        catalog,
        status: filter.status,
        leadType: filter.type,
        stage: filter.stage,
        assignee: filter.assignee,
        search: filter.q,
        view: filter.view,
        dueBy: filter.dueBy,
        where: filter.where,
        sort: filter.sort,
        page,
        pageSize: 2,
      });
      found.push(...result.leads.map((entry) => entry.externalRef ?? ''));
      if (found.length >= result.page.total) return found;
    }
  }

  test('an owner exports one type: the main fields, then the chosen ones, typed', async () => {
    const { sheets, response } = await exportSheets(
      byFilter({ type: 'sim_order' }, [
        'prop.arrivalDate',
        'prop.delivery',
        'prop.gotVisa',
        'prop.shippingAddress',
        'prop.simNumber',
        'prop.custom_loyalty',
        'prop.custom_budget',
        'prop.quantity',
        'prop.courier',
        'prop.trackingNumber',
        'prop.dispatchedAt',
        'planPrice',
        'planBillingPeriod',
        'planCommission',
        'updatedAt',
        'stageChangedAt',
        'lastActivityAt',
        'source',
        'utmCampaign',
        'partnerCode',
        'openTaskCount',
        'nextTaskDueAt',
        'noteCount',
      ]),
    );
    expect(response.headers.get('content-disposition')).toMatch(
      /^attachment; filename="export-site-e901-leads-sim-order-\d{4}-\d{2}-\d{2}\.xlsx"$/,
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-export-row-count')).toBe('3');

    expect(sheets).toHaveLength(1);
    const [sheet] = sheets;
    if (!sheet) throw new Error('expected a sheet');
    expect(sheet.name).toBe('SIM order');
    expect(headersOf(sheet)).toEqual([
      'Order / lead number',
      'Created (UTC)',
      'Lead type',
      'Name',
      'Email',
      'Phone',
      'Stage',
      'Status',
      'Assigned to',
      'Plan',
      'Payment status',
      'SIM type',
      'Arrival in Canada',
      'Has the visa',
      'Shipping address',
      'SIM number',
      'Loyalty number',
      'Budget',
      'Quantity',
      'Courier',
      'Tracking number',
      'Dispatched on',
      'Plan price (CAD)',
      'Billing period',
      'Commission (CAD)',
      'Updated (UTC)',
      'Stage changed (UTC)',
      'Last activity (UTC)',
      'Source',
      'UTM campaign',
      'Partner code',
      'Open tasks',
      'Next task due',
      'Notes',
    ]);
    expect(sheet.rows[0]?.every((cell) => cell?.bold)).toBe(true);
    expect(sheet.frozenRows).toBe(1);
    expect(sheet.autoFilter).toBe('A1:AH4');

    // The list's default order: newest activity first.
    expect(references(sheet)).toEqual(['MS-0101', 'MS-0102', 'MS-0103']);

    const ada = rowByHeader(sheet, 0);
    const textOf = (header: string) => {
      const cell = ada[header];
      expect(cell?.type, header).toBe('s');
      return cell?.raw;
    };
    expect(textOf('Order / lead number')).toBe('MS-0101');
    expect(textOf('Lead type')).toBe('SIM order');
    expect(textOf('Name')).toBe('Ada Example');
    expect(textOf('Email')).toBe('ada@example.test');
    expect(textOf('Phone')).toBe('+1 604 555 0100');
    expect(textOf('Stage')).toBe('Pending');
    expect(textOf('Status')).toBe('Submitted');
    expect(textOf('Assigned to')).toBe('Sam Staff');
    expect(textOf('Plan')).toBe('Unlimited 40');
    expect(textOf('Payment status')).toBe('Paid');
    expect(textOf('SIM type')).toBe('Physical SIM (mailed)');
    expect(textOf('Has the visa')).toBe('Yes');
    expect(textOf('Shipping address')).toBe('12 Maple Street\nVancouver BC V5K 0A1');
    // Numbers that are not quantities stay text: no lost zeros, no 8.91E+18.
    expect(textOf('SIM number')).toBe('8912345678901234567');
    expect(textOf('Loyalty number')).toBe('000123');
    expect(textOf('Tracking number')).toBe('00123456789012345678');
    expect(textOf('Courier')).toBe('Canada Post');
    expect(textOf('Billing period')).toBe('Monthly');
    expect(textOf('Source')).toBe('partner:MAPLE10 (unmatched)');
    expect(textOf('UTM campaign')).toBe('fall');
    expect(textOf('Partner code')).toBe('MAPLE10');

    // Dates are real dates (a number with a date format), in UTC.
    expect(ada['Created (UTC)']).toMatchObject({ type: 'n', format: 'yyyy-mm-dd hh:mm' });
    expect(serialToDate(ada['Created (UTC)']?.raw ?? '').toISOString()).toBe(
      '2026-11-03T10:20:30.000Z',
    );
    expect(ada['Arrival in Canada']).toMatchObject({ type: 'n', format: 'yyyy-mm-dd' });
    expect(serialToDate(ada['Arrival in Canada']?.raw ?? '').toISOString()).toBe(
      '2026-12-01T00:00:00.000Z',
    );
    expect(serialToDate(ada['Dispatched on']?.raw ?? '').toISOString()).toBe(
      '2026-11-03T00:00:00.000Z',
    );
    expect(serialToDate(ada['Stage changed (UTC)']?.raw ?? '').toISOString()).toBe(
      '2026-11-04T09:30:00.000Z',
    );
    expect(serialToDate(ada['Last activity (UTC)']?.raw ?? '').toISOString()).toBe(
      '2026-11-05T08:00:00.000Z',
    );
    expect(serialToDate(ada['Next task due']?.raw ?? '').toISOString()).toBe(
      '2026-11-14T00:00:00.000Z',
    );

    // Numbers are numbers; money is dollars.
    expect(ada['Quantity']).toMatchObject({ type: 'n', raw: '2' });
    expect(ada['Open tasks']).toMatchObject({ type: 'n', raw: '2' });
    expect(ada['Notes']).toMatchObject({ type: 'n', raw: '2' });
    expect(ada['Budget']).toMatchObject({ type: 'n', raw: '125.5', format: '#,##0.00' });
    expect(ada['Plan price (CAD)']).toMatchObject({ type: 'n', raw: '40', format: '#,##0.00' });
    // $15.00 a unit, twice.
    expect(ada['Commission (CAD)']).toMatchObject({ type: 'n', raw: '30', format: '#,##0.00' });

    // A lead with nothing filled in leaves its cells empty, and an incomplete one says so.
    const plain = rowByHeader(sheet, 2);
    expect(plain['Name']).toBeUndefined();
    expect(plain['Status']?.raw).toBe('Incomplete');
    expect(plain['Assigned to']).toBeUndefined();
    expect(plain['Notes']).toMatchObject({ type: 'n', raw: '0' });
  });

  test('customer text that would run as a formula is written as marked text', async () => {
    const { sheets } = await exportSheets(
      byFilter({ type: 'sim_order' }, ['prop.canadaAddress', 'prop.reference']),
    );
    const sheet = sheets[0];
    if (!sheet) throw new Error('expected a sheet');
    const row = rowByHeader(sheet, 1);
    expect(row['Name']).toMatchObject({
      type: 's',
      raw: '\'=HYPERLINK("http://evil.test","Click")',
      formula: false,
    });
    expect(row['Phone']).toMatchObject({ type: 's', raw: "'-1+cmd|calc", formula: false });
    expect(row['Address in Canada / City']).toMatchObject({ type: 's', raw: "'@SUM(1+1)" });
    expect(row['Order / lead number']).toMatchObject({ type: 's', raw: 'MS-0102' });
    expect(row['Reference']).toMatchObject({ type: 's', raw: "'+cmd" });
    // A member who has left is named as the inbox names one.
    expect(row['Assigned to']?.raw).toBe('Former teammate');
    expect(sheet.rows.flat().some((cell) => cell?.formula)).toBe(false);
  });

  test('a sensitive, hidden or unknown field is never written, whoever asks', async () => {
    const { sheets } = await exportSheets(
      byFilter({ type: 'internet' }, [
        'prop.dateOfBirth',
        'prop.city',
        'prop.custom_passport',
        'prop.custom_gone',
        'prop.custom_loyalty',
        'prop.nothing',
        'sinMasked',
        'identities',
        'documents',
      ]),
    );
    const sheet = sheets[0];
    if (!sheet) throw new Error('expected a sheet');
    expect(headersOf(sheet)).toEqual([
      'Order / lead number',
      'Created (UTC)',
      'Lead type',
      'Name',
      'Email',
      'Phone',
      'Stage',
      'Status',
      'Assigned to',
      'Plan',
      'Payment status',
      'City',
      'Loyalty number',
    ]);
    const text = JSON.stringify(sheet.rows);
    expect(text).not.toContain('1990-04-05');
    expect(text).not.toContain('P1234567');
    expect(text).not.toContain('not shown');
    // A phone typed as digits is still text.
    expect(rowByHeader(sheet, 0)['Phone']).toMatchObject({ type: 's', raw: '4035550111' });
  });

  test('every type gets its own sheet when the export spans types', async () => {
    const { sheets, response } = await exportSheets(
      byFilter({}, ['prop.arrivalDate', 'prop.city', 'prop.custom_loyalty']),
    );
    expect(response.headers.get('content-disposition')).toMatch(
      /filename="export-site-e901-leads-all-\d{4}-\d{2}-\d{2}\.xlsx"/,
    );
    expect(response.headers.get('x-export-row-count')).toBe('5');
    expect(sheets.map((sheet) => sheet.name)).toEqual(['Internet', 'SIM order']);
    const [internet, sim] = sheets;
    if (!internet || !sim) throw new Error('expected two sheets');
    // Each sheet carries only the form fields its own type has.
    expect(headersOf(internet)).toContain('City');
    expect(headersOf(internet)).not.toContain('Arrival in Canada');
    expect(headersOf(sim)).toContain('Arrival in Canada');
    expect(headersOf(sim)).not.toContain('City');
    expect(headersOf(sim)).toContain('Loyalty number');
    expect(references(internet)).toEqual(['CW-1', 'CW-2']);
    expect(references(sim)).toEqual(['MS-0101', 'MS-0102', 'MS-0103']);
  });

  test('the filters select exactly what the list shows, over all its pages and in its order', async () => {
    const filters: LeadExportFilter[] = [
      { type: 'sim_order' },
      { type: 'sim_order', stage: 'pending' },
      { type: 'sim_order', sort: 'createdAt:asc' },
      { type: 'sim_order', sort: 'fullName:asc' },
      { type: 'sim_order', q: 'ada' },
      { type: 'sim_order', q: '6045550100' },
      { type: 'sim_order', assignee: COLLEAGUE },
      { type: 'sim_order', assignee: 'none' },
      { type: 'sim_order', status: 'incomplete' },
      { type: 'sim_order', dueBy: '2026-11-15' },
      { type: 'sim_order', where: [{ key: 'permitType', op: 'eq', value: 'student' }] },
      { type: 'sim_order', where: [{ key: 'paymentStatus', op: 'eq', value: 'paid' }] },
      { type: 'sim_order', where: [{ key: 'custom_loyalty', op: 'notEmpty' }] },
      { type: 'sim_order', sort: 'prop.arrivalDate:desc' },
      { type: 'internet', where: [{ key: 'city', op: 'contains', value: 'gar' }] },
      { view: 'archived' },
      { type: 'sim_order', stage: 'activated' },
    ];
    for (const filter of filters) {
      const { sheets } = await exportSheets(byFilter(filter));
      const exportedRefs = sheets.flatMap(references);
      const listed = await listedReferences(filter);
      expect(exportedRefs, JSON.stringify(filter)).toEqual(listed);
    }
    // Restricted leads are in neither; the archive only when asked for.
    const { sheets: archive } = await exportSheets(byFilter({ view: 'archived' }));
    expect(archive.flatMap(references)).toEqual(['MS-0104']);
    // No lead at all is still a file, with the type's headers.
    const { sheets: none, response } = await exportSheets(
      byFilter({ type: 'sim_order', stage: 'activated' }),
    );
    expect(response.headers.get('x-export-row-count')).toBe('0');
    expect(none.map((sheet) => sheet.name)).toEqual(['SIM order']);
    expect(none[0]?.rows).toHaveLength(1);
  });

  test('ticked leads: only those, and none from another site, restricted or unknown', async () => {
    const { sheets } = await exportSheets({
      scope: { kind: 'ids', ids: [SIM_PLAIN, NET_ONE, SIM_ARCHIVED] },
      fields: [],
    });
    expect(sheets.map((sheet) => sheet.name)).toEqual(['Internet', 'SIM order']);
    expect(sheets.flatMap(references)).toEqual(['CW-1', 'MS-0103', 'MS-0104']);

    for (const foreign of [OTHER_SITE_LEAD, SIM_RESTRICTED, lead(99)]) {
      const response = await post({
        scope: { kind: 'ids', ids: [SIM_PLAIN, foreign] },
        fields: [],
      });
      expect(response.status).toBe(404);
      expect(apiErrorResponseSchema.parse(await response.json()).error).toMatchObject({
        code: 'lead_not_found',
        details: { missing: 1 },
      });
    }
    // The other site's lead is exported only through that site, by its own member.
    const elsewhere = await post(
      { scope: { kind: 'ids', ids: [SIM_PLAIN] }, fields: [] },
      OTHER_SITE,
    );
    expect(elsewhere.status).toBe(404);
    // Only the first, successful export left an audit event.
    expect(await audits()).toHaveLength(1);
  });

  test('a role sees in the file what it sees in the app', async () => {
    const everything = [
      'prop.arrivalDate',
      'prop.custom_loyalty',
      'prop.quantity',
      'planPrice',
      'planCommission',
      'updatedAt',
      'stageChangedAt',
      'source',
      'openTaskCount',
      'noteCount',
    ];
    // Leads, Orders and Finance see contacts, forms and orders, but not money.
    for (const role of ['leads', 'orders', 'finance'] as const) {
      as(role);
      const { sheets } = await exportSheets(byFilter({ type: 'sim_order' }, everything));
      const [first] = sheets;
      if (!first) throw new Error('expected a sheet');
      const headers = headersOf(first);
      expect(headers, role).toContain('Name');
      expect(headers, role).toContain('Plan price (CAD)');
      expect(headers, role).not.toContain('Commission (CAD)');
    }

    // The individual permission lets a read-only role export what the list shows it: no contact,
    // form, custom or order column, and nothing read from the timeline.
    as('viewer', [{ name: 'bulk_export', effect: 'allow' }]);
    const { sheets } = await exportSheets(byFilter({ type: 'sim_order' }, everything));
    const sheet = sheets[0];
    if (!sheet) throw new Error('expected a sheet');
    expect(headersOf(sheet)).toEqual([
      'Order / lead number',
      'Created (UTC)',
      'Lead type',
      'Stage',
      'Status',
      'Assigned to',
      'Updated (UTC)',
      'Source',
      'Open tasks',
    ]);
    const text = JSON.stringify(sheet.rows);
    for (const value of [...CUSTOMER_TEXT, 'Unlimited 40', '000123', '2026-12-01']) {
      expect(text).not.toContain(value);
    }

    // Without the permission the same role is refused, and a deny refuses a role that has it.
    as('viewer');
    expect((await post(byFilter({ type: 'sim_order' }))).status).toBe(403);
    as('leads', [{ name: 'bulk_export', effect: 'deny' }]);
    expect((await post(byFilter({ type: 'sim_order' }))).status).toBe(403);
  });

  test('more leads than the cap is refused whole, with the count', async () => {
    const extra = lead(20);
    await insertLead({
      id: extra,
      leadType: 'internet',
      stage: 'new',
      externalRef: 'CW-3',
      createdAt: '2026-10-28T09:00:00.000Z',
    });
    try {
      const response = await post(byFilter({}));
      expect(response.status).toBe(422);
      expect(apiErrorResponseSchema.parse(await response.json()).error).toMatchObject({
        code: 'export_too_large',
        details: { total: 6, max: 5 },
      });
      // Ticked leads are held to the same cap.
      const ticked = await post({
        scope: { kind: 'ids', ids: [SIM_ADA, SIM_FORMULA, SIM_PLAIN, NET_ONE, NET_TWO, extra] },
        fields: [],
      });
      expect(ticked.status).toBe(422);
      expect(await audits()).toHaveLength(0);
    } finally {
      await admin`delete from app.leads where id = ${extra}`;
    }
  });

  test('every export leaves an audit event without any customer data', async () => {
    await exportSheets(
      byFilter(
        {
          type: 'sim_order',
          q: 'Ada Example',
          assignee: COLLEAGUE,
          where: [{ key: 'canadaAddress', op: 'contains', value: '12 Maple Street' }],
          sort: 'createdAt:desc',
        },
        ['prop.arrivalDate', 'noteCount'],
      ),
    );
    await exportSheets({ scope: { kind: 'ids', ids: [SIM_ADA, NET_ONE] }, fields: ['prop.city'] });

    const events = await audits();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      actor_id: ACTOR,
      entity: 'workspace',
      entity_id: SITE,
      after: {
        scope: {
          kind: 'filter',
          type: 'sim_order',
          view: 'active',
          assignee: 'member',
          search: true,
          where: [{ key: 'canadaAddress', op: 'contains' }],
          sort: 'createdAt:desc',
        },
        rowCount: 0,
        sheets: [],
        contacts: true,
      },
    });
    expect(events[1]?.after).toMatchObject({
      scope: { kind: 'ids', count: 2 },
      rowCount: 2,
      sheets: [
        { leadType: 'internet', rows: 1 },
        { leadType: 'sim_order', rows: 1 },
      ],
    });
    const [, second] = events;
    const { sheets } = z
      .object({ sheets: z.array(z.object({ leadType: z.string(), fields: z.array(z.string()) })) })
      .parse(second?.after);
    expect(sheets[0]?.fields).toContain('prop.city');
    expect(sheets[0]?.fields).toContain('fullName');
    expect(sheets[1]?.fields).not.toContain('prop.city');

    const stored = JSON.stringify(events);
    for (const value of CUSTOMER_TEXT) expect(stored).not.toContain(value);
    expect(stored).not.toContain(SIM_ADA);
  });
});
