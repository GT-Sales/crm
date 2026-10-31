import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiErrorResponseSchema,
  sourceReportResponseSchema,
  type StaffWorkspace,
} from '@gt-sales/contracts';
import type { ErrorTracker } from '@gt-sales/adapters';
import type { StaffRoleName } from '@gt-sales/types';

import { createApp } from '../src/app.js';
import type { StaffSessionVerifier, VerifiedStaffSession } from '../src/auth/session.js';
import type { LeadStore } from '../src/leads/store.js';
import type { ReportStore, SourceReport } from '../src/reports/store.js';
import type { StaffAccessSnapshot } from '../src/staff/authorization.js';
import type { StaffStore } from '../src/staff/store.js';
import type { WebsiteCredentialStore } from '../src/website/store.js';

const ACTOR = '20000000-0000-4000-8000-00000000f651';
const WORKSPACE = '10000000-0000-4000-8000-00000000f651';
const MEMBERSHIP = '30000000-0000-4000-8000-00000000f651';

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

const sourceReport: SourceReport = {
  totals: { received: 3, submitted: 2, madeIt: 1 },
  rows: [
    {
      source: 'utm:google/cpc',
      kind: 'utm',
      received: 2,
      submitted: 1,
      madeIt: 1,
      campaigns: [{ campaign: 'fall', other: false, received: 2, submitted: 1, madeIt: 1 }],
    },
    { source: 'direct', kind: 'direct', received: 1, submitted: 1, madeIt: 0, campaigns: [] },
  ],
  withSourceData: 2,
};

let server: Server;
let baseUrl: string;
let store: MemoryStaffStore;
let reports: { sourceReport: ReturnType<typeof vi.fn<ReportStore['sourceReport']>> };
let captureException: ReturnType<typeof vi.fn<ErrorTracker['captureException']>>;

beforeEach(async () => {
  store = new MemoryStaffStore();
  reports = { sourceReport: vi.fn<ReportStore['sourceReport']>(async () => sourceReport) };
  captureException = vi.fn<ErrorTracker['captureException']>();
  server = createApp({
    staff: {
      sessionVerifier: new TokenVerifier(),
      store,
      credentialStore: noopCredentialStore,
      leadStore: unusedLeadStore,
      reportStore: reports,
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

const reportUrl = (query: string, workspaceId = WORKSPACE) =>
  `${baseUrl}/api/v1/staff/workspaces/${workspaceId}/reports/sources${query}`;

function call(url: string) {
  return fetch(url, { headers: { authorization: 'Bearer token' } });
}

async function errorOf(response: Response) {
  return apiErrorResponseSchema.parse(await response.json()).error;
}

const asRole = (role: StaffRoleName) => {
  store.access = { ...store.access, roles: [role] };
};

describe('staff source report route', () => {
  it('every role that reads the site gets the report for a type and window', async () => {
    asRole('viewer');
    const response = await call(reportUrl('?leadType=internet&days=30'));
    expect(response.status).toBe(200);
    const body = sourceReportResponseSchema.parse(await response.json());
    expect(body).toEqual({
      leadType: 'internet',
      days: 30,
      ...sourceReport,
      requestId: expect.any(String),
    });
    expect(reports.sourceReport).toHaveBeenCalledWith({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      leadType: 'internet',
      days: 30,
    });
  });

  it('no window is all time', async () => {
    const response = await call(reportUrl('?leadType=internet'));
    expect(response.status).toBe(200);
    expect(sourceReportResponseSchema.parse(await response.json()).days).toBeNull();
    expect(reports.sourceReport).toHaveBeenCalledWith({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      leadType: 'internet',
      days: undefined,
    });
  });

  it('refuses a bad window, type or site id without reading', async () => {
    for (const url of [
      reportUrl('?leadType=internet&days=14'),
      reportUrl('?leadType=No-Such-Type'),
      reportUrl('?leadType=internet', 'not-a-uuid'),
      reportUrl(''),
    ]) {
      const response = await call(url);
      expect(response.status, url).toBe(400);
      expect((await errorOf(response)).code).toBe('invalid_request');
    }
    expect(reports.sourceReport).not.toHaveBeenCalled();
  });

  it('refuses a caller with no membership of the site', async () => {
    store.access = { ...store.access, status: 'revoked' };
    expect((await call(reportUrl('?leadType=internet'))).status).toBe(403);
    const elsewhere = await call(
      reportUrl('?leadType=internet', '10000000-0000-4000-8000-00000000f652'),
    );
    expect(elsewhere.status).toBe(403);
    expect((await errorOf(elsewhere)).code).toBe('membership_missing');
    expect(reports.sourceReport).not.toHaveBeenCalled();
  });

  it('reports a store failure and answers 500', async () => {
    reports.sourceReport.mockRejectedValueOnce(new Error('boom'));
    const response = await call(reportUrl('?leadType=internet&days=7'));
    expect(response.status).toBe(500);
    expect((await errorOf(response)).code).toBe('internal_error');
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});
