import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiErrorResponseSchema,
  listWebsitePlansResponseSchema,
  type WebsitePlan,
} from '@gt-sales/contracts';
import type { WebsiteCredentialResolution } from '@gt-sales/db';

import { createApp } from '../src/app.js';
import type { LeadStore } from '../src/leads/store.js';
import type { PlanStore } from '../src/plans/store.js';
import type { StaffStore } from '../src/staff/store.js';
import { generateServiceSecret } from '../src/website/credential.js';
import type { WebsiteCredentialStore } from '../src/website/store.js';

const WORKSPACE = '10000000-0000-4000-8000-000000000e61';
const CREDENTIAL = '80000000-0000-4000-8000-000000000e61';
const PLAN_ID = '70000000-0000-4000-8000-000000000e61';

const { secret: SECRET, secretHash: SECRET_HASH } = generateServiceSecret();

const websitePlan: WebsitePlan = {
  id: PLAN_ID,
  leadType: 'sim_order',
  name: 'Unlimited 50',
  priceMinor: 5000,
  currency: 'CAD',
  billingPeriod: 'month',
  paymentRequired: true,
  requiredDocuments: ['id_front'],
  properties: { custom_network: 'Rogers' },
};

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

const staffOnly: {
  sessionVerifier: { verify: () => Promise<undefined> };
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
  leadStore: unusedLeadStore,
};

let server: Server;
let baseUrl: string;
let scopes: WebsiteCredentialResolution['scopes'];
let botChecks: number;
let plans: { listForWebsite: ReturnType<typeof vi.fn<PlanStore['listForWebsite']>> };

beforeEach(async () => {
  scopes = ['leads:write'];
  botChecks = 0;
  plans = { listForWebsite: vi.fn<PlanStore['listForWebsite']>(async () => [websitePlan]) };
  const planStore: PlanStore = {
    list: async () => [],
    get: async () => undefined,
    create: async () => ({ kind: 'limit_reached' }),
    update: async () => ({ kind: 'not_found' }),
    listForWebsite: plans.listForWebsite,
    options: async () => [],
  };
  server = createApp({
    staff: staffOnly,
    website: {
      auth: {
        resolveCredential: async (hash) =>
          hash === SECRET_HASH
            ? { credentialId: CREDENTIAL, workspaceId: WORKSPACE, scopes, revoked: false }
            : undefined,
        rateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
        botCheck: async () => {
          botChecks += 1;
          return false;
        },
      },
      leads: { store: unusedLeadStore },
      plans: { store: planStore },
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

function get(query = '', secret: string | null = SECRET) {
  return fetch(`${baseUrl}/api/v1/website/plans${query}`, {
    headers: secret === null ? {} : { authorization: `Bearer ${secret}` },
  });
}

async function errorOf(response: Response) {
  return apiErrorResponseSchema.parse(await response.json()).error;
}

describe('GET /api/v1/website/plans', () => {
  it("lists the credential's site plans with no-store and no bot check", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = listWebsitePlansResponseSchema.parse(await response.json());
    expect(body.plans).toEqual([websitePlan]);
    expect(plans.listForWebsite).toHaveBeenCalledWith(
      { workspaceId: WORKSPACE, actorId: CREDENTIAL },
      undefined,
    );
    expect(botChecks).toBe(0);
  });

  it('passes the leadType filter and refuses a type that takes no plans', async () => {
    expect((await get('?leadType=internet')).status).toBe(200);
    expect(plans.listForWebsite).toHaveBeenLastCalledWith(
      { workspaceId: WORKSPACE, actorId: CREDENTIAL },
      'internet',
    );
    const bad = await get('?leadType=contact_message');
    expect(bad.status).toBe(400);
    expect((await errorOf(bad)).code).toBe('validation_error');
    expect(plans.listForWebsite).toHaveBeenCalledTimes(1);
  });

  it('needs a credential with leads:write', async () => {
    expect((await get('', null)).status).toBe(401);
    expect((await get('', `gtsk_${'0'.repeat(43)}`)).status).toBe(401);
    scopes = ['uploads:customer'];
    expect((await get()).status).toBe(403);
    expect(plans.listForWebsite).not.toHaveBeenCalled();
  });

  it('a store failure is a 500 with no plans', async () => {
    plans.listForWebsite.mockRejectedValueOnce(new Error('broken'));
    const response = await get();
    expect(response.status).toBe(500);
    expect((await errorOf(response)).code).toBe('internal_error');
  });
});
