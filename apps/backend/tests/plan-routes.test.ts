import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiErrorResponseSchema,
  listPlansResponseSchema,
  planResponseSchema,
  type Plan,
  type StaffWorkspace,
} from '@gt-sales/contracts';
import type { StaffRoleName } from '@gt-sales/types';

import { createApp } from '../src/app.js';
import type { StaffSessionVerifier, VerifiedStaffSession } from '../src/auth/session.js';
import type { LeadStore } from '../src/leads/store.js';
import type { PlanStore } from '../src/plans/store.js';
import type { PropertyContext } from '../src/properties/store.js';
import type { StaffAccessSnapshot } from '../src/staff/authorization.js';
import type { StaffStore } from '../src/staff/store.js';
import type { WebsiteCredentialStore } from '../src/website/store.js';

const ACTOR = '20000000-0000-4000-8000-000000000e51';
const WORKSPACE = '10000000-0000-4000-8000-000000000e51';
const MEMBERSHIP = '30000000-0000-4000-8000-000000000e51';
const PLAN_ID = '70000000-0000-4000-8000-000000000e51';
const NOW = '2026-10-30T12:00:00.000Z';

const workspace: StaffWorkspace = {
  id: WORKSPACE,
  slug: 'getcanadasim',
  name: 'Get Canada Sim',
  membershipId: MEMBERSHIP,
  roles: ['owner'],
};

const plan: Plan = {
  id: PLAN_ID,
  leadType: 'sim_order',
  name: 'Unlimited 50',
  priceMinor: 5000,
  currency: 'CAD',
  billingPeriod: 'month',
  paymentRequired: true,
  active: true,
  requiredDocuments: [],
  customValues: { custom_network: 'Rogers' },
  position: 0,
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
};

class TokenVerifier implements StaffSessionVerifier {
  readonly sessions = new Map<string, VerifiedStaffSession>([
    ['token', { actorId: ACTOR, verifiedEmail: 'owner@example.test' }],
  ]);
  async verify(accessToken: string) {
    return this.sessions.get(accessToken);
  }
}

class MemoryStaffStore implements StaffStore {
  access: StaffAccessSnapshot = {
    membershipId: MEMBERSHIP,
    status: 'active',
    roles: ['owner'],
    permissions: [],
  };
  setDisplayName = vi.fn(async () => 1);
  async bootstrapStaff() {
    return [workspace];
  }
  async loadStaffAccess(actorId: string, workspaceId: string) {
    return actorId === ACTOR && workspaceId === WORKSPACE ? this.access : undefined;
  }
  async inviteStaff(): Promise<string> {
    throw new Error('unused');
  }
  async revokeStaff() {
    return 'not_found' as const;
  }
  async listAssignableMembers() {
    return [];
  }
}

const unusedLeadStore: LeadStore = {
  readLead: async () => ({ status: 'grant_invalid' }),
  createLead: () => {
    throw new Error('unused');
  },
  updateLead: () => {
    throw new Error('unused');
  },
  listLeads: () => {
    throw new Error('unused');
  },
};

const noopCredentialStore: WebsiteCredentialStore = {
  createCredential: async () => {
    throw new Error('unused');
  },
  listCredentials: async () => [],
  revokeCredential: async () => ({ status: 'not_found' }),
};

function memoryPlanStore() {
  return {
    list: vi.fn<PlanStore['list']>(async () => [plan]),
    get: vi.fn<PlanStore['get']>(async () => plan),
    create: vi.fn<PlanStore['create']>(async (_ctx, input) => ({
      kind: 'created',
      plan: { ...plan, name: input.name, priceMinor: input.priceMinor },
    })),
    update: vi.fn<PlanStore['update']>(async (_ctx, _planId, input) => ({
      kind: 'updated',
      plan: { ...plan, name: input.name ?? plan.name, version: input.expectedVersion + 1 },
    })),
    listForWebsite: vi.fn<PlanStore['listForWebsite']>(async () => []),
    options: vi.fn<PlanStore['options']>(async () => []),
  } satisfies PlanStore;
}

let server: Server;
let baseUrl: string;
let store: MemoryStaffStore;
let plans: ReturnType<typeof memoryPlanStore>;

beforeEach(async () => {
  store = new MemoryStaffStore();
  plans = memoryPlanStore();
  server = createApp({
    staff: {
      sessionVerifier: new TokenVerifier(),
      store,
      credentialStore: noopCredentialStore,
      leadStore: unusedLeadStore,
      planStore: plans,
    },
  }).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected TCP server');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const plansUrl = (suffix = '') => `${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/plans${suffix}`;

function call(url: string, init: { method?: string; body?: unknown } = {}) {
  return fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      authorization: 'Bearer token',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function errorOf(response: Response) {
  return apiErrorResponseSchema.parse(await response.json()).error;
}

const asRole = (role: StaffRoleName) => {
  store.access = { ...store.access, roles: [role] };
};

const ownerContext: PropertyContext = {
  workspaceId: WORKSPACE,
  actorId: ACTOR,
  requestId: expect.any(String),
};

const createBody = {
  leadType: 'sim_order',
  name: 'Unlimited 60',
  priceMinor: 6000,
  billingPeriod: 'month',
  paymentRequired: true,
  requiredDocuments: [],
};

describe('staff plan routes', () => {
  it('GET /plans: every role that reads the site, with the type and inactive filters', async () => {
    for (const role of ['viewer', 'leads', 'orders', 'finance', 'owner'] as const) {
      asRole(role);
      const response = await call(plansUrl());
      expect(response.status, role).toBe(200);
      expect(listPlansResponseSchema.parse(await response.json()).plans).toEqual([plan]);
    }
    expect(plans.list).toHaveBeenLastCalledWith(ownerContext, { includeInactive: false });

    await call(plansUrl('?leadType=internet&includeInactive=true'));
    expect(plans.list).toHaveBeenLastCalledWith(ownerContext, {
      leadType: 'internet',
      includeInactive: true,
    });

    const calls = plans.list.mock.calls.length;
    for (const query of ['?leadType=contact_message', '?includeInactive=yes']) {
      const response = await call(plansUrl(query));
      expect(response.status, query).toBe(400);
      expect((await errorOf(response)).code).toBe('invalid_request');
    }
    expect((await call(`${baseUrl}/api/v1/staff/workspaces/nope/plans`)).status).toBe(400);

    store.access = { ...store.access, status: 'revoked' };
    expect((await call(plansUrl())).status).toBe(403);
    expect(plans.list).toHaveBeenCalledTimes(calls);
  });

  it('POST /plans: orders and owner create (201); others are refused; outcomes map to codes', async () => {
    for (const role of ['viewer', 'leads', 'finance'] as const) {
      asRole(role);
      expect((await call(plansUrl(), { method: 'POST', body: createBody })).status, role).toBe(403);
    }
    expect(plans.create).not.toHaveBeenCalled();

    for (const role of ['orders', 'owner'] as const) {
      asRole(role);
      const response = await call(plansUrl(), { method: 'POST', body: createBody });
      expect(response.status, role).toBe(201);
      expect(planResponseSchema.parse(await response.json()).plan).toMatchObject({
        name: 'Unlimited 60',
        priceMinor: 6000,
      });
    }
    expect(plans.create).toHaveBeenLastCalledWith(ownerContext, {
      ...createBody,
      active: true,
      customValues: {},
    });

    const cases = [
      [{ kind: 'name_taken' }, 409, 'plan_name_taken', undefined],
      [{ kind: 'limit_reached' }, 409, 'plan_limit', undefined],
      [
        { kind: 'invalid_custom_value', field: 'custom_network' },
        400,
        'invalid_request',
        { field: 'custom_network' },
      ],
    ] as const;
    for (const [outcome, status, code, details] of cases) {
      plans.create.mockResolvedValueOnce(outcome);
      const response = await call(plansUrl(), { method: 'POST', body: createBody });
      expect(response.status, code).toBe(status);
      const error = await errorOf(response);
      expect(error.code).toBe(code);
      expect(error.details).toEqual(details);
    }

    const created = plans.create.mock.calls.length;
    for (const body of [
      { ...createBody, leadType: 'partner_application' },
      { ...createBody, name: '' },
      { ...createBody, priceMinor: -1 },
      { ...createBody, currency: 'USD' },
    ]) {
      const response = await call(plansUrl(), { method: 'POST', body });
      expect(response.status).toBe(400);
      expect((await errorOf(response)).code).toBe('invalid_request');
    }
    expect(plans.create).toHaveBeenCalledTimes(created);
  });

  it('PATCH /plans/:planId: orders and owner update; outcomes map to codes', async () => {
    const url = plansUrl(`/${PLAN_ID}`);
    for (const role of ['viewer', 'leads', 'finance'] as const) {
      asRole(role);
      const response = await call(url, {
        method: 'PATCH',
        body: { expectedVersion: 1, name: 'x' },
      });
      expect(response.status, role).toBe(403);
    }
    expect(plans.update).not.toHaveBeenCalled();

    asRole('orders');
    const response = await call(url, {
      method: 'PATCH',
      body: { expectedVersion: 1, name: 'Unlimited 55', customValues: { custom_network: null } },
    });
    expect(response.status).toBe(200);
    expect(planResponseSchema.parse(await response.json()).plan).toMatchObject({
      name: 'Unlimited 55',
      version: 2,
    });
    expect(plans.update).toHaveBeenCalledWith(ownerContext, PLAN_ID, {
      expectedVersion: 1,
      name: 'Unlimited 55',
      customValues: { custom_network: null },
    });

    const cases = [
      [{ kind: 'not_found' }, 404, 'plan_not_found', undefined],
      [{ kind: 'version_conflict' }, 409, 'version_conflict', undefined],
      [{ kind: 'name_taken' }, 409, 'plan_name_taken', undefined],
      [
        { kind: 'invalid_custom_value', field: 'custom_data' },
        400,
        'invalid_request',
        { field: 'custom_data' },
      ],
    ] as const;
    for (const [outcome, status, code, details] of cases) {
      plans.update.mockResolvedValueOnce(outcome);
      const result = await call(url, { method: 'PATCH', body: { expectedVersion: 1, name: 'x' } });
      expect(result.status, code).toBe(status);
      const error = await errorOf(result);
      expect(error.code).toBe(code);
      expect(error.details).toEqual(details);
    }

    const updated = plans.update.mock.calls.length;
    for (const [path, body] of [
      [`/${PLAN_ID}`, { expectedVersion: 1 }],
      [`/${PLAN_ID}`, { expectedVersion: 1, leadType: 'internet' }],
      ['/not-a-uuid', { expectedVersion: 1, name: 'x' }],
    ] as const) {
      const result = await call(plansUrl(path), { method: 'PATCH', body });
      expect(result.status).toBe(400);
      expect((await errorOf(result)).code).toBe('invalid_request');
    }
    expect(plans.update).toHaveBeenCalledTimes(updated);
  });

  it('a store failure is a 500', async () => {
    plans.list.mockRejectedValueOnce(new Error('database down'));
    const response = await call(plansUrl());
    expect(response.status).toBe(500);
    expect((await errorOf(response)).code).toBe('internal_error');
  });
});
