import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  approveChangeRequest,
  finalizeAiAttachment,
  getAiUsage,
  getStaffWorkspaces,
  listAiConversations,
  listWorkspaceMembers,
  renameAiConversation,
  rejectChangeRequest,
  setLeadArchived,
  updateStaffProfile,
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

describe('Ask AI and the top loading bar', () => {
  it('does not count an Ask AI message as page loading', async () => {
    const { isBusy } = await import('./activity.js');
    const { askAiAssistant } = await import('./api.js');
    let busyDuringRequest: boolean | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        busyDuringRequest = isBusy();
        return new Response('', { status: 503 });
      }),
    );

    const { buildAiChatRequest } = await import('./ai-transport.js');
    const { request } = buildAiChatRequest({
      message: 'How many leads today?',
      history: [],
      limits: { maxMessageChars: 100, maxHistoryMessages: 12, maxConversationChars: 1_000 },
      requestId: '00000000-0000-4000-8000-000000000001',
    });
    const stream = askAiAssistant(
      'verified-access-token',
      '10000000-0000-4000-8000-000000000001',
      request,
    );
    await stream.next().catch(() => undefined);

    expect(busyDuringRequest).toBe(false);
  });
});

describe('Ask AI saved chat wrappers', () => {
  const WORKSPACE = '10000000-0000-4000-8000-000000000001';
  const ID = '60000000-0000-4000-8000-000000000001';
  const REQUEST = '70000000-0000-4000-8000-000000000001';
  const NOW = '2026-11-18T12:00:00.000Z';
  const conversation = {
    id: ID,
    title: 'Leads this week',
    createdAt: NOW,
    updatedAt: NOW,
    lastMessageAt: NOW,
  };

  function answer(body: unknown) {
    const request = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', request);
    return request;
  }

  it('lists, renames, finalizes and reads usage through the typed client', async () => {
    let request = answer({ conversations: [conversation], requestId: REQUEST });
    await listAiConversations('token', WORKSPACE, { q: 'leads' });
    expect(String(request.mock.calls[0]?.[0])).toBe(
      `http://localhost:4000/api/v1/staff/workspaces/${WORKSPACE}/ai/conversations?q=leads`,
    );

    request = answer({ conversation, requestId: REQUEST });
    await renameAiConversation('token', WORKSPACE, ID, 'Leads this week');
    expect(request.mock.calls[0]?.[1]?.method).toBe('PATCH');
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      title: 'Leads this week',
    });

    request = answer({
      attachment: {
        id: ID,
        kind: 'text',
        mediaType: 'text/csv',
        fileName: 'leads.csv',
        byteSize: 10,
      },
      requestId: REQUEST,
    });
    await finalizeAiAttachment('token', WORKSPACE, ID, 'd'.repeat(64));
    expect(String(request.mock.calls[0]?.[0])).toBe(
      `http://localhost:4000/api/v1/staff/workspaces/${WORKSPACE}/ai/attachments/${ID}/finalize`,
    );
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      checksumSha256: 'd'.repeat(64),
    });

    request = answer({
      period: 7,
      totals: { turns: 0, inputTokens: 0, outputTokens: 0 },
      members: [],
      requestId: REQUEST,
    });
    expect((await getAiUsage('token', WORKSPACE, { period: 7 })).period).toBe(7);
    expect(String(request.mock.calls[0]?.[0])).toBe(
      `http://localhost:4000/api/v1/staff/workspaces/${WORKSPACE}/ai/usage?period=7`,
    );
  });
});

describe('the site members list', () => {
  const WORKSPACE = '10000000-0000-4000-8000-000000000001';
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const membersBody = (displayName: string) => ({
    members: [
      {
        membershipId: '30000000-0000-4000-8000-000000000001',
        actorId: '20000000-0000-4000-8000-000000000001',
        displayName,
        roles: ['owner'],
        isSelf: true,
      },
    ],
    requestId: '70000000-0000-4000-8000-000000000001',
  });

  it('sends one request for callers that ask at the same moment, and asks again afterwards', async () => {
    const answers: Array<(response: Response) => void> = [];
    const request = vi.fn(
      (_input: string | URL | Request, _init?: RequestInit) =>
        new Promise<Response>((resolve) => answers.push(resolve)),
    );
    vi.stubGlobal('fetch', request);

    const sidebar = listWorkspaceMembers('token', WORKSPACE);
    const page = listWorkspaceMembers('token', WORKSPACE);
    // Another site, or another person's token, is another request.
    const otherSite = listWorkspaceMembers('token', '10000000-0000-4000-8000-000000000002');
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    answers[0]?.(json(membersBody('Ada')));
    answers[1]?.(json(membersBody('Ada')));
    expect((await sidebar).members[0]?.displayName).toBe('Ada');
    expect(await page).toEqual(await sidebar);
    await otherSite;

    // Nothing is kept: the next call asks the backend again.
    const later = listWorkspaceMembers('token', WORKSPACE);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    answers[2]?.(json(membersBody('Ada L.')));
    expect((await later).members[0]?.displayName).toBe('Ada L.');
  });

  it('never answers a list asked for after a name change with a request sent before it', async () => {
    const answers: Array<(response: Response) => void> = [];
    const request = vi.fn(
      (_input: string | URL | Request, _init?: RequestInit) =>
        new Promise<Response>((resolve) => answers.push(resolve)),
    );
    vi.stubGlobal('fetch', request);

    const before = listWorkspaceMembers('token', WORKSPACE);
    const change = updateStaffProfile('token', 'Ada L.');
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    answers[1]?.(
      json({
        displayName: 'Ada L.',
        memberships: 1,
        requestId: '70000000-0000-4000-8000-000000000002',
      }),
    );
    await change;

    const after = listWorkspaceMembers('token', WORKSPACE);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    answers[0]?.(json(membersBody('Ada')));
    answers[2]?.(json(membersBody('Ada L.')));
    expect((await before).members[0]?.displayName).toBe('Ada');
    expect((await after).members[0]?.displayName).toBe('Ada L.');
  });

  it('lets a failed request go, so the next call tries again', async () => {
    const request = vi
      .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json(membersBody('Ada')));
    vi.stubGlobal('fetch', request);

    await expect(listWorkspaceMembers('token', WORKSPACE)).rejects.toBeInstanceOf(TypeError);
    expect((await listWorkspaceMembers('token', WORKSPACE)).members).toHaveLength(1);
  });
});
