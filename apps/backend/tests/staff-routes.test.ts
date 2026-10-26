import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiErrorResponseSchema,
  inviteStaffResponseSchema,
  listAssignableMembersResponseSchema,
  listWorkspaceJobsResponseSchema,
  listWorkspaceLeadsResponseSchema,
  resolveUncertainJobResponseSchema,
  retryWorkspaceJobResponseSchema,
  staffWorkspaceAccessResponseSchema,
  staffWorkspacesResponseSchema,
  type AssignableMember,
  type LeadListItem,
  type StaffWorkspace,
} from '@gt-sales/contracts';

import { createApp } from '../src/app.js';
import type { StaffSessionVerifier, VerifiedStaffSession } from '../src/auth/session.js';
import type { StaffAccessSnapshot } from '../src/staff/authorization.js';
import type { ListLeadsInput, LeadStore } from '../src/leads/store.js';
import type {
  BootstrapStaffInput,
  InviteStaffInput,
  RevokeResult,
  StaffStore,
} from '../src/staff/store.js';
import type { WebsiteCredentialStore } from '../src/website/store.js';
import type { JobAdminStore, AdminJob } from '../src/jobs/store.js';

const noopCredentialStore: WebsiteCredentialStore = {
  createCredential: async () => {
    throw new Error('not used in these staff-route tests');
  },
  listCredentials: async () => [],
  revokeCredential: async () => ({ status: 'not_found' }),
};

class MemoryJobStore implements JobAdminStore {
  jobs: Awaited<ReturnType<JobAdminStore['listActive']>>['jobs'] = [];
  /** Defaults to the number of jobs; set higher to simulate the 500-row cap. */
  total: number | undefined;
  readonly listCalls: { workspaceId: string; actorId: string }[] = [];
  readonly retryCalls: { workspaceId: string; jobId: string }[] = [];
  readonly resolveCalls: { workspaceId: string; jobId: string; delivered: boolean }[] = [];
  retryResult: Awaited<ReturnType<JobAdminStore['retry']>> = 'retried';
  resolveResult: Awaited<ReturnType<JobAdminStore['resolveUncertain']>> | undefined;

  async listActive(workspaceId: string, actorId: string) {
    this.listCalls.push({ workspaceId, actorId });
    return { jobs: this.jobs, total: this.total ?? this.jobs.length };
  }

  async resolveUncertain(input: {
    workspaceId: string;
    actorId: string;
    jobId: string;
    requestId: string;
    delivered: boolean;
  }) {
    this.resolveCalls.push({
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      delivered: input.delivered,
    });
    return this.resolveResult ?? (input.delivered ? 'completed' : 'failed');
  }

  async retry(input: { workspaceId: string; actorId: string; jobId: string; requestId: string }) {
    this.retryCalls.push({ workspaceId: input.workspaceId, jobId: input.jobId });
    return this.retryResult;
  }
}

const sampleJob: AdminJob = {
  id: '40000000-0000-4000-8000-000000000001',
  jobType: 'order_acknowledgement_email',
  status: 'failed',
  attempts: 1,
  availableAt: new Date('2026-09-14T00:00:00.000Z'),
  leaseExpiresAt: null,
  lastErrorCode: 'provider_rejected',
  createdAt: new Date('2026-09-14T00:00:00.000Z'),
  updatedAt: new Date('2026-09-14T00:00:00.000Z'),
};

const ACTOR = '20000000-0000-4000-8000-000000000001';
const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const MEMBERSHIP = '30000000-0000-4000-8000-000000000001';
const INVITATION = '30000000-0000-4000-8000-000000000002';

const sampleLead: LeadListItem = {
  id: '90000000-0000-4000-8000-000000000001',
  workspaceId: WORKSPACE,
  leadType: 'sim_order',
  status: 'incomplete',
  stage: 'new',
  contact: { email: 'jane@example.test' },
  contactId: null,
  assignedActorId: null,
  externalRef: null,
  source: 'utm:google/cpc',
  attribution: { utmSource: 'google', utmMedium: 'cpc' },
  consentVersion: 'terms-2026-09',
  openTaskCount: 0,
  nextTaskDueAt: null,
  deletedAt: null,
  createdAt: '2026-09-14T00:00:00.000Z',
  updatedAt: '2026-09-14T00:00:00.000Z',
};

const sampleMembers: AssignableMember[] = [
  {
    membershipId: MEMBERSHIP,
    actorId: ACTOR,
    displayName: 'Owner',
    roles: ['owner'],
    isSelf: true,
  },
  {
    membershipId: INVITATION,
    actorId: '20000000-0000-4000-8000-000000000002',
    displayName: null,
    roles: ['orders'],
    isSelf: false,
  },
];

class MemoryLeadStore implements LeadStore {
  readLead: LeadStore['readLead'] = async () => ({ status: 'grant_invalid' });
  readonly listLeadsCalls: ListLeadsInput[] = [];

  createLead: LeadStore['createLead'] = () => {
    throw new Error('not used in these staff-route tests');
  };

  updateLead: LeadStore['updateLead'] = () => {
    throw new Error('not used in these staff-route tests');
  };

  async listLeads(input: ListLeadsInput) {
    this.listLeadsCalls.push(input);
    return { leads: [sampleLead], page: { page: 1, pageSize: 25, total: 1 } };
  }
}

const workspace: StaffWorkspace = {
  id: WORKSPACE,
  slug: 'getcanadasim',
  name: 'Get Canada Sim',
  membershipId: MEMBERSHIP,
  roles: ['owner'],
};

class TokenVerifier implements StaffSessionVerifier {
  readonly sessions = new Map<string, VerifiedStaffSession>();

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
  inviteStaff = vi.fn(async (_input: InviteStaffInput) => INVITATION);
  revokeStaff = vi.fn(async (): Promise<RevokeResult> => 'revoked');
  listAssignableMembers = vi.fn(async () => sampleMembers);
  setDisplayName = vi.fn(async () => 1);

  async bootstrapStaff(_input: BootstrapStaffInput) {
    return this.access.status === 'active' ? [workspace] : [];
  }

  async loadStaffAccess(actorId: string, workspaceId: string) {
    return actorId === ACTOR && workspaceId === WORKSPACE ? this.access : undefined;
  }
}

let server: Server;
let baseUrl: string;
let verifier: TokenVerifier;
let store: MemoryStaffStore;
let leadStore: MemoryLeadStore;
let jobStore: MemoryJobStore;

beforeEach(async () => {
  verifier = new TokenVerifier();
  verifier.sessions.set('token', { actorId: ACTOR, verifiedEmail: 'owner@example.test' });
  store = new MemoryStaffStore();
  leadStore = new MemoryLeadStore();
  jobStore = new MemoryJobStore();
  jobStore.jobs = [{ ...sampleJob }];
  server = createApp({
    staff: {
      sessionVerifier: verifier,
      store,
      credentialStore: noopCredentialStore,
      leadStore,
      jobStore,
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

describe('protected staff routes', () => {
  it('reports an unexpected handler failure to the tracker and the log, never silently', async () => {
    const captureException = vi.fn();
    const failing = createApp({
      staff: {
        sessionVerifier: verifier,
        store,
        credentialStore: noopCredentialStore,
        leadStore: Object.assign(new MemoryLeadStore(), {
          listLeads: async () => {
            throw new Error('boom');
          },
        }),
        errorTracker: { captureException },
      },
    }).listen(0);
    await new Promise<void>((resolve) => failing.once('listening', resolve));
    const address = failing.address();
    if (address === null || typeof address === 'string') throw new Error('expected TCP server');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/v1/staff/workspaces/${WORKSPACE}/leads`,
        { headers: { authorization: 'Bearer token' } },
      );
      expect(response.status).toBe(500);
      expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe('internal_error');
      expect(captureException).toHaveBeenCalledOnce();
      expect(captureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          requestId: expect.any(String),
          workspaceId: WORKSPACE,
          actorId: ACTOR,
        }),
      );
      const records = logged.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(records).toContainEqual(
        expect.objectContaining({ event: 'request_error', code: 'internal_error' }),
      );
      expect(JSON.stringify(records)).not.toContain('boom');
    } finally {
      logged.mockRestore();
      await new Promise<void>((resolve) => failing.close(() => resolve()));
    }
  });

  it('rejects malformed JSON with the shared safe error envelope', async () => {
    const response = await fetch(`${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/invitations`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
      },
      body: '{"email":',
    });
    expect(response.status).toBe(400);
    expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe('invalid_request');
  });

  it('requires a server-verified bearer session', async () => {
    const missing = await fetch(`${baseUrl}/api/v1/staff/workspaces`);
    expect(missing.status).toBe(401);
    expect(apiErrorResponseSchema.parse(await missing.json()).error.code).toBe('missing_session');

    const invalid = await fetch(`${baseUrl}/api/v1/staff/workspaces`, {
      headers: { authorization: 'Bearer forged-token' },
    });
    expect(invalid.status).toBe(401);
    expect(apiErrorResponseSchema.parse(await invalid.json()).error.code).toBe('invalid_session');
  });

  it('lists only the verified actor workspaces and exposes current access', async () => {
    const list = await fetch(`${baseUrl}/api/v1/staff/workspaces`, {
      headers: { authorization: 'Bearer token' },
    });
    const listBody = staffWorkspacesResponseSchema.parse(await list.json());
    expect(listBody.workspaces).toEqual([workspace]);

    const access = await fetch(`${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/access`, {
      headers: { authorization: 'Bearer token' },
    });
    expect(staffWorkspaceAccessResponseSchema.parse(await access.json()).workspace).toEqual(
      workspace,
    );
  });

  it('denies a revoked member on the very next request with the same live token', async () => {
    const before = await fetch(`${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/access`, {
      headers: { authorization: 'Bearer token' },
    });
    expect(before.status).toBe(200);

    store.access = { ...store.access, status: 'revoked' };
    const after = await fetch(`${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/access`, {
      headers: { authorization: 'Bearer token' },
    });
    expect(after.status).toBe(403);
    expect(apiErrorResponseSchema.parse(await after.json()).error.code).toBe('membership_revoked');
  });

  it('lets an owner invite staff on the signed-in session alone', async () => {
    const response = await fetch(`${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/invitations`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email: 'new.staff@example.test', roles: ['orders'] }),
    });

    expect(response.status).toBe(201);
    expect(inviteStaffResponseSchema.parse(await response.json()).status).toBe('pending');
    expect(store.inviteStaff).toHaveBeenCalledOnce();
  });

  it('lists active members as assignee options for any workspace reader', async () => {
    store.access = { ...store.access, roles: ['viewer'] };
    const response = await fetch(`${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/members`, {
      headers: { authorization: 'Bearer token' },
    });
    expect(response.status).toBe(200);
    const body = listAssignableMembersResponseSchema.parse(await response.json());
    expect(body.members).toEqual(sampleMembers);
    expect(store.listAssignableMembers).toHaveBeenCalledWith(WORKSPACE, ACTOR);
  });

  it('denies a foreign workspace the member list with 403 and no store call', async () => {
    const response = await fetch(
      `${baseUrl}/api/v1/staff/workspaces/10000000-0000-4000-8000-0000000000ff/members`,
      { headers: { authorization: 'Bearer token' } },
    );
    expect(response.status).toBe(403);
    expect(store.listAssignableMembers).not.toHaveBeenCalled();
  });

  it('lists leads for any active member, with attribution, and applies the status filter', async () => {
    const response = await fetch(
      `${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/leads?status=incomplete`,
      { headers: { authorization: 'Bearer token' } },
    );
    expect(response.status).toBe(200);
    const body = listWorkspaceLeadsResponseSchema.parse(await response.json());
    expect(body.leads).toEqual([sampleLead]);
    expect(leadStore.listLeadsCalls).toEqual([
      {
        workspaceId: WORKSPACE,
        actorId: ACTOR,
        status: 'incomplete',
        page: undefined,
        pageSize: undefined,
      },
    ]);
  });

  it('shows lead contact details only to roles that work leads or money', async () => {
    const listAs = async (roles: StaffAccessSnapshot['roles']) => {
      store.access = { ...store.access, roles };
      const response = await fetch(`${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/leads`, {
        headers: { authorization: 'Bearer token' },
      });
      expect(response.status).toBe(200);
      return listWorkspaceLeadsResponseSchema.parse(await response.json()).leads;
    };
    for (const role of ['viewer', 'content', 'partners'] as const) {
      expect(await listAs([role])).toEqual([{ ...sampleLead, contact: {} }]);
    }
    // Finance sees contacts too, through financial.read.
    for (const role of ['leads', 'orders', 'finance'] as const) {
      expect(await listAs([role])).toEqual([sampleLead]);
    }
  });

  it('denies a revoked member the leads list', async () => {
    store.access = { ...store.access, status: 'revoked' };
    const response = await fetch(`${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/leads`, {
      headers: { authorization: 'Bearer token' },
    });
    expect(response.status).toBe(403);
    expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe(
      'membership_revoked',
    );
  });

  it('rejects an unknown status filter value', async () => {
    const response = await fetch(
      `${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/leads?status=archived`,
      { headers: { authorization: 'Bearer token' } },
    );
    expect(response.status).toBe(400);
    expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe('invalid_request');
  });

  it('lets a viewer list jobs with canRetry false', async () => {
    store.access = { ...store.access, roles: ['viewer'], permissions: [] };

    const response = await fetch(`${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/jobs`, {
      headers: { authorization: 'Bearer token' },
    });

    expect(response.status).toBe(200);
    const body = listWorkspaceJobsResponseSchema.parse(await response.json());
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0]).toMatchObject({ id: sampleJob.id, status: 'failed' });
    // The route serialises the job timestamps to ISO strings for the contract.
    expect(body.jobs[0]?.availableAt).toBe('2026-09-14T00:00:00.000Z');
    expect(body.canRetry).toBe(false);
    expect(jobStore.listCalls).toEqual([{ workspaceId: WORKSPACE, actorId: ACTOR }]);
  });

  it('reports the full active-job total when the list is capped', async () => {
    jobStore.total = 612;
    const response = await fetch(`${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/jobs`, {
      headers: { authorization: 'Bearer token' },
    });
    const body = listWorkspaceJobsResponseSchema.parse(await response.json());
    expect(body.jobs).toHaveLength(1);
    expect(body.total).toBe(612);
  });

  describe('resolving an uncertain job', () => {
    const resolve = (token: string, body: unknown) =>
      fetch(`${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/jobs/${sampleJob.id}/resolve`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    it('denies a viewer with 403 and no store call', async () => {
      store.access = { ...store.access, roles: ['viewer'], permissions: [] };
      const response = await resolve('token', { delivered: true });
      expect(response.status).toBe(403);
      expect(jobStore.resolveCalls).toEqual([]);
    });

    it('records delivered or not delivered', async () => {
      store.access = { ...store.access, roles: ['owner'], permissions: [] };
      const delivered = await resolve('token', { delivered: true });
      expect(delivered.status).toBe(200);
      expect(resolveUncertainJobResponseSchema.parse(await delivered.json())).toMatchObject({
        jobId: sampleJob.id,
        status: 'completed',
      });
      const notDelivered = await resolve('token', { delivered: false });
      expect(resolveUncertainJobResponseSchema.parse(await notDelivered.json()).status).toBe(
        'failed',
      );
      expect(jobStore.resolveCalls).toEqual([
        { workspaceId: WORKSPACE, jobId: sampleJob.id, delivered: true },
        { workspaceId: WORKSPACE, jobId: sampleJob.id, delivered: false },
      ]);
    });

    it('rejects a missing answer, and a job that is not uncertain', async () => {
      store.access = { ...store.access, roles: ['owner'], permissions: [] };
      expect((await resolve('token', {})).status).toBe(400);
      jobStore.resolveResult = 'not_uncertain';
      const conflict = await resolve('token', { delivered: true });
      expect(conflict.status).toBe(409);
      expect(apiErrorResponseSchema.parse(await conflict.json()).error.code).toBe(
        'job_not_uncertain',
      );
      jobStore.resolveResult = 'not_found';
      expect((await resolve('token', { delivered: true })).status).toBe(404);
    });
  });

  it('denies a viewer the job retry with 403 and no store call', async () => {
    store.access = { ...store.access, roles: ['viewer'], permissions: [] };

    const response = await fetch(
      `${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/jobs/${sampleJob.id}/retry`,
      { method: 'POST', headers: { authorization: 'Bearer token' } },
    );

    expect(response.status).toBe(403);
    expect(jobStore.retryCalls).toEqual([]);
  });

  it('lets an integration-management holder retry a failed job', async () => {
    store.access = {
      ...store.access,
      roles: ['owner'],
      permissions: [{ name: 'integration_management', effect: 'allow' }],
    };

    const response = await fetch(
      `${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/jobs/${sampleJob.id}/retry`,
      { method: 'POST', headers: { authorization: 'Bearer token' } },
    );

    expect(response.status).toBe(200);
    const body = retryWorkspaceJobResponseSchema.parse(await response.json());
    expect(body).toMatchObject({ jobId: sampleJob.id, status: 'pending' });
    expect(jobStore.retryCalls).toEqual([{ workspaceId: WORKSPACE, jobId: sampleJob.id }]);
  });

  it('denies a foreign workspace the job list with 403 and no store call', async () => {
    const FOREIGN_WORKSPACE = '10000000-0000-4000-8000-0000000000ff';

    const response = await fetch(`${baseUrl}/api/v1/staff/workspaces/${FOREIGN_WORKSPACE}/jobs`, {
      headers: { authorization: 'Bearer token' },
    });

    expect(response.status).toBe(403);
    expect(jobStore.listCalls).toEqual([]);
  });
});
