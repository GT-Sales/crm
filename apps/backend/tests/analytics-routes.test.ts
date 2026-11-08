import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { analyticsResponseSchema, type StaffWorkspace } from '@gt-sales/contracts';
import type { ErrorTracker } from '@gt-sales/adapters';
import type { StaffRoleName } from '@gt-sales/types';

import { createApp } from '../src/app.js';
import type { StaffSessionVerifier, VerifiedStaffSession } from '../src/auth/session.js';
import type { LeadStore } from '../src/leads/store.js';
import type { AnalyticsFigures, AnalyticsStore } from '../src/analytics/store.js';
import type { StaffAccessSnapshot } from '../src/staff/authorization.js';
import type { StaffStore } from '../src/staff/store.js';
import type { WebsiteCredentialStore } from '../src/website/store.js';

const ACTOR = '20000000-0000-4000-8000-00000000a751';
const WORKSPACE = '10000000-0000-4000-8000-00000000a751';
const MEMBERSHIP = '30000000-0000-4000-8000-00000000a751';

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

const figures: AnalyticsFigures = {
  range: { from: '2026-11-01', to: '2026-11-07', days: 7 },
  comparison: { from: '2026-10-25', to: '2026-10-31' },
  group: 'day',
  leadType: 'sim_order',
  kpis: {
    newLeads: { current: 4, previous: 2 },
    won: { current: 2, previous: 1 },
    paid: { current: 1, previous: 0 },
    followUps: { due: 2, overdue: 1 },
    documentsToReview: 3,
  },
  trend: [{ bucket: '2026-11-01', current: 4, previous: 2 }],
  stages: [{ leadType: 'sim_order', stage: 'pending', total: 4 }],
  sources: [{ key: 'google', total: 3 }],
  partners: [{ code: 'PT-7', name: null, total: 1 }],
  mix: {
    plans: [{ planId: null, name: 'No plan matched', total: 4 }],
    delivery: [{ key: 'esim', total: 4 }],
    leadTypes: [{ leadType: 'sim_order', total: 4 }],
  },
  statuses: { payment: [{ key: 'paid', total: 1 }], commission: [{ key: 'not_yet', total: 4 }] },
  team: [{ actorId: null, assigned: 4, won: 2, overdue: 0 }],
  commission: {
    earnedMinor: { current: 4000, previous: 0 },
    expectedMinor: 500,
    wonWithoutCommission: 1,
    anyPlanHasCommission: true,
    wonDateBasis: 'status_change_else_created',
  },
  commissionTrend: [{ bucket: '2026-11-01', earnedMinor: 4000 }],
};

let server: Server;
let baseUrl: string;
let store: MemoryStaffStore;
let analytics: { analytics: ReturnType<typeof vi.fn<AnalyticsStore['analytics']>> };
let captureException: ReturnType<typeof vi.fn<ErrorTracker['captureException']>>;

beforeEach(async () => {
  store = new MemoryStaffStore();
  analytics = { analytics: vi.fn<AnalyticsStore['analytics']>(async () => figures) };
  captureException = vi.fn<ErrorTracker['captureException']>();
  server = createApp({
    staff: {
      sessionVerifier: new TokenVerifier(),
      store,
      credentialStore: noopCredentialStore,
      leadStore: unusedLeadStore,
      analyticsStore: analytics,
      errorTracker: { captureException },
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

const url = (query: string, workspaceId = WORKSPACE) =>
  `${baseUrl}/api/v1/staff/workspaces/${workspaceId}/analytics${query}`;

function call(target: string) {
  return fetch(target, { headers: { authorization: 'Bearer token' } });
}

function asRole(role: StaffRoleName) {
  store.access = { ...store.access, roles: [role] };
}

describe('GET /workspaces/:id/analytics', () => {
  it('gives the owner every figure, money included, and passes the parsed query on', async () => {
    const response = await call(
      url('?from=2026-11-01&to=2026-11-07&leadType=sim_order&partner=PT-7&assignee=me'),
    );
    expect(response.status).toBe(200);
    const body = analyticsResponseSchema.parse(await response.json());
    expect(body.commission?.earnedMinor.current).toBe(4000);
    expect(body.commissionTrend).toHaveLength(1);
    expect(analytics.analytics).toHaveBeenCalledWith({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      from: '2026-11-01',
      to: '2026-11-07',
      compare: 'previous',
      group: 'day',
      leadType: 'sim_order',
      partner: 'PT-7',
      assignee: 'me',
    });
  });

  it.each(['leads', 'orders', 'partners', 'finance', 'content', 'viewer'] as const)(
    'leaves every money key out for the %s role but keeps the counts',
    async (role) => {
      asRole(role);
      const response = await call(url('?from=2026-11-01&to=2026-11-07'));
      expect(response.status).toBe(200);
      const raw = z.record(z.string(), z.unknown()).parse(await response.json());
      expect(Object.hasOwn(raw, 'commission')).toBe(false);
      expect(Object.hasOwn(raw, 'commissionTrend')).toBe(false);
      expect(JSON.stringify(raw)).not.toMatch(/Minor|commissionTrend/);
      const body = analyticsResponseSchema.parse(raw);
      expect(body.kpis.paid.current).toBe(1);
      expect(body.statuses.commission).toEqual([{ key: 'not_yet', total: 4 }]);
    },
  );

  it.each([
    ['', 'no range'],
    ['?from=2026-11-08&to=2026-11-01', 'from after to'],
    ['?from=2024-01-01&to=2026-11-01', 'over two years'],
    ['?from=2026-11-01&to=2026-11-07&group=year', 'an unknown group'],
    ['?from=2026-11-01&to=2026-11-07&compare=forever', 'an unknown compare'],
    ['?from=2026-11-01&to=2026-11-07&delivery=drone', 'an unknown delivery'],
    ['?from=2026-11-01&to=2026-11-07&planId=nope', 'a plan that is not a uuid'],
    ['?from=2026-11-01&to=2026-11-07&extra=1', 'an unknown parameter'],
  ])('refuses %s (%s) with 400', async (query) => {
    const response = await call(url(query));
    expect(response.status).toBe(400);
    expect(analytics.analytics).not.toHaveBeenCalled();
  });

  it('refuses a site the caller is not a member of', async () => {
    const response = await call(
      url('?from=2026-11-01&to=2026-11-07', '10000000-0000-4000-8000-00000000ffff'),
    );
    expect(response.status).toBe(403);
    expect(analytics.analytics).not.toHaveBeenCalled();
  });

  it('answers 500 and reports a store failure', async () => {
    analytics.analytics.mockRejectedValueOnce(new Error('boom'));
    const response = await call(url('?from=2026-11-01&to=2026-11-07'));
    expect(response.status).toBe(500);
    expect(captureException).toHaveBeenCalled();
  });
});
