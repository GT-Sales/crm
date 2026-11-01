import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AI_ASSISTANT_LIMITS,
  aiCapabilitiesResponseSchema,
  apiErrorResponseSchema,
  type StaffWorkspace,
} from '@gt-sales/contracts';
import type { StaffRoleName } from '@gt-sales/types';

import { createApp } from '../src/app.js';
import type { StaffSessionVerifier, VerifiedStaffSession } from '../src/auth/session.js';
import type { AiAssistantConfig } from '../src/ai/config.js';
import type { AiSiteContextStore } from '../src/ai/site-context.js';
import type { LeadStore } from '../src/leads/store.js';
import type { StaffAccessSnapshot } from '../src/staff/authorization.js';
import type { StaffStore } from '../src/staff/store.js';
import type { WebsiteCredentialStore } from '../src/website/store.js';

const ACTOR = '20000000-0000-4000-8000-000000000a71';
const WORKSPACE = '10000000-0000-4000-8000-000000000a71';
const MEMBERSHIP = '30000000-0000-4000-8000-000000000a71';

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
  access: StaffAccessSnapshot | undefined = {
    membershipId: MEMBERSHIP,
    status: 'active',
    roles: ['owner'],
    permissions: [],
  };
  setDisplayName = async () => 1;
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

const site: Awaited<ReturnType<AiSiteContextStore['siteContext']>> = {
  siteId: WORKSPACE,
  slug: 'getcanadasim',
  name: 'Get Canada Sim',
  leadTypes: ['sim_order', 'internet'],
};

function contextStore(
  value: Awaited<ReturnType<AiSiteContextStore['siteContext']>> | null = site,
): AiSiteContextStore {
  return { siteContext: async () => (value === null ? undefined : value) };
}

function enabledConfig(overrides: Partial<AiAssistantConfig> = {}): AiAssistantConfig {
  return {
    enabled: true,
    apiKey: 'test-key-not-real',
    modelId: 'test/model',
    workspaceIds: new Set([WORKSPACE]),
    ...overrides,
  };
}

let server: Server;
let baseUrl: string;
let staff: MemoryStaffStore;

function appWith(config: AiAssistantConfig, siteContext = contextStore()) {
  return createApp({
    staff: {
      sessionVerifier: new TokenVerifier(),
      store: staff,
      credentialStore: noopCredentialStore,
      leadStore: unusedLeadStore,
      ai: { config, siteContext },
    },
  });
}

async function start(app = appWith(enabledConfig())) {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected TCP server');
  baseUrl = `http://127.0.0.1:${address.port}`;
}

beforeEach(() => {
  staff = new MemoryStaffStore();
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const capabilitiesUrl = (id = WORKSPACE) =>
  `${baseUrl}/api/v1/staff/workspaces/${id}/ai/capabilities`;

function call(url: string, token: string | null = 'token') {
  return fetch(url, {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}

describe('GET /workspaces/:id/ai/capabilities', () => {
  it('answers a signed-in owner on an enabled site with its site and limits', async () => {
    await start();
    const response = await call(capabilitiesUrl());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = aiCapabilitiesResponseSchema.parse(await response.json());
    expect(body.available).toBe(true);
    expect(body.reason).toBeUndefined();
    expect(body.site).toEqual({ id: WORKSPACE, slug: 'getcanadasim', name: 'Get Canada Sim' });
    expect(body.leadTypes).toEqual(['sim_order', 'internet']);
    expect(body.limits.maxMessageChars).toBe(AI_ASSISTANT_LIMITS.maxMessageChars);
    expect(body.limits.maxHistoryMessages).toBe(AI_ASSISTANT_LIMITS.maxHistoryMessages);
  });

  it('requires a staff session before touching the database', async () => {
    await start();
    const response = await call(capabilitiesUrl(), null);
    expect(response.status).toBe(401);
    expect((await apiErrorResponseSchema.parse(await response.json())).error.code).toBe(
      'missing_session',
    );
  });

  it('rejects a site id that is not a uuid', async () => {
    await start();
    const response = await call(capabilitiesUrl('not-a-uuid'));
    expect(response.status).toBe(400);
  });

  it('denies a view-only role: the assistant is not an aggregate side door', async () => {
    staff.access = {
      membershipId: MEMBERSHIP,
      status: 'active',
      roles: ['viewer'],
      permissions: [],
    };
    await start();
    const response = await call(capabilitiesUrl());
    expect(response.status).toBe(403);
    expect((await apiErrorResponseSchema.parse(await response.json())).error.code).toBe(
      'permission_denied',
    );
  });

  it.each<[string, StaffRoleName, boolean]>([
    ['owner', 'owner', true],
    ['leads', 'leads', true],
    ['orders', 'orders', true],
    ['finance', 'finance', true],
    ['partners', 'partners', false],
    ['content', 'content', false],
    ['viewer', 'viewer', false],
  ])('role %s is allowed: %s', async (_name, role, allowed) => {
    staff.access = { membershipId: MEMBERSHIP, status: 'active', roles: [role], permissions: [] };
    await start();
    const response = await call(capabilitiesUrl());
    expect(response.status).toBe(allowed ? 200 : 403);
  });

  it('denies a role that grants only workspace.read even with unrelated allows', async () => {
    staff.access = {
      membershipId: MEMBERSHIP,
      status: 'active',
      roles: ['viewer'],
      permissions: [
        { name: 'bulk_export', effect: 'allow' },
        { name: 'invoice_approval', effect: 'allow' },
      ],
    };
    await start();
    // None of those permissions maps to a lead-detail action, so the gate still
    // closes: the assistant is not a side door for a read-only role.
    const response = await call(capabilitiesUrl());
    expect(response.status).toBe(403);
  });

  it('keeps an owner allowed when unrelated individual denies are set', async () => {
    staff.access = {
      membershipId: MEMBERSHIP,
      status: 'active',
      roles: ['owner'],
      permissions: [
        { name: 'financial_data', effect: 'deny' },
        { name: 'bulk_export', effect: 'deny' },
      ],
    };
    await start();
    const response = await call(capabilitiesUrl());
    expect(response.status).toBe(200);
  });

  it('denies a revoked membership', async () => {
    staff.access = {
      membershipId: MEMBERSHIP,
      status: 'revoked',
      roles: ['owner'],
      permissions: [],
    };
    await start();
    const response = await call(capabilitiesUrl());
    expect(response.status).toBe(403);
    expect((await apiErrorResponseSchema.parse(await response.json())).error.code).toBe(
      'membership_revoked',
    );
  });

  it('reports the feature disabled without failing the rest of the app', async () => {
    await start(
      appWith({ enabled: false, reason: 'disabled', workspaceIds: new Set([WORKSPACE]) }),
    );
    const response = await call(capabilitiesUrl());
    expect(response.status).toBe(200);
    const body = aiCapabilitiesResponseSchema.parse(await response.json());
    expect(body.available).toBe(false);
    expect(body.reason).toBe('disabled');
  });

  it('reports a deployment missing its key or model as not configured', async () => {
    await start(appWith({ enabled: false, reason: 'not_configured', workspaceIds: new Set() }));
    const body = aiCapabilitiesResponseSchema.parse(await (await call(capabilitiesUrl())).json());
    expect(body.available).toBe(false);
    expect(body.reason).toBe('not_configured');
  });

  it('reports a site outside the allowlist as not enabled', async () => {
    await start(
      appWith(enabledConfig({ workspaceIds: new Set(['10000000-0000-4000-8000-000000000fff']) })),
    );
    const body = aiCapabilitiesResponseSchema.parse(await (await call(capabilitiesUrl())).json());
    expect(body.available).toBe(false);
    expect(body.reason).toBe('site_not_enabled');
  });

  it('answers 404 when the site cannot be read', async () => {
    await start(appWith(enabledConfig(), contextStore(null)));
    const response = await call(capabilitiesUrl());
    expect(response.status).toBe(404);
  });

  it('answers 401 for an unknown bearer token', async () => {
    await start();
    const response = await call(capabilitiesUrl(), 'other-token');
    expect(response.status).toBe(401);
  });
});
