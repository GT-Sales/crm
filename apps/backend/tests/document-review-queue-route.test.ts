import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiErrorResponseSchema,
  documentReviewQueueResponseSchema,
  type StaffWorkspace,
} from '@gt-sales/contracts';

import { createApp } from '../src/app.js';
import type { StaffSessionVerifier, VerifiedStaffSession } from '../src/auth/session.js';
import type { DocumentReviewQueueStore } from '../src/documents/review-queue.js';
import type { LeadStore } from '../src/leads/store.js';
import type { StaffAccessSnapshot } from '../src/staff/authorization.js';
import type { StaffStore } from '../src/staff/store.js';
import type { WebsiteCredentialStore } from '../src/website/store.js';

const ACTOR = '20000000-0000-4000-8000-000000000f81';
const WORKSPACE = '10000000-0000-4000-8000-000000000f81';
const MEMBERSHIP = '30000000-0000-4000-8000-000000000f81';
const VERIFIED = 'owner@example.test';

const workspace: StaffWorkspace = {
  id: WORKSPACE,
  slug: 'getcanadasim',
  name: 'Get Canada Sim',
  membershipId: MEMBERSHIP,
  roles: ['owner'],
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

const LEAD = '40000000-0000-4000-8000-000000000f81';
const FILE = '50000000-0000-4000-8000-000000000f81';

const list = vi.fn<DocumentReviewQueueStore['list']>();
let server: Server;
let baseUrl: string;
let staff: MemoryStaffStore;

beforeEach(async () => {
  staff = new MemoryStaffStore();
  list.mockReset();
  list.mockResolvedValue({
    items: [
      {
        document: {
          id: FILE,
          documentType: 'passport',
          contentType: 'application/pdf',
          sizeBytes: 2048,
          revision: 1,
          createdAt: '2026-11-04T12:00:00.000Z',
          review: null,
        },
        lead: {
          id: LEAD,
          leadType: 'sim_order',
          stage: 'pending',
          externalRef: 'MS-4',
          name: 'Nadia Khan',
        },
        required: true,
      },
    ],
    total: 1,
    counts: { toReview: 1, rejected: 0 },
  });
  server = createApp({
    staff: {
      sessionVerifier: new TokenVerifier(),
      store: staff,
      credentialStore: noopCredentialStore,
      leadStore: unusedLeadStore,
      documentReviewQueue: { list },
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

const queueUrl = (search = '') =>
  `${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/documents/review-queue${search}`;
const get = (url: string) => fetch(url, { headers: { authorization: 'Bearer token' } });

describe('GET /workspaces/:id/documents/review-queue', () => {
  it('answers a page with both totals and what the member may do', async () => {
    const response = await get(queueUrl('?status=rejected&page=2'));
    expect(response.status).toBe(200);
    const body = documentReviewQueueResponseSchema.parse(await response.json());
    expect(body.access).toEqual({ review: true, download: true });
    expect(body.page).toEqual({ page: 2, pageSize: 50, total: 1 });
    expect(body.counts).toEqual({ toReview: 1, rejected: 0 });
    expect(list).toHaveBeenCalledWith(
      { workspaceId: WORKSPACE, actorId: ACTOR },
      { status: 'rejected', page: 2 },
    );
  });

  it('defaults to documents not yet reviewed, and a Leads member may read but not review', async () => {
    staff.access = { ...staff.access, roles: ['leads'] };
    const body = documentReviewQueueResponseSchema.parse(await (await get(queueUrl())).json());
    expect(list.mock.calls[0]?.[1]).toEqual({ status: 'to_review', page: 1 });
    expect(body.access).toEqual({ review: false, download: false });
  });

  it('refuses a role that may not see customer details, before reading', async () => {
    staff.access = { ...staff.access, roles: ['viewer'] };
    const response = await get(queueUrl());
    expect(response.status).toBe(403);
    expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe(
      'permission_denied',
    );
    expect(list).not.toHaveBeenCalled();
  });

  it('rejects an unknown status or query key', async () => {
    expect((await get(queueUrl('?status=approved'))).status).toBe(400);
    expect((await get(queueUrl('?leadId=x'))).status).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });
});
