import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUILT_IN_AUTOMATIONS,
  BUILT_IN_AUTOMATION_KEYS,
  apiErrorResponseSchema,
  automationResponseSchema,
  listAutomationRunsResponseSchema,
  listAutomationsResponseSchema,
  type StaffWorkspace,
} from '@gt-sales/contracts';
import type { StaffRoleName } from '@gt-sales/types';

import { createApp } from '../src/app.js';
import type { StaffSessionVerifier, VerifiedStaffSession } from '../src/auth/session.js';
import type { AutomationStore, StoredAutomation } from '../src/automations/store.js';
import type { CustomerEmailEnvironment } from '../src/email/senders.js';
import type { LeadStore } from '../src/leads/store.js';
import type { StaffAccessSnapshot } from '../src/staff/authorization.js';
import type { StaffStore } from '../src/staff/store.js';
import type { WebsiteCredentialStore } from '../src/website/store.js';

const ACTOR = '20000000-0000-4000-8000-000000000e61';
const WORKSPACE = '10000000-0000-4000-8000-000000000e61';
const MEMBERSHIP = '30000000-0000-4000-8000-000000000e61';
const LEAD = '40000000-0000-4000-8000-000000000e61';
const RUN = '50000000-0000-4000-8000-000000000e61';
const NOW = new Date('2026-10-30T12:00:00.000Z');

const workspace: StaffWorkspace = {
  id: WORKSPACE,
  slug: 'getcanadasim',
  name: 'Get Canada Sim',
  membershipId: MEMBERSHIP,
  roles: ['owner'],
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

const emailEnvironment: CustomerEmailEnvironment = {
  providerReady: true,
  contactHash: () => {
    throw new Error('unused');
  },
  fallbackSenders: { forWorkspace: () => undefined },
};

const stored = (key: StoredAutomation['key'], enabled = false): StoredAutomation => ({
  key,
  enabled,
  lastRunAt: enabled ? NOW : null,
  runCount: enabled ? 3 : 0,
});

function memoryAutomationStore() {
  return {
    list: vi.fn<AutomationStore['list']>(async () =>
      BUILT_IN_AUTOMATION_KEYS.map((key) => stored(key, key === 'order_received')),
    ),
    setEnabled: vi.fn<AutomationStore['setEnabled']>(async (_ctx, key, enabled) =>
      stored(key, enabled),
    ),
    recordRun: vi.fn<AutomationStore['recordRun']>(async () => {
      throw new Error('unused');
    }),
    listRuns: vi.fn<AutomationStore['listRuns']>(async (_ctx, _key, options) => [
      {
        id: RUN,
        leadId: LEAD,
        leadName: options.includeLeadNames ? 'Ada Lovelace' : null,
        outcome: 'skipped',
        reason: 'no_sender',
        createdAt: NOW,
      },
    ]),
  } satisfies AutomationStore;
}

let server: Server;
let baseUrl: string;
let staff: MemoryStaffStore;
let automations: ReturnType<typeof memoryAutomationStore>;
let senderReady: boolean;
const available = vi.fn();

beforeEach(async () => {
  staff = new MemoryStaffStore();
  automations = memoryAutomationStore();
  senderReady = true;
  available.mockReset();
  available.mockImplementation(async () => senderReady);
  server = createApp({
    staff: {
      sessionVerifier: new TokenVerifier(),
      store: staff,
      credentialStore: noopCredentialStore,
      leadStore: unusedLeadStore,
      automationStore: automations,
      customerEmail: { environment: emailEnvironment, available, fallback: () => undefined },
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

const automationsUrl = (suffix = '') =>
  `${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/automations${suffix}`;

function call(url: string, init: { method?: string; body?: unknown; token?: string } = {}) {
  return fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.token === undefined ? { authorization: 'Bearer token' } : {}),
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function errorOf(response: Response) {
  return apiErrorResponseSchema.parse(await response.json()).error;
}

const asRole = (role: StaffRoleName) => {
  staff.access = { ...staff.access, roles: [role] };
};

const ownerScope = { workspaceId: WORKSPACE, actorId: ACTOR };

describe('staff automation routes', () => {
  it('GET /automations: the six rules merged with their stored state, for every role that reads the site', async () => {
    for (const role of ['viewer', 'leads', 'orders', 'finance', 'owner'] as const) {
      asRole(role);
      const response = await call(automationsUrl());
      expect(response.status, role).toBe(200);
      const body = listAutomationsResponseSchema.parse(await response.json());
      expect(body.automations.map(({ key }) => key)).toEqual([...BUILT_IN_AUTOMATION_KEYS]);
      expect(body.canManage, role).toBe(role === 'owner');
      expect(body.hasSender).toBe(true);

      const [first, second] = body.automations;
      const definition = BUILT_IN_AUTOMATIONS[0];
      expect(first).toEqual({
        key: 'order_received',
        label: definition?.label,
        trigger: definition?.trigger,
        action: definition?.action,
        enabled: true,
        lastRunAt: NOW.toISOString(),
        runCount: 3,
      });
      expect(second).toMatchObject({ enabled: false, lastRunAt: null, runCount: 0 });
    }
    expect(automations.list).toHaveBeenLastCalledWith(ownerScope);
  });

  it('GET /automations: hasSender follows the customer email dependency for this site and actor', async () => {
    senderReady = false;
    const response = await call(automationsUrl());
    expect(listAutomationsResponseSchema.parse(await response.json()).hasSender).toBe(false);
    expect(available).toHaveBeenCalledWith(ownerScope);

    senderReady = true;
    const again = await call(automationsUrl());
    expect(listAutomationsResponseSchema.parse(await again.json()).hasSender).toBe(true);
  });

  it('GET /automations: a deployment without customer mail has no sender', async () => {
    const bare = createApp({
      staff: {
        sessionVerifier: new TokenVerifier(),
        store: staff,
        credentialStore: noopCredentialStore,
        leadStore: unusedLeadStore,
        automationStore: automations,
      },
    }).listen(0);
    try {
      await new Promise<void>((resolve) => bare.once('listening', resolve));
      const address = bare.address();
      if (address === null || typeof address === 'string') throw new Error('expected TCP server');
      const response = await call(
        `http://127.0.0.1:${address.port}/api/v1/staff/workspaces/${WORKSPACE}/automations`,
      );
      expect(listAutomationsResponseSchema.parse(await response.json()).hasSender).toBe(false);
    } finally {
      await new Promise<void>((resolve) => bare.close(() => resolve()));
    }
  });

  it('GET /automations: refuses a revoked member, a bad site id and a missing session', async () => {
    staff.access = { ...staff.access, status: 'revoked' };
    expect((await call(automationsUrl())).status).toBe(403);
    expect(automations.list).not.toHaveBeenCalled();

    expect((await call(`${baseUrl}/api/v1/staff/workspaces/nope/automations`)).status).toBe(400);
    expect((await call(automationsUrl(), { token: 'none' })).status).toBe(401);
  });

  it('PUT /automations/:key: only integration management switches a rule', async () => {
    const url = automationsUrl('/sim_order_dispatched');
    for (const role of ['viewer', 'leads', 'orders', 'finance'] as const) {
      asRole(role);
      const response = await call(url, { method: 'PUT', body: { enabled: true } });
      expect(response.status, role).toBe(403);
      expect((await errorOf(response)).code).toBe('permission_denied');
    }
    expect(automations.setEnabled).not.toHaveBeenCalled();

    asRole('owner');
    const response = await call(url, { method: 'PUT', body: { enabled: true } });
    expect(response.status).toBe(200);
    const body = automationResponseSchema.parse(await response.json());
    expect(body.automation).toMatchObject({
      key: 'sim_order_dispatched',
      label: BUILT_IN_AUTOMATIONS[2]?.label,
      enabled: true,
    });
    expect(automations.setEnabled).toHaveBeenCalledTimes(1);
    expect(automations.setEnabled).toHaveBeenCalledWith(
      { ...ownerScope, requestId: expect.any(String) },
      'sim_order_dispatched',
      true,
    );

    const off = await call(url, { method: 'PUT', body: { enabled: false } });
    expect(automationResponseSchema.parse(await off.json()).automation.enabled).toBe(false);
  });

  it('PUT /automations/:key: an individual integration permission switches a rule', async () => {
    staff.access = {
      ...staff.access,
      roles: ['viewer'],
      permissions: [{ name: 'integration_management', effect: 'allow' }],
    };
    const response = await call(automationsUrl('/order_received'), {
      method: 'PUT',
      body: { enabled: true },
    });
    expect(response.status).toBe(200);
  });

  it('PUT /automations/:key: an unknown key is 404 automation_not_found; a bad body is 400', async () => {
    const unknown = await call(automationsUrl('/custom_x'), {
      method: 'PUT',
      body: { enabled: true },
    });
    expect(unknown.status).toBe(404);
    const error = await errorOf(unknown);
    expect(error.code).toBe('automation_not_found');
    expect(error.message).toBe('No automation rule with this key on this site.');

    // A caller without the permission learns nothing about which keys exist.
    asRole('viewer');
    const refused = await call(automationsUrl('/custom_x'), {
      method: 'PUT',
      body: { enabled: true },
    });
    expect(refused.status).toBe(403);
    asRole('owner');

    for (const body of [{ enabled: 'yes' }, {}, { enabled: true, label: 'x' }, [true]]) {
      const response = await call(automationsUrl('/order_received'), { method: 'PUT', body });
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect((await errorOf(response)).code).toBe('invalid_request');
    }
    expect(automations.setEnabled).not.toHaveBeenCalled();
  });

  it('GET /automations/:key/runs: lead names only for roles that see contacts', async () => {
    const url = automationsUrl('/order_received/runs');
    const expectations = [
      ['viewer', null],
      ['partners', null],
      ['content', null],
      ['leads', 'Ada Lovelace'],
      ['orders', 'Ada Lovelace'],
      ['finance', 'Ada Lovelace'],
      ['owner', 'Ada Lovelace'],
    ] as const;
    for (const [role, leadName] of expectations) {
      asRole(role);
      const response = await call(url);
      expect(response.status, role).toBe(200);
      const body = listAutomationRunsResponseSchema.parse(await response.json());
      expect(body.runs, role).toEqual([
        {
          id: RUN,
          leadId: LEAD,
          leadName,
          outcome: 'skipped',
          reason: 'no_sender',
          createdAt: NOW.toISOString(),
        },
      ]);
      expect(automations.listRuns).toHaveBeenLastCalledWith(ownerScope, 'order_received', {
        limit: 50,
        includeLeadNames: leadName !== null,
      });
    }
  });

  it('GET /automations/:key/runs: an unknown key is 404 and a revoked member is refused', async () => {
    const unknown = await call(automationsUrl('/custom_x/runs'));
    expect(unknown.status).toBe(404);
    expect((await errorOf(unknown)).code).toBe('automation_not_found');
    expect(automations.listRuns).not.toHaveBeenCalled();

    staff.access = { ...staff.access, status: 'revoked' };
    expect((await call(automationsUrl('/order_received/runs'))).status).toBe(403);
    expect(automations.listRuns).not.toHaveBeenCalled();
  });

  it('a store failure is a 500 internal_error without detail', async () => {
    automations.list.mockRejectedValueOnce(new Error('boom: ada@example.test'));
    const response = await call(automationsUrl());
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain('ada@example.test');
    expect(apiErrorResponseSchema.parse(JSON.parse(text)).error.code).toBe('internal_error');
  });
});
