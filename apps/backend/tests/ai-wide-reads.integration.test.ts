/*
 * The widened Ask AI reads against real SQL (the counterpart of
 * ai-wide-reads.test.ts, which covers each role's projection over fakes):
 * findLeads through the inbox's own page query with its new filters, the lead
 * page's own read behind a summary, the commission only with `revenue.view`,
 * the inbox counters and the task date filters.
 *
 * Its site has its own fixed id range, is emptied before the run and deleted
 * after it, so the suite is re-runnable on a persistent `_test` database.
 */
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';
import { setTestRuntimePassword, TEST_RUNTIME_PASSWORD } from '@gt-sales/db/test-helpers';
import { z } from 'zod';

import { TurnBudget } from '../src/ai/limits.js';
import { DatabaseAiReadService } from '../src/ai/read-service.js';
import { SourceRegistry } from '../src/ai/sources.js';
import { createAssistantTools } from '../src/ai/tools.js';
import { resolveTaskDueWindow } from '../src/ai/windows.js';
import { DatabaseReportStore } from '../src/reports/store.js';
import type { StaffAccessSnapshot } from '../src/staff/authorization.js';

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
const SITE = 'd7000000-0000-4000-8000-0000000000d7';
const ACTOR = 'd7100000-0000-4000-8000-0000000000d7';
const COLLEAGUE = 'd7200000-0000-4000-8000-0000000000d7';
const PLAN = 'd7300000-0000-4000-8000-0000000000d7';
const NOW = new Date();
const DAY_MS = 24 * 60 * 60 * 1000;

const owner: StaffAccessSnapshot = {
  membershipId: 'd7400000-0000-4000-8000-0000000000d7',
  status: 'active',
  roles: ['owner'],
  permissions: [],
};
const leadsMember: StaffAccessSnapshot = { ...owner, roles: ['leads'] };

const envelope = z.object({
  status: z.string(),
  total: z.number().optional(),
  data: z.unknown().optional(),
  sources: z.array(z.object({ id: z.string(), href: z.string() })),
  notice: z.string().optional(),
});

databaseTest('the widened Ask AI reads (ai/read-service)', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let reads: DatabaseAiReadService;
  let reports: DatabaseReportStore;
  let orderLead = '';
  let openedLead = '';
  let dueLead = '';
  const scope = { workspaceId: SITE, actorId: ACTOR };

  function tools(access: StaffAccessSnapshot) {
    return createAssistantTools({
      scope,
      site: {
        siteId: SITE,
        slug: 'ai-wide-reads',
        name: 'AI Wide Reads',
        leadTypes: ['sim_order'],
      },
      now: NOW,
      budget: new TurnBudget(),
      sources: new SourceRegistry({ workspaceSlug: 'ai-wide-reads', asOf: NOW }),
      reads,
      reports,
      loadAccess: async () => access,
    });
  }

  async function insertLead(input: {
    status?: string;
    stage?: string;
    fullName: string;
    customValues?: postgres.JSONValue;
    orderDetails?: postgres.JSONValue;
    assignedActorId?: string | null;
  }): Promise<string> {
    const [row] = await admin<{ id: string }[]>`
      insert into app.leads (
        workspace_id, lead_type, status, stage, full_name, email, phone, consent_version,
        custom_values, order_details, assigned_actor_id, created_at, updated_at
      ) values (
        ${SITE}, 'sim_order', ${input.status ?? 'submitted'}, ${input.stage ?? 'pending'},
        ${input.fullName}, 'wide@example.test', '+1 604 555 0177', 'ci',
        ${admin.json(input.customValues ?? {})}, ${admin.json(input.orderDetails ?? {})},
        ${input.assignedActorId ?? null}, ${NOW}, ${NOW}
      )
      returning id
    `;
    if (!row) throw new Error('the lead insert returned no row');
    return row.id;
  }

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await setTestRuntimePassword(admin);
    await admin`delete from app.workspaces where id = ${SITE}`;
    await admin`insert into app.workspaces (id, slug, name) values (${SITE}, 'ai-wide-reads', 'AI Wide Reads')`;
    for (const [id, userId, name] of [
      ['d7500000-0000-4000-8000-0000000000d7', ACTOR, 'Ava Owner'],
      ['d7600000-0000-4000-8000-0000000000d7', COLLEAGUE, 'Casey Colleague'],
    ] as const) {
      await admin`
        insert into app.memberships (id, workspace_id, user_id, membership_type, status, display_name, accepted_at)
        values (${id}, ${SITE}, ${userId}, 'staff', 'active', ${name}, ${NOW})
      `;
    }
    await admin`
      insert into app.properties (workspace_id, object, key, origin, label, kind, position, sensitive, hidden, staff_only)
      values
        (${SITE}, 'lead', 'custom_size', 'custom', 'Size', 'text', 1, false, false, false),
        (${SITE}, 'lead', 'custom_secret', 'custom', 'Secret', 'text', 2, true, false, false),
        (${SITE}, 'lead', 'custom_hidden', 'custom', 'Hidden', 'text', 3, false, true, false)
    `;
    orderLead = await insertLead({
      fullName: 'Wide Order',
      assignedActorId: ACTOR,
      customValues: { custom_size: 'Large', custom_secret: 'S-123', custom_hidden: 'H-456' },
      orderDetails: {
        planId: PLAN,
        plan: {
          planId: PLAN,
          name: 'Unlimited 50',
          priceMinor: 4000,
          currency: 'CAD',
          billingPeriod: 'month',
          paymentRequired: true,
          requiredDocuments: [],
          properties: {},
          commission: { type: 'fixed', amountMinor: 1500 },
          frozenAt: NOW.toISOString(),
        },
        quantity: 1,
        paymentStatus: 'paid',
        carrierCommission: 'invoiced',
        courier: 'Canada Post',
        trackingNumber: 'TRACK-SECRET-1',
        activationNumber: '6045550111',
      },
    });
    await insertLead({
      fullName: 'Wide Draft',
      status: 'incomplete',
      stage: 'incomplete',
    });
    openedLead = await insertLead({ fullName: 'Wide Opened' });
    dueLead = await insertLead({ fullName: 'Wide Due', assignedActorId: COLLEAGUE });
    await admin`
      insert into app.lead_activities (workspace_id, lead_id, actor_id, kind, data, created_at)
      values
        (${SITE}, ${openedLead}, ${ACTOR}, 'system', ${admin.json({ event: 'opened' })}, ${NOW}),
        (${SITE}, ${orderLead}, ${ACTOR}, 'status_change', ${admin.json({ from: 'pending', to: 'verified' })}, ${new Date(NOW.getTime() - 3000)}),
        (${SITE}, ${orderLead}, ${ACTOR}, 'assignment', ${admin.json({ from: null, to: COLLEAGUE })}, ${new Date(NOW.getTime() - 2000)}),
        (${SITE}, ${orderLead}, ${ACTOR}, 'edit', ${admin.json({ fields: ['custom_size'] })}, ${new Date(NOW.getTime() - 1000)})
    `;
    await admin`
      insert into app.lead_tasks (workspace_id, lead_id, title, due_at, status, completed_at, created_by)
      values
        (${SITE}, ${dueLead}, 'Due follow-up', ${new Date(NOW.getTime() - 2 * DAY_MS)}, 'open', null, ${ACTOR}),
        (${SITE}, ${orderLead}, 'Finished call', ${new Date(NOW.getTime() - 40 * DAY_MS)}, 'done', ${NOW}, ${ACTOR}),
        (${SITE}, ${orderLead}, 'Old finished call', ${new Date(NOW.getTime() - 40 * DAY_MS)}, 'done', ${new Date(NOW.getTime() - 30 * DAY_MS)}, ${ACTOR})
    `;
    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      maxConnections: 1,
      ssl: false,
    });
    reads = new DatabaseAiReadService(database);
    reports = new DatabaseReportStore(database);
  }, 60_000);

  afterAll(async () => {
    if (admin) await admin`delete from app.workspaces where id = ${SITE}`;
    await database?.close();
    await admin?.end();
  }, 60_000);

  test('findLeads reads the inbox query: status, the new view, dueBy and property filters', async () => {
    const page = (input: Parameters<DatabaseAiReadService['findLeads']>[1]) =>
      reads
        .findLeads(scope, input)
        .then((result) => result.rows.map((row) => row.full_name).sort());
    const base = { limit: 10, offset: 0 };
    expect(await page({ ...base, status: 'incomplete' })).toEqual(['Wide Draft']);
    expect(await page({ ...base, unopenedOnly: true })).toEqual([
      'Wide Draft',
      'Wide Due',
      'Wide Order',
    ]);
    const today = new Date(NOW.getTime()).toISOString().slice(0, 10);
    expect(await page({ ...base, dueBy: today })).toEqual(['Wide Due']);
    expect(
      await page({ ...base, where: [{ key: 'custom_size', op: 'eq', value: 'Large' }] }),
    ).toEqual(['Wide Order']);
    const [order] = (await reads.findLeads(scope, { ...base, search: 'Wide Order' })).rows;
    expect(order?.assignee_name).toBe('Ava Owner');
  });

  test('the findLeads tool refuses a hidden or sensitive property filter against the live catalogue', async () => {
    for (const key of ['custom_secret', 'custom_hidden']) {
      const text = await tools(leadsMember).execute('findLeads', {
        where: [{ key, op: 'notEmpty' }],
      });
      expect(envelope.parse(JSON.parse(text)).status).toBe('invalid_filter');
    }
  });

  test('a summary reads the lead page: timeline with names, values through the catalogue', async () => {
    const text = await tools(leadsMember).execute('getLeadSummary', {
      leadId: orderLead,
      sections: ['activity', 'documents', 'details'],
    });
    const result = envelope.parse(JSON.parse(text));
    expect(result.status).toBe('ok');
    expect(result.notice).toBeDefined();
    const data = z
      .object({
        order: z.record(z.string(), z.unknown()),
        recentActivity: z.array(z.record(z.string(), z.unknown())),
        documents: z.array(z.unknown()),
        changeRequest: z.object({ waiting: z.boolean() }),
        details: z.object({
          values: z.array(z.object({ key: z.string(), value: z.unknown() })),
          withheld: z.number(),
        }),
      })
      .parse(result.data);
    expect(data.recentActivity).toEqual([
      expect.objectContaining({ kind: 'edit', fields: ['Size'], by: 'Ava Owner' }),
      expect.objectContaining({ kind: 'assignment', from: null, to: 'Casey Colleague' }),
      expect.objectContaining({ kind: 'status change', from: 'Pending', to: 'Verified' }),
    ]);
    expect(data.documents).toEqual([]);
    expect(data.changeRequest).toEqual({ waiting: false });
    expect(data.details.values).toEqual([
      expect.objectContaining({ key: 'custom_size', value: 'Large' }),
    ]);
    expect(data.details.withheld).toBe(2);
    // A Leads member sees the order money the lead page shows, never the commission amount.
    expect(data.order).toMatchObject({
      planName: 'Unlimited 50',
      priceMinor: 4000,
      paymentStatus: 'paid',
      carrierCommission: 'invoiced',
      courier: 'Canada Post',
    });
    expect(data.order).not.toHaveProperty('commission');
    for (const secret of ['S-123', 'H-456', 'TRACK-SECRET-1', '6045550111', 'wide@example.test'])
      expect(text).not.toContain(secret);
  });

  test('the commission amount reaches only revenue.view', async () => {
    const text = await tools(owner).execute('getLeadSummary', { leadId: orderLead });
    const data = z
      .object({ order: z.record(z.string(), z.unknown()) })
      .parse(envelope.parse(JSON.parse(text)).data);
    expect(data.order['commission']).toEqual({ type: 'fixed', amountMinor: 1500 });
  });

  test('the inbox counters come from the staff summary query', async () => {
    const today = new Date(NOW.getTime()).toISOString().slice(0, 10);
    const counts = await reads.inboxCounts(scope, today);
    expect(counts.types).toEqual([
      { leadType: 'sim_order', total: 4, unopened: 3, followUpsDue: 1 },
    ]);
    expect(counts.archived).toBe(0);
  });

  test('lead labels name only active, unrestricted leads, by reference and name', async () => {
    const restricted = await insertLead({ fullName: 'Wide Restricted' });
    const archived = await insertLead({ fullName: 'Wide Archived' });
    await admin`update app.leads set customer_data_restricted_at = now() where id = ${restricted}`;
    await admin`update app.leads set deleted_at = now() where id = ${archived}`;
    try {
      const labels = await reads.leadLabels(scope, [orderLead, restricted, archived]);
      expect([...labels.keys()]).toEqual([orderLead]);
      expect(labels.get(orderLead)).toMatchObject({ name: 'Wide Order', leadType: 'sim_order' });
      const names = await reads.memberNames(scope);
      expect(names.get(COLLEAGUE)).toBe('Casey Colleague');
    } finally {
      await admin`delete from app.leads where id in ${admin([restricted, archived])}`;
    }
  });

  test('done tasks since a day, and a due range', async () => {
    const since = await reads.openTasks(scope, {
      assignee: 'all',
      due: resolveTaskDueWindow('any', NOW),
      status: 'done',
      completedSince: new Date(NOW.getTime() - 7 * DAY_MS),
      limit: 20,
      offset: 0,
    });
    expect(since.rows.map((row) => row.title)).toEqual(['Finished call']);
    const ranged = await reads.openTasks(scope, {
      assignee: 'all',
      due: { from: new Date(NOW.getTime() - 3 * DAY_MS), before: NOW, label: 'range' },
      status: 'active',
      limit: 20,
      offset: 0,
    });
    expect(ranged.rows.map((row) => row.title)).toEqual(['Due follow-up']);
  });
});
