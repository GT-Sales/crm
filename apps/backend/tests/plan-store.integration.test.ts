import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';
import { PLAN_LIMIT, type CreatePlanRequest, type Plan } from '@gt-sales/contracts';

import { DatabasePlanStore, type CreatePlanOutcome } from '../src/plans/store.js';
import { DatabasePropertyStore } from '../src/properties/store.js';

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

// Distinct id range for the plan store integration tests.
const SITE = '1c000000-0000-4000-8000-000000000501';
const OTHER_SITE = '1c000000-0000-4000-8000-000000000502';
const ACTOR = '2c000000-0000-4000-8000-000000000501';
const OTHER_ACTOR = '2c000000-0000-4000-8000-000000000502';
const REQUEST = '3c000000-0000-4000-8000-000000000501';
const LEAD = '9c000000-0000-4000-8000-000000000501';
const MISSING_PLAN = '7c000000-0000-4000-8000-000000000599';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';

const ctx = { workspaceId: SITE, actorId: ACTOR, requestId: REQUEST };
const otherCtx = { workspaceId: OTHER_SITE, actorId: OTHER_ACTOR };

const planInput = (overrides: Partial<CreatePlanRequest> = {}): CreatePlanRequest => ({
  leadType: 'sim_order',
  name: 'Unlimited 50',
  priceMinor: 5000,
  billingPeriod: 'month',
  paymentRequired: true,
  requiredDocuments: [],
  active: true,
  customValues: {},
  ...overrides,
});

function planOf(outcome: CreatePlanOutcome): Plan {
  if (outcome.kind !== 'created') throw new Error(`expected created, got ${outcome.kind}`);
  return outcome.plan;
}

databaseTest('plan store', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let store: DatabasePlanStore;
  let propertyStore: DatabasePropertyStore;

  /** A custom plan property of the site, optionally shown on the website. */
  const planProperty = async (
    label: string,
    options: {
      websiteVisible?: boolean;
      hidden?: boolean;
      leadTypes?: string[];
      kind?: 'text' | 'number';
    } = {},
  ): Promise<string> => {
    const outcome = await propertyStore.create(ctx, 'plan', {
      label,
      kind: options.kind ?? 'text',
      options: [],
      staffOnly: false,
      sensitive: false,
      leadTypes: options.leadTypes ?? [],
      websiteVisible: options.websiteVisible ?? false,
    });
    if (outcome.kind !== 'created') throw new Error('plan property not created');
    if (options.hidden) {
      await admin`
        update app.properties set hidden = true
        where workspace_id = ${SITE} and object = 'plan' and key = ${outcome.property.key}
      `;
    }
    return outcome.property.key;
  };

  const auditRows = (action: string) => admin<
    {
      entity: string;
      entityId: string;
      actorId: string;
      requestId: string;
      before: unknown;
      after: unknown;
    }[]
  >`
    select entity, entity_id as "entityId", actor_id as "actorId", request_id as "requestId", before, after
    from app.audit_events
    where workspace_id = ${SITE} and action = ${action}
    order by created_at, id
  `;

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      ssl: false,
      maxConnections: 4,
    });
    store = new DatabasePlanStore(database);
    propertyStore = new DatabasePropertyStore(database);
  });

  // Each test starts from two empty sites; deleting a site removes its rows.
  beforeEach(async () => {
    await admin`delete from app.workspaces where id in (${SITE}, ${OTHER_SITE})`;
    await admin`
      insert into app.workspaces (id, slug, name)
      values
        (${SITE}, 'plan-store-501', 'Plan Store Site'),
        (${OTHER_SITE}, 'plan-store-502', 'Plan Store Other')
    `;
  });

  afterAll(async () => {
    if (admin) await admin`delete from app.workspaces where id in (${SITE}, ${OTHER_SITE})`;
    await database?.close();
    await admin?.end();
  });

  it('creates, gets and lists plans by type, position and name, hiding inactive ones unless asked', async () => {
    const first = planOf(await store.create(ctx, planInput({ name: 'Unlimited 50' })));
    expect(first).toMatchObject({
      leadType: 'sim_order',
      name: 'Unlimited 50',
      priceMinor: 5000,
      currency: 'CAD',
      billingPeriod: 'month',
      paymentRequired: true,
      active: true,
      requiredDocuments: [],
      customValues: {},
      position: 0,
      version: 1,
    });
    const second = planOf(
      await store.create(ctx, planInput({ name: 'basic 20', priceMinor: 2000 })),
    );
    expect(second.position).toBe(1);
    const internet = planOf(
      await store.create(ctx, planInput({ leadType: 'internet', name: 'Fibre 1G' })),
    );
    expect(internet.position).toBe(0);
    const retired = planOf(await store.create(ctx, planInput({ name: 'Old plan', active: false })));

    expect(await store.get(ctx, first.id)).toEqual(first);
    expect(await store.get(ctx, MISSING_PLAN)).toBeUndefined();

    // Two at the same position sort by name, ignoring case.
    await admin`update app.plans set position = 0 where id = ${second.id}`;
    const active = await store.list(ctx, { includeInactive: false });
    expect(active.map((plan) => plan.name)).toEqual(['Fibre 1G', 'basic 20', 'Unlimited 50']);
    const all = await store.list(ctx, { includeInactive: true });
    expect(all.map((plan) => plan.id)).toEqual([internet.id, second.id, first.id, retired.id]);
    const sim = await store.list(ctx, { leadType: 'sim_order', includeInactive: true });
    expect(sim.map((plan) => plan.name)).toEqual(['basic 20', 'Unlimited 50', 'Old plan']);

    const [created] = await auditRows('plan.created');
    expect(created).toMatchObject({
      entity: 'plan',
      entityId: first.id,
      actorId: ACTOR,
      requestId: REQUEST,
      before: null,
      after: { id: first.id, name: 'Unlimited 50', priceMinor: 5000, version: 1 },
    });

    expect(await store.options(ctx)).toEqual([
      { id: internet.id, name: 'Fibre 1G', active: true },
      { id: second.id, name: 'basic 20', active: true },
      { id: first.id, name: 'Unlimited 50', active: true },
      { id: retired.id, name: 'Old plan', active: false },
    ]);
  });

  it('a name is taken per site and type ignoring case, on create and on rename', async () => {
    planOf(await store.create(ctx, planInput({ name: 'Unlimited 50' })));
    expect(await store.create(ctx, planInput({ name: 'UNLIMITED 50' }))).toEqual({
      kind: 'name_taken',
    });
    // Another type or another site may reuse it.
    planOf(await store.create(ctx, planInput({ leadType: 'mobility', name: 'unlimited 50' })));
    planOf(await store.create(otherCtx, planInput({ name: 'Unlimited 50' })));

    const other = planOf(await store.create(ctx, planInput({ name: 'Basic' })));
    expect(await store.update(ctx, other.id, { expectedVersion: 1, name: 'unlimited 50' })).toEqual(
      { kind: 'name_taken' },
    );
    expect((await store.get(ctx, other.id))?.name).toBe('Basic');
  });

  it(`stops at ${PLAN_LIMIT} plans per site across types`, async () => {
    await admin`
      insert into app.plans (workspace_id, lead_type, name)
      select ${SITE}, case when n % 2 = 0 then 'sim_order' else 'internet' end, 'Plan ' || n
      from generate_series(1, ${PLAN_LIMIT}) as n
    `;
    expect(await store.create(ctx, planInput({ name: 'One too many' }))).toEqual({
      kind: 'limit_reached',
    });
    // The limit is per site.
    planOf(await store.create(otherCtx, planInput()));
  });

  it('updates under a version guard and audits before and after', async () => {
    const plan = planOf(await store.create(ctx, planInput()));
    const outcome = await store.update(ctx, plan.id, {
      expectedVersion: 1,
      name: 'Unlimited 55',
      priceMinor: 5500,
      active: false,
      requiredDocuments: ['id_front'],
      position: 4,
    });
    expect(outcome).toMatchObject({
      kind: 'updated',
      plan: {
        id: plan.id,
        name: 'Unlimited 55',
        priceMinor: 5500,
        active: false,
        requiredDocuments: ['id_front'],
        position: 4,
        version: 2,
      },
    });
    expect(await store.update(ctx, plan.id, { expectedVersion: 1, name: 'Again' })).toEqual({
      kind: 'version_conflict',
    });
    expect(await store.update(ctx, MISSING_PLAN, { expectedVersion: 1, name: 'x' })).toEqual({
      kind: 'not_found',
    });
    // Another site's plan is not found from here.
    expect(await store.update(otherCtx, plan.id, { expectedVersion: 2, name: 'x' })).toEqual({
      kind: 'not_found',
    });

    const [updated] = await auditRows('plan.updated');
    expect(updated).toMatchObject({
      entity: 'plan',
      entityId: plan.id,
      before: { name: 'Unlimited 50', version: 1 },
      after: { name: 'Unlimited 55', version: 2, active: false },
    });
  });

  it('validates custom values against the site plan properties', async () => {
    const network = await planProperty('Network');
    const data = await planProperty('Data GB', { kind: 'number' });
    const internetOnly = await planProperty('Router', { leadTypes: ['internet'] });
    const hidden = await planProperty('Old field', { hidden: true });

    const plan = planOf(
      await store.create(ctx, planInput({ customValues: { [network]: 'Rogers', [data]: 50 } })),
    );
    expect(plan.customValues).toEqual({ [network]: 'Rogers', [data]: 50 });

    for (const [key, value] of [
      ['custom_unknown', 'x'],
      [data, 'fifty'],
      [network, ''],
      [internetOnly, 'yes'],
      [hidden, 'x'],
    ] as const) {
      expect(
        await store.create(ctx, planInput({ name: `Plan ${key}`, customValues: { [key]: value } })),
      ).toEqual({ kind: 'invalid_custom_value', field: key });
    }
    // A lead property of the same key is no plan property.
    await propertyStore.create(ctx, 'lead', {
      label: 'Lead only',
      kind: 'text',
      options: [],
      staffOnly: false,
      sensitive: false,
      leadTypes: [],
    });
    expect(
      await store.create(
        ctx,
        planInput({ name: 'Lead key', customValues: { custom_lead_only: 'x' } }),
      ),
    ).toEqual({ kind: 'invalid_custom_value', field: 'custom_lead_only' });

    // Update: null clears, others are kept, a bad value changes nothing.
    const cleared = await store.update(ctx, plan.id, {
      expectedVersion: 1,
      customValues: { [network]: null, [data]: 75 },
    });
    expect(cleared).toMatchObject({ kind: 'updated', plan: { customValues: { [data]: 75 } } });
    expect(
      await store.update(ctx, plan.id, { expectedVersion: 2, customValues: { [data]: 'x' } }),
    ).toEqual({ kind: 'invalid_custom_value', field: data });
    expect((await store.get(ctx, plan.id))?.version).toBe(2);
  });

  it('lists for the website only active plans with only website-visible values', async () => {
    const network = await planProperty('Network', { websiteVisible: true });
    const cost = await planProperty('Internal cost', { kind: 'number' });
    const retiredField = await planProperty('Promo', { websiteVisible: true });
    const shown = planOf(
      await store.create(
        ctx,
        planInput({
          name: 'Unlimited 50',
          requiredDocuments: ['id_front'],
          customValues: { [network]: 'Rogers', [cost]: 1200, [retiredField]: 'Spring' },
        }),
      ),
    );
    // Hidden since the value was set: the website no longer sees it.
    await admin`
      update app.properties set hidden = true
      where workspace_id = ${SITE} and object = 'plan' and key = ${retiredField}
    `;
    planOf(await store.create(ctx, planInput({ name: 'Retired', active: false })));
    const internet = planOf(
      await store.create(ctx, planInput({ leadType: 'internet', name: 'Fibre', priceMinor: 6000 })),
    );

    expect(await store.listForWebsite(ctx, 'sim_order')).toEqual([
      {
        id: shown.id,
        leadType: 'sim_order',
        name: 'Unlimited 50',
        priceMinor: 5000,
        currency: 'CAD',
        billingPeriod: 'month',
        paymentRequired: true,
        requiredDocuments: ['id_front'],
        properties: { [network]: 'Rogers' },
      },
    ]);
    const every = await store.listForWebsite(ctx);
    expect(every.map((plan) => plan.id)).toEqual([internet.id, shown.id]);
    expect(await store.listForWebsite(otherCtx)).toEqual([]);
  });

  it("keeps every site's plans apart", async () => {
    const mine = planOf(await store.create(ctx, planInput()));
    expect(await store.list(otherCtx, { includeInactive: true })).toEqual([]);
    expect(await store.get(otherCtx, mine.id)).toBeUndefined();
    expect(await store.options(otherCtx)).toEqual([]);
  });

  it("a plan update changes no lead's order details", async () => {
    const plan = planOf(await store.create(ctx, planInput()));
    const orderDetails = {
      planId: plan.id,
      plan: {
        planId: plan.id,
        name: plan.name,
        priceMinor: plan.priceMinor,
        currency: 'CAD',
        billingPeriod: 'month',
        paymentRequired: true,
        requiredDocuments: [],
        properties: {},
        frozenAt: '2026-10-30T00:00:00.000Z',
      },
      quantity: 1,
      paymentStatus: 'pending',
      carrierCommission: 'not_yet',
    };
    await admin`
      insert into app.leads (
        id, workspace_id, lead_type, status, stage, consent_version, attribution, payload, order_details
      ) values (
        ${LEAD}, ${SITE}, 'sim_order', 'submitted', 'pending', 'ci', '{}'::jsonb,
        ${admin.json({ schemaVersion: 1, payload: {} })}, ${admin.json(orderDetails)}
      )
    `;
    const updated = await store.update(ctx, plan.id, {
      expectedVersion: 1,
      name: 'Renamed',
      priceMinor: 9900,
    });
    expect(updated.kind).toBe('updated');
    const [lead] = await admin<{ orderDetails: unknown }[]>`
      select order_details as "orderDetails" from app.leads where id = ${LEAD}
    `;
    expect(lead?.orderDetails).toEqual(orderDetails);
  });
});
