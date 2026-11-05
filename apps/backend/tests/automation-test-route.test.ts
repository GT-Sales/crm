import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTOMATION_TEST_RUNS_PER_MINUTE,
  apiErrorResponseSchema,
  type AutomationKey,
  type FlowDefinition,
  type StaffWorkspace,
} from '@gt-sales/contracts';
import type {
  DatabaseClient,
  RateLimitInput,
  RateLimitResult,
  TenantTransaction,
} from '@gt-sales/db';

import { createApp } from '../src/app.js';
import type { StaffSessionVerifier, VerifiedStaffSession } from '../src/auth/session.js';
import type { FlowDetail, FlowStore, StoredFlow } from '../src/automations/flow-store.js';
import type { CustomerEmailEnvironment } from '../src/email/senders.js';
import type { LeadStore } from '../src/leads/store.js';
import type { StaffAccessSnapshot } from '../src/staff/authorization.js';
import type { StaffStore } from '../src/staff/store.js';
import type { WebsiteCredentialStore } from '../src/website/store.js';

/**
 * `POST …/automations/:key/test` can queue real mail from the site's sender.
 * These cases prove the recipient is always the caller's own verified address
 * (never a body value), that each run is audited, and that a member's runs are
 * rate limited. `runFlowTest` itself is covered by the integration suites.
 */

const { runFlowTest, recordFlowTest } = vi.hoisted(() => ({
  runFlowTest: vi.fn(),
  recordFlowTest: vi.fn(async () => undefined),
}));
vi.mock('../src/automations/test-run.js', () => ({ runFlowTest, recordFlowTest }));

const ACTOR = '20000000-0000-4000-8000-000000000f71';
const WORKSPACE = '10000000-0000-4000-8000-000000000f71';
const MEMBERSHIP = '30000000-0000-4000-8000-000000000f71';
const FLOW_ID = '60000000-0000-4000-8000-000000000f71';
const FLOW: AutomationKey = 'flow_abcdefghij012345';
const VERIFIED = 'owner@example.test';

const workspace: StaffWorkspace = {
  id: WORKSPACE,
  slug: 'getcanadasim',
  name: 'Get Canada Sim',
  membershipId: MEMBERSHIP,
  roles: ['owner'],
};

const emailOnly: FlowDefinition = {
  schemaVersion: 1,
  trigger: { kind: 'stage_entered', leadType: 'sim_order', stage: 'verified', when: null },
  steps: [{ id: 's_mail', kind: 'send_email', template: 'activated' }],
};

class TokenVerifier implements StaffSessionVerifier {
  async verify(accessToken: string): Promise<VerifiedStaffSession | undefined> {
    return accessToken === 'token' ? { actorId: ACTOR, verifiedEmail: VERIFIED } : undefined;
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
};

function storedFlow(): StoredFlow {
  return {
    id: FLOW_ID,
    key: FLOW,
    origin: 'custom',
    name: 'Verified follow-up',
    description: null,
    enabled: false,
    archived: false,
    revision: 2,
    activeVersion: {
      id: '70000000-0000-4000-8000-000000000f71',
      version: 1,
      definition: emailOnly,
      activatedAt: new Date('2026-10-29T12:00:00.000Z'),
      activatedBy: ACTOR,
    },
    draft: null,
    lastRunAt: null,
    runCount: 0,
    createdAt: new Date('2026-10-30T12:00:00.000Z'),
  };
}

const detail: FlowDetail = {
  flow: storedFlow(),
  needsAttention: null,
  draft: null,
  active: { version: 1, definition: emailOnly },
  versions: [],
};

const unused = (): never => {
  throw new Error('unused');
};
const flowStore: FlowStore = {
  list: unused,
  get: unused,
  create: unused,
  updateDetails: unused,
  setEnabled: unused,
  archive: unused,
  restore: unused,
  listRuns: unused,
  getRun: unused,
  saveDraft: unused,
  discardDraft: unused,
  activate: unused,
  reset: unused,
  getVersion: unused,
  versions: unused,
  catalog: unused,
  detail: async () => detail,
};

// The run and its audit are mocked, so the transaction is only passed through.
const fakeTx: TenantTransaction = Object.create(null);
const withTenantTx: DatabaseClient['withTenantTx'] = async (_scope, work) => work(fakeTx);

let server: Server;
let baseUrl: string;
let staff: MemoryStaffStore;
let testBuckets: string[];
let testLimit: (input: RateLimitInput) => Promise<RateLimitResult>;

async function rateLimit(input: RateLimitInput): Promise<RateLimitResult> {
  // The staff router's per-IP session limiter shares this dependency.
  if (!input.bucketKey.startsWith('automation_test:'))
    return { allowed: true, retryAfterSeconds: 0 };
  testBuckets.push(input.bucketKey);
  expect(input).toMatchObject({ windowSeconds: 60, maxCount: AUTOMATION_TEST_RUNS_PER_MINUTE });
  return testLimit(input);
}

beforeEach(async () => {
  staff = new MemoryStaffStore();
  recordFlowTest.mockClear();
  testBuckets = [];
  testLimit = async () => ({ allowed: true, retryAfterSeconds: 0 });
  runFlowTest.mockReset();
  runFlowTest.mockResolvedValue({
    status: 'completed',
    reason: null,
    detail: null,
    emailsQueued: 1,
    steps: [],
  });
  server = createApp({
    staff: {
      sessionVerifier: new TokenVerifier(),
      rateLimit,
      store: staff,
      credentialStore: noopCredentialStore,
      leadStore: unusedLeadStore,
      flowStore,
      customerEmail: { environment: emailEnvironment, available: async () => true },
      withTenantTx,
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

function runTest(body: unknown) {
  return fetch(`${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/automations/${FLOW}/test`, {
    method: 'POST',
    headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /workspaces/:id/automations/:key/test', () => {
  it('queues test mail only to the caller’s verified address and audits the run', async () => {
    const response = await runTest({ sendEmail: true });
    expect(response.status).toBe(200);
    expect(runFlowTest).toHaveBeenCalledTimes(1);
    expect(runFlowTest.mock.calls[0]?.[1]).toMatchObject({ email: VERIFIED, flowKey: FLOW });
    expect(recordFlowTest).toHaveBeenCalledWith(fakeTx, {
      scope: { workspaceId: WORKSPACE, actorId: ACTOR, requestId: expect.any(String) },
      flowId: FLOW_ID,
      flowKey: FLOW,
      emailsQueued: 1,
    });
    // Neither the address nor any content is written to the audit.
    expect(JSON.stringify(recordFlowTest.mock.calls)).not.toContain(VERIFIED);
    expect(testBuckets).toEqual([`automation_test:${ACTOR}:${WORKSPACE}`]);
  });

  it('simulates without any recipient when sendEmail is not set', async () => {
    const response = await runTest({});
    expect(response.status).toBe(200);
    expect(runFlowTest.mock.calls[0]?.[1]).not.toHaveProperty('email');
  });

  it('refuses a body that names a recipient address', async () => {
    const response = await runTest({ email: 'victim@example.com' });
    expect(response.status).toBe(400);
    expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe('invalid_request');
    expect(runFlowTest).not.toHaveBeenCalled();
    expect(recordFlowTest).not.toHaveBeenCalled();
  });

  it('answers 429 with retry-after once the member’s per-minute budget is spent', async () => {
    testLimit = async () => ({ allowed: false, retryAfterSeconds: 42 });
    const response = await runTest({ sendEmail: true });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('42');
    expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe('rate_limited');
    expect(runFlowTest).not.toHaveBeenCalled();
  });

  it('refuses rather than sending when the limiter cannot be reached', async () => {
    testLimit = async () => {
      throw new Error('limiter down');
    };
    const response = await runTest({ sendEmail: true });
    expect(response.status).toBe(503);
    expect(runFlowTest).not.toHaveBeenCalled();
  });

  it('refuses a member without integration management before limiting or running', async () => {
    staff.access = { ...staff.access, roles: ['leads'] };
    const response = await runTest({ sendEmail: true });
    expect(response.status).toBe(403);
    expect(testBuckets).toEqual([]);
    expect(runFlowTest).not.toHaveBeenCalled();
  });
});
