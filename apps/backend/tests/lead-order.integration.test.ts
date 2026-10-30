import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_LEAD_ORDER,
  freezePlan,
  leadOrderIntakeSchema,
  type CreatePlanRequest,
  type LeadOrder,
  type Plan,
  type PropertyCatalog,
} from '@gt-sales/contracts';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

import { DatabaseLeadStore, OrderIntakeError, type CreateLeadInput } from '../src/leads/store.js';
import { DatabaseLeadWorkStore } from '../src/leads/work-store.js';
import { DatabasePlanStore } from '../src/plans/store.js';
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

// Distinct id range for the lead order tests.
const SITE = '1d000000-0000-4000-8000-000000000601';
const OTHER_SITE = '1d000000-0000-4000-8000-000000000602';
const LIST_SITE = '1d000000-0000-4000-8000-000000000603';
const ACTOR = '2d000000-0000-4000-8000-000000000601';
const REQUEST = '3d000000-0000-4000-8000-000000000601';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';

// List site leads; ids sort L1 < L2 < L3 < L4.
const L1 = '9d000000-0000-4000-8000-000000000001';
const L2 = '9d000000-0000-4000-8000-000000000002';
const L3 = '9d000000-0000-4000-8000-000000000003';
const L4 = '9d000000-0000-4000-8000-000000000004';
const L_LEGACY = '9d000000-0000-4000-8000-000000000005';

const ctx = { workspaceId: SITE, actorId: ACTOR, requestId: REQUEST };
const otherCtx = { workspaceId: OTHER_SITE, actorId: ACTOR, requestId: REQUEST };
const listCtx = { workspaceId: LIST_SITE, actorId: ACTOR, requestId: REQUEST };

const planInput = (overrides: Partial<CreatePlanRequest>): CreatePlanRequest => ({
  leadType: 'sim_order',
  name: 'Plan',
  priceMinor: 5000,
  billingPeriod: 'month',
  paymentRequired: true,
  requiredDocuments: ['passport'],
  active: true,
  customValues: {},
  ...overrides,
});

/** The snapshot `freezePlan` takes of `plan`, whenever it was frozen. */
const frozen = (plan: Plan, visibleKeys: readonly string[]) => ({
  ...freezePlan(plan, visibleKeys, new Date(0)),
  frozenAt: expect.any(String),
});

databaseTest('order details on leads', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let leadStore: DatabaseLeadStore;
  let work: DatabaseLeadWorkStore;
  let planStore: DatabasePlanStore;
  let propertyStore: DatabasePropertyStore;
  let catalog: PropertyCatalog;
  let listCatalog: PropertyCatalog;
  let dataKey: string;

  let simPaid: Plan;
  let simFree: Plan;
  let simInactive: Plan;
  let internetPlan: Plan;
  let foreignPlan: Plan;
  let listPlan: Plan;

  const createPlan = async (
    target: typeof ctx,
    overrides: Partial<CreatePlanRequest>,
  ): Promise<Plan> => {
    const outcome = await planStore.create(target, planInput(overrides));
    if (outcome.kind !== 'created') throw new Error(`plan not created: ${outcome.kind}`);
    return outcome.plan;
  };

  const base = (overrides: Partial<CreateLeadInput> = {}): CreateLeadInput => ({
    workspaceId: SITE,
    actorId: ACTOR,
    requestId: REQUEST,
    leadType: 'sim_order',
    consentVersion: 'ci',
    contact: { fullName: 'Order Person', email: 'order.person@example.test' },
    ...overrides,
  });

  const orderDetails = async (leadId: string): Promise<unknown> => {
    const [row] = await admin<{ orderDetails: unknown }[]>`
      select order_details as "orderDetails" from app.leads where id = ${leadId}
    `;
    return row?.orderDetails;
  };

  const leadCount = async (externalRef: string) => {
    const [row] = await admin<{ total: number }[]>`
      select count(*)::int as total from app.leads
      where workspace_id = ${SITE} and external_ref = ${externalRef}
    `;
    return row?.total ?? 0;
  };

  const insertLead = async (input: {
    id: string;
    leadType: string;
    stage?: string;
    orderDetails: Record<string, string | number | null>;
  }) => {
    await admin`
      insert into app.leads (
        id, workspace_id, lead_type, status, stage, consent_version, attribution, payload,
        order_details
      ) values (
        ${input.id}, ${LIST_SITE}, ${input.leadType}, 'submitted', ${input.stage ?? 'pending'},
        'ci', '{}'::jsonb, ${admin.json({ schemaVersion: 1, payload: {} })},
        ${admin.json(input.orderDetails)}
      )
    `;
  };

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    // Deleting a site removes its leads, plans, properties and timeline.
    await admin`delete from app.workspaces where id in (${SITE}, ${OTHER_SITE}, ${LIST_SITE})`;
    await admin`
      insert into app.workspaces (id, slug, name)
      values
        (${SITE}, 'lead-order-601', 'Lead Order Site'),
        (${OTHER_SITE}, 'lead-order-602', 'Lead Order Other'),
        (${LIST_SITE}, 'lead-order-603', 'Lead Order List')
    `;

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      ssl: false,
      maxConnections: 4,
    });
    leadStore = new DatabaseLeadStore(database);
    work = new DatabaseLeadWorkStore(database);
    planStore = new DatabasePlanStore(database);
    propertyStore = new DatabasePropertyStore(database);

    const data = await propertyStore.create(ctx, 'plan', {
      label: 'Data',
      kind: 'text',
      options: [],
      staffOnly: false,
      sensitive: false,
      leadTypes: [],
      websiteVisible: true,
    });
    const cost = await propertyStore.create(ctx, 'plan', {
      label: 'Cost',
      kind: 'number',
      options: [],
      staffOnly: false,
      sensitive: false,
      leadTypes: [],
      websiteVisible: false,
    });
    if (data.kind !== 'created' || cost.kind !== 'created') throw new Error('plan properties');
    dataKey = data.property.key;
    const costKey = cost.property.key;

    simPaid = await createPlan(ctx, {
      name: 'Unlimited 50',
      customValues: { [dataKey]: '50 GB', [costKey]: 1200 },
    });
    simFree = await createPlan(ctx, { name: 'Free SIM', priceMinor: 0, paymentRequired: false });
    simInactive = await createPlan(ctx, { name: 'Old plan', active: false });
    internetPlan = await createPlan(ctx, { leadType: 'internet', name: 'Fibre 1G' });
    foreignPlan = await createPlan(otherCtx, { name: 'Other site plan' });
    listPlan = await createPlan(listCtx, { name: 'List plan' });

    catalog = await propertyStore.catalog(ctx);
    listCatalog = await propertyStore.catalog(listCtx);

    await insertLead({
      id: L1,
      leadType: 'sim_order',
      orderDetails: {
        planId: listPlan.id,
        plan: null,
        quantity: 3,
        paymentStatus: 'paid',
        carrierCommission: 'not_yet',
      },
    });
    await insertLead({ id: L2, leadType: 'sim_order', orderDetails: {} });
    await insertLead({
      id: L3,
      leadType: 'sim_order',
      orderDetails: { quantity: 2, paymentStatus: 'pending' },
    });
    await insertLead({ id: L4, leadType: 'contact_message', stage: 'new', orderDetails: {} });
    // A row the 0012 migration has not reached yet keeps its retired stage.
    await insertLead({ id: L_LEGACY, leadType: 'sim_order', stage: 'paid', orderDetails: {} });
  });

  afterAll(async () => {
    await database?.close();
    await admin?.end();
  });

  it('the catalogue offers each order type only its own plans', () => {
    const offered = (leadType: string) =>
      (catalog.forType(leadType).find((property) => property.key === 'plan')?.options ?? [])
        .filter((option) => !option.hidden)
        .map((option) => option.value);
    expect(offered('sim_order')).toEqual([simPaid.id, simFree.id]);
    expect(offered('internet')).toEqual([internetPlan.id]);
    expect(offered('mobility')).toEqual([]);
    // The SIM plans stay readable on an internet order, as hidden options.
    const internetPlanProperty = catalog.forType('internet').find((p) => p.key === 'plan');
    expect(internetPlanProperty?.options).toEqual(
      expect.arrayContaining([{ value: simPaid.id, label: 'Unlimited 50', hidden: true }]),
    );
    expect(catalog.filterable().find((property) => property.key === 'plan')?.options).toEqual(
      expect.arrayContaining([
        { value: internetPlan.id, label: 'Fibre 1G (Internet)', hidden: false },
        { value: simInactive.id, label: 'Old plan (SIM order)', hidden: true },
      ]),
    );
  });

  describe('website intake', () => {
    it('freezes the plan at submission with its payment status, quantity 1 by default', async () => {
      const order = leadOrderIntakeSchema.parse({ planId: simPaid.id });
      expect(order.quantity).toBe(1);
      const paid = await leadStore.createLead(base({ submit: true, order }));
      expect(paid.lead.status).toBe('submitted');
      expect(await orderDetails(paid.lead.id)).toEqual({
        planId: simPaid.id,
        // Only the website-visible custom value; the internal cost stays behind.
        plan: frozen(simPaid, [dataKey]),
        quantity: 1,
        paymentStatus: 'pending',
        carrierCommission: 'not_yet',
      });
      expect(await orderDetails(paid.lead.id)).toMatchObject({
        plan: { name: 'Unlimited 50', priceMinor: 5000, properties: { [dataKey]: '50 GB' } },
      });

      const free = await leadStore.createLead(
        base({ submit: true, order: { planId: simFree.id, quantity: 3 } }),
      );
      expect(await orderDetails(free.lead.id)).toEqual({
        planId: simFree.id,
        plan: frozen(simFree, [dataKey]),
        quantity: 3,
        paymentStatus: 'not_needed',
        carrierCommission: 'not_yet',
      });

      const detail = await work.getLead({
        ...ctx,
        leadId: free.lead.id,
        includeWork: true,
        catalog,
      });
      expect(detail?.lead.order).toMatchObject({
        planId: simFree.id,
        quantity: 3,
        paymentStatus: 'not_needed',
      });
    });

    it('refuses an inactive, foreign-site, wrong-type or unknown plan and creates no lead', async () => {
      const refused = [
        ['inactive', simInactive.id],
        ['foreign', foreignPlan.id],
        ['wrong-type', internetPlan.id],
        ['unknown', '7d000000-0000-4000-8000-000000000699'],
      ] as const;
      for (const [label, planId] of refused) {
        const externalRef = `refused-${label}`;
        for (const submit of [true, false]) {
          const attempt = leadStore.createLead(
            base({ externalRef, submit, order: { planId, quantity: 1 } }),
          );
          await expect(attempt).rejects.toBeInstanceOf(OrderIntakeError);
          await expect(attempt).rejects.toMatchObject({ code: 'plan_not_available' });
        }
        expect(await leadCount(externalRef)).toBe(0);
      }

      // A plan on a type that takes no order is refused as a bad request.
      await expect(
        leadStore.createLead(
          base({
            leadType: 'contact_message',
            externalRef: 'refused-type',
            submit: true,
            order: { planId: simPaid.id, quantity: 1 },
          }),
        ),
      ).rejects.toMatchObject({ code: 'invalid_request' });
      expect(await leadCount('refused-type')).toBe(0);
    });

    it('a plan edit after submission leaves the snapshot as it was', async () => {
      const plan = await createPlan(ctx, { name: 'Editable', priceMinor: 3000 });
      const created = await leadStore.createLead(
        base({ submit: true, order: { planId: plan.id, quantity: 2 } }),
      );
      const before = await orderDetails(created.lead.id);
      const edited = await planStore.update(ctx, plan.id, {
        expectedVersion: plan.version,
        name: 'Editable renamed',
        priceMinor: 9900,
        paymentRequired: false,
      });
      expect(edited.kind).toBe('updated');
      expect(await orderDetails(created.lead.id)).toEqual(before);
      expect(before).toMatchObject({ plan: { name: 'Editable', priceMinor: 3000 } });
    });

    it('a draft keeps the plan and quantity only, and freezes at submission', async () => {
      const plan = await createPlan(ctx, { name: 'Draft plan', priceMinor: 1000 });
      const draft = await leadStore.createLead(base({ order: { planId: plan.id, quantity: 2 } }));
      if (!draft.grant) throw new Error('expected a draft grant');
      expect(await orderDetails(draft.lead.id)).toEqual({ planId: plan.id, quantity: 2 });
      // Reads fill in the rest from the defaults.
      const page = await work.getLead({
        ...ctx,
        leadId: draft.lead.id,
        includeWork: true,
        catalog,
      });
      expect(page?.lead.order).toEqual({ ...DEFAULT_LEAD_ORDER, planId: plan.id, quantity: 2 });

      // The price changes while the customer is still filling in the form.
      const edited = await planStore.update(ctx, plan.id, {
        expectedVersion: plan.version,
        priceMinor: 1500,
      });
      if (edited.kind !== 'updated') throw new Error('plan not updated');

      const submitted = await leadStore.updateLead({
        ...ctx,
        leadId: draft.lead.id,
        grantToken: draft.grant.token,
        submit: true,
      });
      expect(submitted).toMatchObject({ status: 'updated', lead: { status: 'submitted' } });
      expect(await orderDetails(draft.lead.id)).toEqual({
        planId: plan.id,
        plan: frozen(edited.plan, [dataKey]),
        quantity: 2,
        paymentStatus: 'pending',
        carrierCommission: 'not_yet',
      });
      expect(await orderDetails(draft.lead.id)).toMatchObject({ plan: { priceMinor: 1500 } });

      // A submitted draft cannot be edited again.
      expect(
        await leadStore.updateLead({
          ...ctx,
          leadId: draft.lead.id,
          grantToken: draft.grant.token,
          order: { planId: simFree.id, quantity: 1 },
        }),
      ).toEqual({ status: 'draft_submitted' });
    });

    it('a draft resumed with another plan, or submitted after its plan was withdrawn', async () => {
      const plan = await createPlan(ctx, { name: 'Withdrawn later' });
      const draft = await leadStore.createLead(base());
      if (!draft.grant) throw new Error('expected a draft grant');
      const scope = { ...ctx, leadId: draft.lead.id, grantToken: draft.grant.token };

      // A refused plan changes nothing, the contact included.
      expect(
        await leadStore.updateLead({
          ...scope,
          contact: { fullName: 'Changed Name' },
          order: { planId: simInactive.id, quantity: 1 },
        }),
      ).toEqual({ status: 'plan_not_available' });
      expect(await orderDetails(draft.lead.id)).toEqual({});

      expect(
        await leadStore.updateLead({ ...scope, order: { planId: plan.id, quantity: 4 } }),
      ).toMatchObject({ status: 'updated', lead: { status: 'incomplete' } });
      expect(await orderDetails(draft.lead.id)).toEqual({ planId: plan.id, quantity: 4 });

      const withdrawn = await planStore.update(ctx, plan.id, {
        expectedVersion: plan.version,
        active: false,
      });
      expect(withdrawn.kind).toBe('updated');
      expect(await leadStore.updateLead({ ...scope, submit: true })).toEqual({
        status: 'plan_not_available',
      });
      const [row] = await admin<{ status: string; fullName: string | null }[]>`
        select status, full_name as "fullName" from app.leads where id = ${draft.lead.id}
      `;
      expect(row).toEqual({ status: 'incomplete', fullName: 'Order Person' });

      // Another plan at submission is frozen in its place.
      expect(
        await leadStore.updateLead({
          ...scope,
          submit: true,
          order: { planId: simFree.id, quantity: 1 },
        }),
      ).toMatchObject({ status: 'updated', lead: { status: 'submitted' } });
      expect(await orderDetails(draft.lead.id)).toEqual({
        planId: simFree.id,
        plan: frozen(simFree, [dataKey]),
        quantity: 1,
        paymentStatus: 'not_needed',
        carrierCommission: 'not_yet',
      });
    });

    it('refuses a plan on a draft of a type that takes no order', async () => {
      const draft = await leadStore.createLead(base({ leadType: 'partner_application' }));
      if (!draft.grant) throw new Error('expected a draft grant');
      expect(
        await leadStore.updateLead({
          ...ctx,
          leadId: draft.lead.id,
          grantToken: draft.grant.token,
          order: { planId: simPaid.id, quantity: 1 },
        }),
      ).toEqual({ status: 'order_not_allowed' });
      // Without an order it submits as before.
      expect(
        await leadStore.updateLead({
          ...ctx,
          leadId: draft.lead.id,
          grantToken: draft.grant.token,
          submit: true,
        }),
      ).toMatchObject({ status: 'updated', lead: { status: 'submitted' } });
      expect(await orderDetails(draft.lead.id)).toEqual({});
    });
  });

  describe('staff order edits', () => {
    const auditOf = async (leadId: string) => {
      const [row] = await admin<{ before: unknown; after: unknown }[]>`
        select before, after from app.audit_events
        where entity_id = ${leadId} and action = 'lead.updated'
        order by created_at desc, id desc limit 1
      `;
      return row;
    };

    it('re-freezes a new plan, sets the other fields directly and names the changed keys', async () => {
      const created = await leadStore.createLead(
        base({ submit: true, order: { planId: simPaid.id, quantity: 1 } }),
      );
      const leadId = created.lead.id;
      const scope = { ...ctx, leadId, catalog };
      const first = await orderDetails(leadId);

      const replanned = await work.updateLead({ ...scope, order: { planId: simFree.id } });
      if (replanned.status !== 'updated') throw new Error(`got ${replanned.status}`);
      expect(replanned.lead.order).toEqual({
        planId: simFree.id,
        plan: frozen(simFree, [dataKey]),
        quantity: 1,
        // Staff set the payment status themselves; a new plan does not reset it.
        paymentStatus: 'pending',
        carrierCommission: 'not_yet',
      });
      expect(replanned.activities).toEqual([
        expect.objectContaining({ kind: 'edit', fields: ['plan'] }),
      ]);
      const audit = await auditOf(leadId);
      expect(audit?.before).toEqual({ order: first });
      expect(audit?.after).toEqual({
        changedFields: ['plan'],
        order: await orderDetails(leadId),
      });

      // The same plan again, unchanged since, keeps the copy and writes nothing.
      expect(await work.updateLead({ ...scope, order: { planId: simFree.id } })).toMatchObject({
        status: 'updated',
        activities: [],
      });

      const set = await work.updateLead({
        ...scope,
        order: { quantity: 4, paymentStatus: 'paid', carrierCommission: 'not_yet' },
      });
      if (set.status !== 'updated') throw new Error(`got ${set.status}`);
      expect(set.lead.order).toMatchObject({ quantity: 4, paymentStatus: 'paid' });
      expect(set.activities).toEqual([
        expect.objectContaining({ kind: 'edit', fields: ['quantity', 'paymentStatus'] }),
      ]);

      // The same values again change nothing and write nothing.
      expect(
        await work.updateLead({ ...scope, order: { quantity: 4, paymentStatus: 'paid' } }),
      ).toMatchObject({ status: 'updated', activities: [] });

      // An inactive plan, or one of another type, is refused as the plan field.
      for (const planId of [simInactive.id, internetPlan.id, foreignPlan.id]) {
        expect(
          await work.updateLead({ ...scope, stage: 'verified', order: { planId, quantity: 9 } }),
        ).toEqual({ status: 'invalid_field', field: 'plan' });
      }
      expect(await orderDetails(leadId)).toMatchObject({ planId: simFree.id, quantity: 4 });

      const cleared = await work.updateLead({ ...scope, order: { planId: null } });
      if (cleared.status !== 'updated') throw new Error(`got ${cleared.status}`);
      expect(cleared.lead.order).toEqual({
        planId: null,
        plan: null,
        quantity: 4,
        paymentStatus: 'paid',
        carrierCommission: 'not_yet',
      });
      expect(cleared.activities).toEqual([
        expect.objectContaining({ kind: 'edit', fields: ['plan'] }),
      ]);
    });

    it('writes only the changed field over the stored order: an unknown key and the copy stay byte for byte', async () => {
      const created = await leadStore.createLead(
        base({ submit: true, order: { planId: simPaid.id, quantity: 1 } }),
      );
      const leadId = created.lead.id;
      // A copy the parse cannot read (no frozenAt, a key of its own) and a key it does not know.
      await admin`
        update app.leads
        set order_details = order_details
          || jsonb_build_object('legacyRef', 'GCS-1042')
          || jsonb_build_object(
            'plan',
            (order_details -> 'plan') - 'frozenAt' || '{"oldSku":"U50-2019"}'::jsonb
          )
        where id = ${leadId}
      `;
      const storedText = async () => {
        const [row] = await admin<{ plan: string; legacyRef: string | null }[]>`
          select (order_details -> 'plan')::text as plan, order_details ->> 'legacyRef' as "legacyRef"
          from app.leads where id = ${leadId}
        `;
        return row;
      };
      const before = await storedText();
      expect(before?.plan).toContain('"oldSku": "U50-2019"');

      const edited = await work.updateLead({ ...ctx, leadId, catalog, order: { quantity: 3 } });
      if (edited.status !== 'updated') throw new Error(`got ${edited.status}`);
      expect(edited.activities).toEqual([
        expect.objectContaining({ kind: 'edit', fields: ['quantity'] }),
      ]);
      expect(await storedText()).toEqual({ plan: before?.plan, legacyRef: 'GCS-1042' });
      expect(await orderDetails(leadId)).toMatchObject({ planId: simPaid.id, quantity: 3 });

      // A status edit on a readable copy keeps it as stored too.
      const readable = await leadStore.createLead(
        base({ submit: true, order: { planId: simPaid.id, quantity: 1 } }),
      );
      const [{ plan: readableBefore } = { plan: '' }] = await admin<{ plan: string }[]>`
        select (order_details -> 'plan')::text as plan from app.leads where id = ${readable.lead.id}
      `;
      const paid = await work.updateLead({
        ...ctx,
        leadId: readable.lead.id,
        catalog,
        order: { paymentStatus: 'paid' },
      });
      expect(paid.status).toBe('updated');
      const [{ plan: readableAfter } = { plan: '' }] = await admin<{ plan: string }[]>`
        select (order_details -> 'plan')::text as plan from app.leads where id = ${readable.lead.id}
      `;
      expect(readableAfter).toBe(readableBefore);
    });

    it('refuses order edits on a type with no order, an archived lead and a restricted one', async () => {
      const message = await leadStore.createLead(
        base({ leadType: 'contact_message', submit: true }),
      );
      expect(
        await work.updateLead({
          ...ctx,
          leadId: message.lead.id,
          catalog,
          order: { quantity: 2 },
        }),
      ).toEqual({ status: 'invalid_field', field: 'order' });

      const archived = await leadStore.createLead(
        base({ submit: true, order: { planId: simPaid.id, quantity: 1 } }),
      );
      await work.setArchived({ ...ctx, leadId: archived.lead.id, archived: true });
      expect(
        await work.updateLead({
          ...ctx,
          leadId: archived.lead.id,
          catalog,
          order: { quantity: 2 },
        }),
      ).toEqual({ status: 'trashed' });

      const restricted = await leadStore.createLead(
        base({ submit: true, order: { planId: simPaid.id, quantity: 1 } }),
      );
      await admin`
        update app.leads set customer_data_restricted_at = now() where id = ${restricted.lead.id}
      `;
      expect(
        await work.updateLead({
          ...ctx,
          leadId: restricted.lead.id,
          catalog,
          order: { quantity: 2 },
        }),
      ).toEqual({ status: 'not_found' });
      expect(await orderDetails(restricted.lead.id)).toMatchObject({ quantity: 1 });
    });
  });

  describe('reads', () => {
    const detail = (leadId: string, includeWork = true) =>
      work.getLead({ ...listCtx, leadId, includeWork, catalog: listCatalog });

    it('shows the order of an order type with the defaults filled in, only with contact access', async () => {
      expect((await detail(L2))?.lead.order).toEqual(DEFAULT_LEAD_ORDER);
      const partial: LeadOrder = { ...DEFAULT_LEAD_ORDER, quantity: 2, paymentStatus: 'pending' };
      expect((await detail(L3))?.lead.order).toEqual(partial);
      expect((await detail(L1))?.lead.order).toEqual({
        planId: listPlan.id,
        plan: null,
        quantity: 3,
        paymentStatus: 'paid',
        carrierCommission: 'not_yet',
      });
      expect((await detail(L4))?.lead).not.toHaveProperty('order');
      expect((await detail(L1, false))?.lead).not.toHaveProperty('order');
    });

    it('reads a lead still on a retired stage', async () => {
      const page = await detail(L_LEGACY);
      expect(page?.lead.stage).toBe('paid');
      expect(page?.lead.order).toEqual(DEFAULT_LEAD_ORDER);
    });

    it('shows the body of a timeline entry a data migration wrote', async () => {
      await admin`delete from app.lead_activities where lead_id = ${L_LEGACY}`;
      await admin`
        insert into app.lead_activities (workspace_id, lead_id, actor_id, kind, body, data)
        values (
          ${LIST_SITE}, ${L_LEGACY}, '00000000-0000-4000-8000-00000000a001', 'system',
          'Stage Paid became Pending; payment status set to Paid (phase 3 migration)',
          '{"migration":"0012"}'::jsonb
        )
      `;
      const page = await detail(L_LEGACY);
      expect(page?.activities).toEqual([
        expect.objectContaining({
          kind: 'system',
          event: 'unknown',
          body: 'Stage Paid became Pending; payment status set to Paid (phase 3 migration)',
        }),
      ]);
    });

    const list = (input: Partial<Parameters<DatabaseLeadStore['listLeads']>[0]>) =>
      leadStore.listLeads({ ...listCtx, catalog: listCatalog, ...input });
    const ids = async (input: Partial<Parameters<DatabaseLeadStore['listLeads']>[0]>) =>
      (await list(input)).leads.map((lead) => lead.id).sort();

    it('filters on order fields over order_details, with the defaults and only for order types', async () => {
      const simOnly = { leadType: 'sim_order' } as const;
      expect(
        await ids({ ...simOnly, where: [{ key: 'paymentStatus', op: 'eq', value: 'paid' }] }),
      ).toEqual([L1]);
      expect(
        await ids({ where: [{ key: 'paymentStatus', op: 'in', value: ['not_needed'] }] }),
      ).toEqual([L2, L_LEGACY]);
      expect(
        await ids({ ...simOnly, where: [{ key: 'plan', op: 'eq', value: listPlan.id }] }),
      ).toEqual([L1]);
      expect(await ids({ ...simOnly, where: [{ key: 'plan', op: 'empty' }] })).toEqual([
        L2,
        L3,
        L_LEGACY,
      ]);
      expect(await ids({ ...simOnly, where: [{ key: 'quantity', op: 'gte', value: 2 }] })).toEqual([
        L1,
        L3,
      ]);
      // A contact message has no order, so it matches no order filter, defaults or not.
      expect(await ids({ where: [{ key: 'quantity', op: 'eq', value: 1 }] })).toEqual([
        L2,
        L_LEGACY,
      ]);
    });

    it('sorts by quantity and returns order columns', async () => {
      const asc = await list({ leadType: 'sim_order', sort: 'prop.quantity:asc' });
      expect(asc.leads.map((lead) => lead.id)).toEqual([L2, L_LEGACY, L3, L1]);
      const desc = await list({ leadType: 'sim_order', sort: 'prop.quantity:desc' });
      expect(desc.leads.map((lead) => lead.id)).toEqual([L1, L3, L2, L_LEGACY]);

      const columns = await list({
        sort: 'createdAt:asc',
        columns: ['plan', 'quantity', 'paymentStatus'],
      });
      expect(Object.fromEntries(columns.leads.map((lead) => [lead.id, lead.properties]))).toEqual({
        [L1]: { plan: listPlan.id, quantity: 3, paymentStatus: 'paid' },
        [L2]: { quantity: 1, paymentStatus: 'not_needed' },
        [L3]: { quantity: 2, paymentStatus: 'pending' },
        [L4]: {},
        [L_LEGACY]: { quantity: 1, paymentStatus: 'not_needed' },
      });
    });

    it('view=trash and view=archived list the same archived leads; the summary counts them', async () => {
      await work.setArchived({ ...listCtx, leadId: L3, archived: true });
      try {
        expect(await ids({ view: 'archived' })).toEqual([L3]);
        expect(await ids({ view: 'trash' })).toEqual([L3]);
        expect(await ids({ view: 'active' })).not.toContain(L3);
        expect(await ids({})).not.toContain(L3);
        const summary = await work.summary(listCtx);
        expect(summary.archived).toBe(1);
      } finally {
        await work.setArchived({ ...listCtx, leadId: L3, archived: false });
      }
    });
  });
});
