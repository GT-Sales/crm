import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  Condition,
  ConditionGroup,
  LeadPropertyFilter,
  PropertyCatalog,
} from '@gt-sales/contracts';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

import { evaluateConditionGroup } from '../src/automations/conditions.js';
import { selectLeadPage } from '../src/leads/staff-queries.js';
import { loadPropertyCatalog } from '../src/properties/catalog.js';
import { disposableTestDatabaseUrl } from './support/flows.js';

const migrationUrl = disposableTestDatabaseUrl();
const databaseTest = migrationUrl ? describe : describe.skip;

const SITE = '18000000-0000-4000-8000-000000008306';
const STAFF = '28000000-0000-4000-8000-000000008306';
const OTHER = '28000000-0000-4000-8000-000000008307';
const PLAN_A = '48000000-0000-4000-8000-000000008306';
const PLAN_B = '48000000-0000-4000-8000-000000008307';
const LEADS = [1, 2, 3, 4].map((n) => `38000000-0000-4000-8000-00000000830${n}`);
const [L1 = '', L2 = '', L3 = '', L4 = ''] = LEADS;
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';

databaseTest('flow conditions mean what the inbox filters mean', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  const scope = { workspaceId: SITE, actorId: STAFF };

  const insertLead = (input: {
    id: string;
    stage: string;
    assignedActorId: string | null;
    form: Record<string, unknown>;
    custom: Record<string, unknown>;
    order: Record<string, unknown>;
  }) => admin`
    insert into app.leads (
      id, workspace_id, lead_type, status, stage, consent_version, attribution, payload,
      custom_values, order_details, assigned_actor_id
    ) values (
      ${input.id}, ${SITE}, 'sim_order', 'submitted', ${input.stage}, 'ci', '{}'::jsonb,
      ${admin.json(JSON.parse(JSON.stringify({ schemaVersion: 1, payload: input.form })))},
      ${admin.json(JSON.parse(JSON.stringify(input.custom)))},
      ${admin.json(JSON.parse(JSON.stringify(input.order)))},
      ${input.assignedActorId}
    )
  `;

  const holding = (group: ConditionGroup) =>
    database.withTenantTx(scope, async (tx) => {
      const catalog = await loadPropertyCatalog(tx);
      const held: string[] = [];
      for (const leadId of LEADS) {
        if (
          await evaluateConditionGroup(tx, {
            workspaceId: SITE,
            leadId,
            leadType: 'sim_order',
            group,
            catalog,
          })
        ) {
          held.push(leadId);
        }
      }
      return held;
    });

  const listed = (filter: LeadPropertyFilter) =>
    database.withTenantTx(scope, async (tx) => {
      const catalog: PropertyCatalog = await loadPropertyCatalog(tx);
      const page = await selectLeadPage(
        tx,
        { workspaceId: SITE, actorId: STAFF, leadType: 'sim_order', where: [filter], catalog },
        1,
        50,
      );
      return page.leads.map((lead) => lead.id).sort();
    });

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    await admin`delete from app.workspaces where id = ${SITE}`;
    await admin`insert into app.workspaces (id, slug, name) values (${SITE}, 'automation-conditions-8306', 'Conditions')`;
    await admin`
      insert into app.memberships (workspace_id, user_id, membership_type, status)
      values (${SITE}, ${STAFF}, 'staff', 'active'), (${SITE}, ${OTHER}, 'staff', 'active')
    `;
    await admin`
      insert into app.plans (id, workspace_id, lead_type, name, active, position)
      values (${PLAN_A}, ${SITE}, 'sim_order', 'Plan A', true, 0),
             (${PLAN_B}, ${SITE}, 'sim_order', 'Plan B', true, 1)
    `;
    await admin`
      insert into app.properties (workspace_id, object, key, origin, label, kind, position)
      values (${SITE}, 'lead', 'custom_size', 'custom', 'Size', 'text', 1),
             (${SITE}, 'lead', 'custom_count', 'custom', 'Count', 'number', 2)
    `;
    await insertLead({
      id: L1,
      stage: 'pending',
      assignedActorId: null,
      form: { permitType: 'student', reference: 'Batch 7', arrivalDate: '2026-11-10' },
      custom: { custom_size: 'Large', custom_count: 5 },
      // A frozen plan wins over a link left behind.
      order: { planId: PLAN_B, plan: { planId: PLAN_A }, quantity: 2 },
    });
    await insertLead({
      id: L2,
      stage: 'verified',
      assignedActorId: STAFF,
      form: { permitType: 'worker', reference: '   ' },
      custom: { custom_size: 'large', custom_count: 2 },
      order: { planId: PLAN_B, quantity: 1 },
    });
    await insertLead({
      id: L3,
      stage: 'on_hold',
      assignedActorId: OTHER,
      form: { permitType: 'visitor' },
      custom: { custom_count: 'not a number' },
      order: { quantity: 3 },
    });
    await insertLead({
      id: L4,
      stage: 'cancelled',
      assignedActorId: null,
      form: {},
      custom: {},
      order: {},
    });

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      ssl: false,
      maxConnections: 2,
    });
  });

  afterAll(async () => {
    await database?.close();
    await admin?.end();
  });

  const filters: Array<[string, LeadPropertyFilter]> = [
    ['text eq on a form field', { key: 'reference', op: 'eq', value: 'batch 7' }],
    ['text contains on a form field', { key: 'reference', op: 'contains', value: 'atc' }],
    ['choice in on a form field', { key: 'permitType', op: 'in', value: ['student', 'worker'] }],
    ['empty on a form field', { key: 'reference', op: 'empty' }],
    ['date on or after on a form field', { key: 'arrivalDate', op: 'gte', value: '2026-11-01' }],
    ['text eq on a custom property', { key: 'custom_size', op: 'eq', value: 'LARGE' }],
    ['number at least on a custom property', { key: 'custom_count', op: 'gte', value: 3 }],
    ['empty on a custom property', { key: 'custom_size', op: 'empty' }],
    ['number at least on an order property', { key: 'quantity', op: 'gte', value: 2 }],
  ];

  it.each(filters)('%s holds exactly for the leads the inbox lists', async (_name, filter) => {
    const expected = await listed(filter);
    // Every filter in the table picks some leads and leaves others.
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(LEADS.length);
    const held = await holding({ match: 'all', items: [{ kind: 'property', filter }] });
    expect(held.sort()).toEqual(expected);
  });

  it('plan in reads the frozen plan, else the plan link', async () => {
    expect(
      await holding({ match: 'all', items: [{ kind: 'plan', op: 'in', planIds: [PLAN_A] }] }),
    ).toEqual([L1]);
    expect(
      await holding({ match: 'all', items: [{ kind: 'plan', op: 'in', planIds: [PLAN_B] }] }),
    ).toEqual([L2]);
    expect(
      await holding({ match: 'all', items: [{ kind: 'plan', op: 'not_in', planIds: [PLAN_B] }] }),
    ).toEqual([L1, L3, L4]);
  });

  it('stage and assignee read the columns', async () => {
    expect(
      await holding({
        match: 'all',
        items: [{ kind: 'stage', op: 'not_in', stages: ['pending', 'cancelled'] }],
      }),
    ).toEqual([L2, L3]);
    expect(await holding({ match: 'all', items: [{ kind: 'assignee', op: 'none' }] })).toEqual([
      L1,
      L4,
    ]);
    expect(await holding({ match: 'all', items: [{ kind: 'assignee', op: 'any' }] })).toEqual([
      L2,
      L3,
    ]);
    expect(
      await holding({ match: 'all', items: [{ kind: 'assignee', op: 'is', actorId: OTHER }] }),
    ).toEqual([L3]);
  });

  it('all and any combine, and a group nests', async () => {
    const unowned: Condition = { kind: 'assignee', op: 'none' };
    const verified: Condition = { kind: 'stage', op: 'in', stages: ['verified'] };
    expect(await holding({ match: 'all', items: [unowned, verified] })).toEqual([]);
    expect(await holding({ match: 'any', items: [unowned, verified] })).toEqual([L1, L2, L4]);
    expect(
      await holding({
        match: 'all',
        items: [
          { kind: 'lead_type', in: ['sim_order'] },
          { match: 'any', items: [verified, { kind: 'stage', op: 'in', stages: ['on_hold'] }] },
        ],
      }),
    ).toEqual([L2, L3]);
    expect(
      await holding({ match: 'all', items: [{ kind: 'lead_type', in: ['internet'] }] }),
    ).toEqual([]);
  });
});
