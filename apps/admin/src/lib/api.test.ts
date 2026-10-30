import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  approveChangeRequest,
  getStaffWorkspaces,
  rejectChangeRequest,
  setLeadArchived,
} from './api.js';

afterEach(() => vi.unstubAllGlobals());

describe('staff backend client', () => {
  it('attaches the Supabase access token and validates workspace responses', async () => {
    const request = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            workspaces: [
              {
                id: '10000000-0000-4000-8000-000000000001',
                slug: 'site-1',
                name: 'Northern Arrival Mobile',
                membershipId: '30000000-0000-4000-8000-000000000001',
                roles: ['owner'],
              },
            ],
            requestId: '70000000-0000-4000-8000-000000000001',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', request);

    const result = await getStaffWorkspaces('verified-access-token');

    expect(result.workspaces.map((workspace) => workspace.slug)).toEqual(['site-1']);

    // Requests go through the shared typed client, which uses a URL and a
    // Headers instance and validates the response against the contract.
    const [input, init] = request.mock.calls[0] ?? [];
    expect(String(input)).toBe('http://localhost:4000/api/v1/staff/workspaces');
    expect(init?.cache).toBe('no-store');
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer verified-access-token');
  });
});

describe('archiving a lead', () => {
  const WORKSPACE = '10000000-0000-4000-8000-000000000001';
  const LEAD = '90000000-0000-4000-8000-000000000001';
  const lead = {
    id: LEAD,
    workspaceId: WORKSPACE,
    leadType: 'internet',
    status: 'submitted',
    stage: 'new',
    contact: {},
    contactId: null,
    assignedActorId: null,
    externalRef: null,
    source: 'direct',
    attribution: {},
    consentVersion: null,
    openTaskCount: 0,
    nextTaskDueAt: null,
    deletedAt: null,
    createdAt: '2026-10-30T09:00:00.000Z',
    updatedAt: '2026-10-30T09:00:00.000Z',
    form: null,
  };

  it('posts to /archive to archive and /restore to restore', async () => {
    const request = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            lead,
            activity: null,
            requestId: '70000000-0000-4000-8000-000000000001',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', request);

    await setLeadArchived('token', WORKSPACE, LEAD, true);
    await setLeadArchived('token', WORKSPACE, LEAD, false);

    const calls = request.mock.calls.map(([input, init]) => [init?.method, String(input)]);
    expect(calls).toEqual([
      ['POST', `http://localhost:4000/api/v1/staff/workspaces/${WORKSPACE}/leads/${LEAD}/archive`],
      ['POST', `http://localhost:4000/api/v1/staff/workspaces/${WORKSPACE}/leads/${LEAD}/restore`],
    ]);
  });
});

describe('deciding a change request', () => {
  const WORKSPACE = '10000000-0000-4000-8000-000000000001';
  const LEAD = '90000000-0000-4000-8000-000000000001';
  const REQUEST = 'c0000000-0000-4000-8000-000000000001';
  const lead = {
    id: LEAD,
    workspaceId: WORKSPACE,
    leadType: 'sim_order',
    status: 'submitted',
    stage: 'pending',
    contact: {},
    contactId: null,
    assignedActorId: null,
    externalRef: 'MS-70',
    source: 'direct',
    attribution: {},
    consentVersion: null,
    openTaskCount: 0,
    nextTaskDueAt: null,
    deletedAt: null,
    createdAt: '2026-10-30T09:00:00.000Z',
    updatedAt: '2026-10-30T09:00:00.000Z',
    form: null,
  };

  it('posts the expected version to /approve and /reject, and reads the answer', async () => {
    const request = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            lead,
            activities: [],
            allowedMoves: [],
            emailSkipped: { template: 'change_approved', reason: 'no_sender' },
            requestId: '70000000-0000-4000-8000-000000000001',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', request);

    const approved = await approveChangeRequest('token', WORKSPACE, LEAD, REQUEST, 2);
    await rejectChangeRequest('token', WORKSPACE, LEAD, REQUEST, 3);

    expect(approved.emailSkipped).toEqual({ template: 'change_approved', reason: 'no_sender' });
    const base = `http://localhost:4000/api/v1/staff/workspaces/${WORKSPACE}/leads/${LEAD}/change-requests/${REQUEST}`;
    expect(
      request.mock.calls.map(([input, init]) => [init?.method, String(input), init?.body]),
    ).toEqual([
      ['POST', `${base}/approve`, JSON.stringify({ expectedVersion: 2 })],
      ['POST', `${base}/reject`, JSON.stringify({ expectedVersion: 3 })],
    ]);
  });
});
