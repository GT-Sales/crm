import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LEAD_ORDER,
  PLAN_LIMIT,
  createBackendClient,
  createLeadRequestSchema,
  createPlanRequestSchema,
  endpoints,
  freezePlan,
  getWorkspaceLeadResponseSchema,
  initialPaymentStatus,
  isOrderLeadType,
  leadOrderEditSchema,
  leadOrderIntakeSchema,
  leadOrderSchema,
  leadTypeCatalog,
  listPlansQuerySchema,
  listPlansResponseSchema,
  listWebsitePlansQuerySchema,
  listWebsitePlansResponseSchema,
  planSchema,
  planSnapshotSchema,
  updateLeadRequestSchema,
  updatePlanRequestSchema,
  updateWorkspaceLeadRequestSchema,
  websitePlanSchema,
  type Plan,
} from './index';

const UUID_A = '00000000-0000-4000-8000-000000000001';
const UUID_B = '00000000-0000-4000-8000-000000000002';
const NOW = '2026-10-30T12:00:00.000Z';

const PLAN: Plan = {
  id: UUID_A,
  leadType: 'sim_order',
  name: 'Unlimited Data',
  priceMinor: 4000,
  currency: 'CAD',
  billingPeriod: 'month',
  paymentRequired: true,
  active: true,
  requiredDocuments: ['passport', 'visa'],
  customValues: { custom_carrier: 'Rogers', custom_internal_cost: 2500, custom_data_gb: 120 },
  position: 0,
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
};

const SNAPSHOT = {
  planId: UUID_A,
  name: 'Unlimited Data',
  priceMinor: 4000,
  currency: 'CAD',
  billingPeriod: 'month',
  paymentRequired: true,
  requiredDocuments: ['passport'],
  properties: { custom_carrier: 'Rogers' },
  frozenAt: NOW,
};

describe('plans', () => {
  it('accepts a plan and bounds its fields', () => {
    expect(planSchema.parse(PLAN)).toEqual(PLAN);
    expect(planSchema.safeParse({ ...PLAN, currency: 'USD' }).success).toBe(false);
    expect(planSchema.safeParse({ ...PLAN, billingPeriod: 'week' }).success).toBe(false);
    expect(planSchema.safeParse({ ...PLAN, leadType: 'partner_application' }).success).toBe(false);
    expect(planSchema.safeParse({ ...PLAN, priceMinor: -1 }).success).toBe(false);
    expect(planSchema.safeParse({ ...PLAN, priceMinor: 1.5 }).success).toBe(false);
    expect(planSchema.safeParse({ ...PLAN, name: '   ' }).success).toBe(false);
    expect(planSchema.safeParse({ ...PLAN, requiredDocuments: ['Not A Key'] }).success).toBe(false);
    expect(
      planSchema.safeParse({
        ...PLAN,
        requiredDocuments: Array.from({ length: 17 }, (_, index) => `doc_${index}`),
      }).success,
    ).toBe(false);
    expect(PLAN_LIMIT).toBe(200);
  });

  it('creates a plan active with no custom values by default, and never takes a currency or id', () => {
    const created = createPlanRequestSchema.parse({
      leadType: 'internet',
      name: '1Gbps',
      priceMinor: 6500,
      billingPeriod: 'month',
      paymentRequired: false,
      requiredDocuments: [],
    });
    expect(created).toEqual({
      leadType: 'internet',
      name: '1Gbps',
      priceMinor: 6500,
      billingPeriod: 'month',
      paymentRequired: false,
      requiredDocuments: [],
      active: true,
      customValues: {},
    });
    const base = { ...created };
    expect(createPlanRequestSchema.safeParse({ ...base, currency: 'CAD' }).success).toBe(false);
    expect(createPlanRequestSchema.safeParse({ ...base, id: UUID_A }).success).toBe(false);
    expect(createPlanRequestSchema.safeParse({ ...base, billingPeriod: 'weekly' }).success).toBe(
      false,
    );
  });

  it('updates a plan only with a version and something to change; clears a custom value with null', () => {
    expect(
      updatePlanRequestSchema.parse({
        expectedVersion: 2,
        customValues: { custom_carrier: null },
      }),
    ).toEqual({ expectedVersion: 2, customValues: { custom_carrier: null } });
    expect(updatePlanRequestSchema.safeParse({ expectedVersion: 2 }).success).toBe(false);
    expect(updatePlanRequestSchema.safeParse({ name: 'x' }).success).toBe(false);
    expect(updatePlanRequestSchema.safeParse({ expectedVersion: 2, leadType: 'x' }).success).toBe(
      false,
    );
    expect(updatePlanRequestSchema.safeParse({ expectedVersion: 2, position: -1 }).success).toBe(
      false,
    );
    expect(updatePlanRequestSchema.parse({ expectedVersion: 1, active: false })).toEqual({
      expectedVersion: 1,
      active: false,
    });
  });

  it('lists active plans by default', () => {
    expect(listPlansQuerySchema.parse({})).toEqual({ includeInactive: 'false' });
    expect(listPlansQuerySchema.parse({ leadType: 'mobility', includeInactive: 'true' })).toEqual({
      leadType: 'mobility',
      includeInactive: 'true',
    });
    expect(listPlansQuerySchema.safeParse({ leadType: 'contact_message' }).success).toBe(false);
    expect(
      listPlansResponseSchema.safeParse({
        plans: Array.from({ length: PLAN_LIMIT + 1 }, () => PLAN),
        requestId: UUID_B,
      }).success,
    ).toBe(false);
  });

  it('shows a website only the storefront fields of a plan', () => {
    const website = websitePlanSchema.parse({ ...PLAN, properties: { custom_carrier: 'Rogers' } });
    expect(website).toEqual({
      id: UUID_A,
      leadType: 'sim_order',
      name: 'Unlimited Data',
      priceMinor: 4000,
      currency: 'CAD',
      billingPeriod: 'month',
      paymentRequired: true,
      requiredDocuments: ['passport', 'visa'],
      properties: { custom_carrier: 'Rogers' },
    });
    expect('customValues' in website).toBe(false);
    expect('active' in website).toBe(false);
    expect(listWebsitePlansQuerySchema.parse({})).toEqual({});
    expect(
      listWebsitePlansResponseSchema.parse({ plans: [website], requestId: UUID_B }).plans,
    ).toHaveLength(1);
  });
});

describe('plan snapshots and order details', () => {
  it('accepts the default order and a frozen snapshot', () => {
    expect(DEFAULT_LEAD_ORDER).toEqual({
      planId: null,
      plan: null,
      quantity: 1,
      paymentStatus: 'not_needed',
      carrierCommission: 'not_yet',
    });
    expect(leadOrderSchema.parse(DEFAULT_LEAD_ORDER)).toEqual(DEFAULT_LEAD_ORDER);
    expect(planSnapshotSchema.parse(SNAPSHOT)).toEqual(SNAPSHOT);
    const order = {
      planId: UUID_A,
      plan: SNAPSHOT,
      quantity: 2,
      paymentStatus: 'pending',
      carrierCommission: 'invoiced',
    };
    expect(leadOrderSchema.parse(order)).toEqual(order);
  });

  it('rejects a non-CAD snapshot, an unknown billing period and an unknown key', () => {
    expect(planSnapshotSchema.safeParse({ ...SNAPSHOT, currency: 'USD' }).success).toBe(false);
    expect(planSnapshotSchema.safeParse({ ...SNAPSHOT, billingPeriod: 'fortnight' }).success).toBe(
      false,
    );
    expect(planSnapshotSchema.safeParse({ ...SNAPSHOT, customValues: {} }).success).toBe(false);
    expect(leadOrderSchema.safeParse({ ...DEFAULT_LEAD_ORDER, quantity: 0 }).success).toBe(false);
    expect(leadOrderSchema.safeParse({ ...DEFAULT_LEAD_ORDER, quantity: 100 }).success).toBe(false);
    expect(leadOrderSchema.safeParse({ ...DEFAULT_LEAD_ORDER, paymentStatus: 'due' }).success).toBe(
      false,
    );
    expect(
      leadOrderSchema.safeParse({ ...DEFAULT_LEAD_ORDER, carrierCommission: 'paid' }).success,
    ).toBe(false);
    expect(leadOrderSchema.safeParse({ ...DEFAULT_LEAD_ORDER, priceMinor: 100 }).success).toBe(
      false,
    );
  });

  it('takes only a plan and a quantity from the website, never a price', () => {
    expect(leadOrderIntakeSchema.parse({ planId: UUID_A })).toEqual({
      planId: UUID_A,
      quantity: 1,
    });
    expect(leadOrderIntakeSchema.safeParse({ planId: UUID_A, priceMinor: 100 }).success).toBe(
      false,
    );
    expect(leadOrderIntakeSchema.safeParse({ planId: UUID_A, currency: 'CAD' }).success).toBe(
      false,
    );
    expect(leadOrderIntakeSchema.safeParse({ planId: UUID_A, quantity: 0 }).success).toBe(false);
    expect(leadOrderIntakeSchema.safeParse({ planId: UUID_A, quantity: 100 }).success).toBe(false);
    expect(leadOrderIntakeSchema.safeParse({ planId: 'unlimited-data-rogers' }).success).toBe(
      false,
    );
    expect(leadOrderIntakeSchema.safeParse({ quantity: 1 }).success).toBe(false);
  });

  it('lets staff edit the order fields, at least one, and clear the plan', () => {
    expect(leadOrderEditSchema.parse({ planId: null })).toEqual({ planId: null });
    expect(leadOrderEditSchema.parse({ quantity: 3, paymentStatus: 'paid' })).toEqual({
      quantity: 3,
      paymentStatus: 'paid',
    });
    expect(leadOrderEditSchema.parse({ carrierCommission: 'clawback' })).toEqual({
      carrierCommission: 'clawback',
    });
    expect(leadOrderEditSchema.safeParse({}).success).toBe(false);
    expect(leadOrderEditSchema.safeParse({ quantity: 0 }).success).toBe(false);
    expect(leadOrderEditSchema.safeParse({ quantity: 100 }).success).toBe(false);
    expect(leadOrderEditSchema.safeParse({ plan: SNAPSHOT }).success).toBe(false);
    expect(leadOrderEditSchema.safeParse({ priceMinor: 1 }).success).toBe(false);
  });

  it('starts the payment as pending only when the plan requires one', () => {
    const cases: readonly [Pick<Plan, 'paymentRequired'> | null, string][] = [
      [{ paymentRequired: true }, 'pending'],
      [{ paymentRequired: false }, 'not_needed'],
      [null, 'not_needed'],
    ];
    for (const [plan, expected] of cases) {
      expect(initialPaymentStatus(plan)).toBe(expected);
    }
  });

  it('freezes only the website-visible custom values and stamps the time', () => {
    const snapshot = freezePlan(
      PLAN,
      ['custom_carrier', 'custom_data_gb', 'custom_not_on_plan'],
      new Date(NOW),
    );
    expect(snapshot).toEqual({
      planId: UUID_A,
      name: 'Unlimited Data',
      priceMinor: 4000,
      currency: 'CAD',
      billingPeriod: 'month',
      paymentRequired: true,
      requiredDocuments: ['passport', 'visa'],
      properties: { custom_carrier: 'Rogers', custom_data_gb: 120 },
      frozenAt: NOW,
    });
    expect(planSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(freezePlan(PLAN, [], new Date(NOW)).properties).toEqual({});
    // The snapshot is a copy: changing the plan afterwards leaves it alone.
    const documents = [...PLAN.requiredDocuments];
    const plan: Plan = { ...PLAN, requiredDocuments: documents };
    const frozen = freezePlan(plan, [], new Date(NOW));
    documents.push('extra');
    expect(frozen.requiredDocuments).toEqual(['passport', 'visa']);
  });

  it('knows which lead types are orders, as the catalogue marks them', () => {
    expect(isOrderLeadType('sim_order')).toBe(true);
    expect(isOrderLeadType('internet')).toBe(true);
    expect(isOrderLeadType('mobility')).toBe(true);
    expect(isOrderLeadType('partner_application')).toBe(false);
    expect(isOrderLeadType('contact_message')).toBe(false);
    expect(isOrderLeadType('unknown_type')).toBe(false);
    for (const [leadType, entry] of Object.entries(leadTypeCatalog)) {
      expect('order' in entry && entry.order === true).toBe(isOrderLeadType(leadType));
    }
  });
});

describe('order details on leads', () => {
  const lead = {
    leadType: 'sim_order',
    consentVersion: 'v1',
    order: { planId: UUID_A },
  };

  it('takes the chosen plan on website intake and resume', () => {
    expect(createLeadRequestSchema.parse(lead).order).toEqual({ planId: UUID_A, quantity: 1 });
    expect(
      createLeadRequestSchema.parse({ leadType: 'sim_order', consentVersion: 'v1' }).order,
    ).toBeUndefined();
    expect(
      createLeadRequestSchema.safeParse({ ...lead, order: { planId: UUID_A, priceMinor: 1 } })
        .success,
    ).toBe(false);
    expect(updateLeadRequestSchema.parse({ order: { planId: UUID_A, quantity: 2 } }).order).toEqual(
      { planId: UUID_A, quantity: 2 },
    );
    expect(
      updateLeadRequestSchema.safeParse({ order: { planId: UUID_A, quantity: 0 } }).success,
    ).toBe(false);
  });

  it('counts an order edit as a change to the lead', () => {
    expect(updateWorkspaceLeadRequestSchema.parse({ order: { quantity: 2 } })).toEqual({
      order: { quantity: 2 },
    });
    expect(updateWorkspaceLeadRequestSchema.safeParse({ order: {} }).success).toBe(false);
  });

  it('returns the order on the lead detail', () => {
    const detail = {
      lead: {
        id: UUID_A,
        workspaceId: UUID_B,
        leadType: 'sim_order',
        status: 'submitted',
        stage: 'pending',
        contact: {},
        contactId: null,
        assignedActorId: null,
        externalRef: null,
        source: 'direct',
        attribution: {},
        consentVersion: null,
        openTaskCount: 0,
        nextTaskDueAt: null,
        deletedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
        form: null,
        order: { ...DEFAULT_LEAD_ORDER, planId: UUID_A, plan: SNAPSHOT },
      },
      activities: [],
      tasks: [],
      access: { contacts: true, manage: true },
      requestId: UUID_B,
    };
    const parsed = getWorkspaceLeadResponseSchema.safeParse(detail);
    if (!parsed.success) throw parsed.error;
    expect(parsed.data.lead.order?.plan?.name).toBe('Unlimited Data');
  });
});

describe('plan endpoints and client', () => {
  it('registers the staff and website plan routes', () => {
    const byId = new Map(endpoints.map((endpoint) => [endpoint.operationId, endpoint]));
    expect(byId.get('listPlans')).toMatchObject({
      method: 'GET',
      path: '/api/v1/staff/workspaces/{workspaceId}/plans',
      auth: 'staff',
      successStatus: 200,
    });
    expect(byId.get('createPlan')).toMatchObject({
      method: 'POST',
      path: '/api/v1/staff/workspaces/{workspaceId}/plans',
      auth: 'staff',
      successStatus: 201,
    });
    expect(byId.get('updatePlan')).toMatchObject({
      method: 'PATCH',
      path: '/api/v1/staff/workspaces/{workspaceId}/plans/{planId}',
      auth: 'staff',
      successStatus: 200,
    });
    expect(byId.get('listWebsitePlans')).toMatchObject({
      method: 'GET',
      path: '/api/v1/website/plans',
      auth: 'website',
      successStatus: 200,
      query: listWebsitePlansQuerySchema,
    });
  });

  it('calls the plan routes from the typed client', async () => {
    const calls: { method: string; url: string; body: string | undefined }[] = [];
    const client = createBackendClient({
      baseUrl: 'https://api.example.test',
      credential: 'token',
      fetch: async (input, init) => {
        const url = input instanceof URL ? input.href : String(input);
        const body = typeof init?.body === 'string' ? init.body : undefined;
        calls.push({ method: init?.method ?? 'GET', url, body });
        const website = url.includes('/website/');
        const payload =
          init?.method === 'GET'
            ? {
                plans: website ? [{ ...SNAPSHOT, id: UUID_A, leadType: 'sim_order' }] : [PLAN],
                requestId: UUID_B,
              }
            : { plan: PLAN, requestId: UUID_B };
        return new Response(JSON.stringify(payload), { status: 200 });
      },
    });

    await client.plans.list({ leadType: 'sim_order' });
    await client.staff.listPlans(UUID_B, { leadType: 'internet', includeInactive: 'true' });
    await client.staff.createPlan(UUID_B, {
      leadType: 'internet',
      name: '1Gbps',
      priceMinor: 6500,
      billingPeriod: 'month',
      paymentRequired: false,
      requiredDocuments: [],
    });
    await client.staff.updatePlan(UUID_B, UUID_A, { expectedVersion: 1, active: false });

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET https://api.example.test/api/v1/website/plans?leadType=sim_order',
      `GET https://api.example.test/api/v1/staff/workspaces/${UUID_B}/plans?leadType=internet&includeInactive=true`,
      `POST https://api.example.test/api/v1/staff/workspaces/${UUID_B}/plans`,
      `PATCH https://api.example.test/api/v1/staff/workspaces/${UUID_B}/plans/${UUID_A}`,
    ]);
    expect(JSON.parse(calls[2]?.body ?? '{}')).toMatchObject({ active: true, customValues: {} });
  });
});
