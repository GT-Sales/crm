import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiErrorResponseSchema,
  mailboxResponseSchema,
  type StaffWorkspace,
} from '@gt-sales/contracts';

import { createApp } from '../src/app.js';
import type { StaffSessionVerifier, VerifiedStaffSession } from '../src/auth/session.js';
import type { MailboxStore } from '../src/email/mailbox.js';
import type { LeadStore } from '../src/leads/store.js';
import type { StaffAccessSnapshot } from '../src/staff/authorization.js';
import type { StaffStore } from '../src/staff/store.js';
import type { WebsiteCredentialStore } from '../src/website/store.js';

const ACTOR = '20000000-0000-4000-8000-000000000f82';
const WORKSPACE = '10000000-0000-4000-8000-000000000f82';
const MEMBERSHIP = '30000000-0000-4000-8000-000000000f82';
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

const LEAD = '40000000-0000-4000-8000-000000000f82';
const MAIL = '92000000-0000-4000-8000-000000000f82';

const list = vi.fn<MailboxStore['list']>();
let server: Server;
let baseUrl: string;
let staff: MemoryStaffStore;

beforeEach(async () => {
  staff = new MemoryStaffStore();
  list.mockReset();
  list.mockResolvedValue({
    items: [
      {
        id: MAIL,
        createdAt: '2026-11-13T12:00:00.000Z',
        actorId: ACTOR,
        subject: 'Your SIM is on its way',
        text: 'Hi Nadia.',
        mailStatus: 'delivered',
        lead: { id: LEAD, leadType: 'sim_order', name: 'Nadia Khan' },
      },
    ],
    total: 51,
  });
  server = createApp({
    staff: {
      sessionVerifier: new TokenVerifier(),
      store: staff,
      credentialStore: noopCredentialStore,
      leadStore: unusedLeadStore,
      mailbox: { list },
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

const mailUrl = (search = '') => `${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/mail${search}`;
const get = (url: string) => fetch(url, { headers: { authorization: 'Bearer token' } });

describe('GET /workspaces/:id/mail', () => {
  it('answers a page of the site’s sent mail', async () => {
    const response = await get(mailUrl('?page=2'));
    expect(response.status).toBe(200);
    const body = mailboxResponseSchema.parse(await response.json());
    expect(body.page).toEqual({ page: 2, pageSize: 50, total: 51 });
    expect(body.items[0]).toMatchObject({
      subject: 'Your SIM is on its way',
      mailStatus: 'delivered',
      lead: { name: 'Nadia Khan' },
    });
    expect(list).toHaveBeenCalledWith({ workspaceId: WORKSPACE, actorId: ACTOR }, { page: 2 });
  });

  it('opens on the first page, for a member who works leads', async () => {
    staff.access = { ...staff.access, roles: ['leads'] };
    expect((await get(mailUrl())).status).toBe(200);
    expect(list.mock.calls[0]?.[1]).toEqual({ page: 1 });
  });

  it('refuses a role that may not see customer details, before reading', async () => {
    staff.access = { ...staff.access, roles: ['viewer'] };
    const response = await get(mailUrl());
    expect(response.status).toBe(403);
    expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe(
      'permission_denied',
    );
    expect(list).not.toHaveBeenCalled();
  });

  it('rejects an unknown query key', async () => {
    expect((await get(mailUrl('?leadId=x'))).status).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });
});
