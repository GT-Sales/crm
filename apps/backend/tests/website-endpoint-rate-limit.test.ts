import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiErrorResponseSchema } from '@gt-sales/contracts';
import type { RateLimitInput, RateLimitResult, WebsiteCredentialResolution } from '@gt-sales/db';

import { createApp } from '../src/app.js';
import type { StaffSessionVerifier } from '../src/auth/session.js';
import type {
  CreateLeadInput,
  CreateLeadResult,
  LeadStore,
  UpdateLeadOutcome,
} from '../src/leads/store.js';
import type { StaffStore } from '../src/staff/store.js';
import type { WebsiteCredentialStore } from '../src/website/store.js';
import { generateServiceSecret } from '../src/website/credential.js';
import { DEFAULT_ENDPOINT_RATE_LIMITS, loadEndpointRateLimits } from '../src/website/session.js';

const WORKSPACE = '10000000-0000-4000-8000-000000000101';
const CREDENTIAL = '80000000-0000-4000-8000-000000000201';
const { secret: VALID_SECRET, secretHash: VALID_HASH } = generateServiceSecret();

class FakeRateLimiter {
  readonly inputs: RateLimitInput[] = [];
  private counts = new Map<string, number>();
  denyPrefixes = new Set<string>();

  hit = async (input: RateLimitInput): Promise<RateLimitResult> => {
    this.inputs.push(input);
    if ([...this.denyPrefixes].some((prefix) => input.bucketKey.startsWith(prefix))) {
      return { allowed: false, retryAfterSeconds: 42 };
    }
    const next = (this.counts.get(input.bucketKey) ?? 0) + 1;
    this.counts.set(input.bucketKey, next);
    return { allowed: next <= input.maxCount, retryAfterSeconds: next <= input.maxCount ? 0 : 42 };
  };
}

class FakeLeadStore implements LeadStore {
  readLead: LeadStore['readLead'] = async () => ({ status: 'grant_invalid' });
  readonly createCalls: CreateLeadInput[] = [];
  async createLead(input: CreateLeadInput): Promise<CreateLeadResult> {
    this.createCalls.push(input);
    return {
      lead: {
        id: '90000000-0000-4000-8000-000000000001',
        workspaceId: input.workspaceId,
        status: 'incomplete',
        updatedAt: '2026-09-14T00:00:00.000Z',
      },
      grant: { token: 'gtdg_test', expiresAt: '2026-10-14T00:00:00.000Z' },
      replayed: false,
    };
  }
  async updateLead(): Promise<UpdateLeadOutcome> {
    throw new Error('unused');
  }
  async listLeads() {
    return { leads: [], page: { page: 1, pageSize: 25, total: 0 } };
  }
}

const staffOnly: {
  sessionVerifier: StaffSessionVerifier;
  store: StaffStore;
  credentialStore: WebsiteCredentialStore;
  leadStore: LeadStore;
} = {
  sessionVerifier: { verify: async () => undefined },
  store: {
    bootstrapStaff: async () => [],
    loadStaffAccess: async () => undefined,
    inviteStaff: async () => {
      throw new Error('unused');
    },
    revokeStaff: async () => 'not_found',
    listAssignableMembers: async () => [],
    setDisplayName: async () => 0,
  },
  credentialStore: {
    createCredential: async () => {
      throw new Error('unused');
    },
    listCredentials: async () => [],
    revokeCredential: async () => ({ status: 'not_found' }),
  },
  leadStore: {
    readLead: async () => ({ status: 'grant_invalid' }),
    createLead: async () => {
      throw new Error('unused');
    },
    updateLead: async () => {
      throw new Error('unused');
    },
    listLeads: async () => ({ leads: [], page: { page: 1, pageSize: 25, total: 0 } }),
  },
};

let server: Server;
let baseUrl: string;
let limiter: FakeRateLimiter;
let leadStore: FakeLeadStore;

const resolution: WebsiteCredentialResolution = {
  credentialId: CREDENTIAL,
  workspaceId: WORKSPACE,
  scopes: ['leads:write', 'uploads:customer'],
  revoked: false,
};

const VALID_LEAD_BODY = { leadType: 'sim_order', consentVersion: 'terms-2026-09' };

function post(path: string, headers: Record<string, string>, body?: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(async () => {
  limiter = new FakeRateLimiter();
  leadStore = new FakeLeadStore();
  server = createApp({
    staff: staffOnly,
    website: {
      auth: {
        resolveCredential: async (hash) => (hash === VALID_HASH ? resolution : undefined),
        rateLimit: limiter.hit,
        botCheck: async () => true,
      },
      leads: { store: leadStore },
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

describe('per-endpoint rate limits', () => {
  it('applies a tighter per-endpoint budget scoped to workspace and authenticated visitor', async () => {
    const response = await post(
      '/api/v1/website/leads',
      { authorization: `Bearer ${VALID_SECRET}` },
      VALID_LEAD_BODY,
    );
    expect(response.status).toBe(201);
    const endpointHit = limiter.inputs.find((input) =>
      input.bucketKey.startsWith(`endpoint:leads:ws:${WORKSPACE}:visitor:`),
    );
    expect(endpointHit).toBeDefined();
    expect(endpointHit?.maxCount).toBe(DEFAULT_ENDPOINT_RATE_LIMITS.leads.maxCount);
    expect(endpointHit?.windowSeconds).toBe(DEFAULT_ENDPOINT_RATE_LIMITS.leads.windowSeconds);
  });

  it('returns 429 when the per-endpoint budget is exhausted even though global limits allow', async () => {
    limiter.denyPrefixes.add('endpoint:leads:');
    const response = await post(
      '/api/v1/website/leads',
      { authorization: `Bearer ${VALID_SECRET}` },
      VALID_LEAD_BODY,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('42');
    expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe('rate_limited');
    // The credential was resolved (global limits ran) but the write never reached the store.
    expect(leadStore.createCalls).toHaveLength(0);
  });

  it('runs the endpoint budget only after the credential is authenticated', async () => {
    const response = await post('/api/v1/website/leads', {}, VALID_LEAD_BODY);
    expect(response.status).toBe(401);
    expect(limiter.inputs.some((input) => input.bucketKey.startsWith('endpoint:'))).toBe(false);
  });
});

describe('loadEndpointRateLimits', () => {
  it('falls back to defaults when env is absent or invalid', () => {
    const limits = loadEndpointRateLimits({ RATE_LIMIT_LEADS_MAX: 'not-a-number' });
    expect(limits.leads).toEqual(DEFAULT_ENDPOINT_RATE_LIMITS.leads);
  });

  it('honours valid positive overrides per endpoint', () => {
    const limits = loadEndpointRateLimits({
      RATE_LIMIT_LEADS_MAX: '5',
      RATE_LIMIT_LEADS_WINDOW: '120',
    });
    expect(limits.leads).toEqual({ maxCount: 5, windowSeconds: 120 });
  });

  it('rejects non-positive overrides', () => {
    const limits = loadEndpointRateLimits({
      RATE_LIMIT_LEADS_MAX: '0',
      RATE_LIMIT_LEADS_WINDOW: '-1',
    });
    expect(limits.leads).toEqual(DEFAULT_ENDPOINT_RATE_LIMITS.leads);
  });
});
