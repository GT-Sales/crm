import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  aiWirePartSchema,
  aiActionProposalSchema,
  apiErrorResponseSchema,
  type AiStreamPart,
  type StaffWorkspace,
} from '@gt-sales/contracts';

import { createApp } from '../src/app.js';
import type { StaffSessionVerifier, VerifiedStaffSession } from '../src/auth/session.js';
import type { AiAssistantConfig } from '../src/ai/config.js';
import { createFakeEngine, type FakeTurn, type AssistantEngine } from '../src/ai/engine.js';
import { DatabaseLeadWorkStore } from '../src/leads/work-store.js';
import { signAiAction, verifyAiAction } from '../src/ai/actions.js';
import type { LeadRow } from '../src/ai/projections.js';
import type { AiReadService } from '../src/ai/read-service.js';
import type { AiSiteContextStore } from '../src/ai/site-context.js';
import type { LeadStore } from '../src/leads/store.js';
import type { ReportStore } from '../src/reports/store.js';
import type { StaffAccessSnapshot } from '../src/staff/authorization.js';
import type { StaffStore } from '../src/staff/store.js';
import type { WebsiteCredentialStore } from '../src/website/store.js';

const ACTOR = '20000000-0000-4000-8000-000000000c71';
const WORKSPACE = '10000000-0000-4000-8000-000000000c71';
const MEMBERSHIP = '30000000-0000-4000-8000-000000000c71';
const LEAD = '40000000-0000-4000-8000-000000000c71';
const REQUEST_ID = '50000000-0000-4000-8000-000000000c71';
const NOW = new Date('2026-11-02T12:00:00.000Z');

const workspace: StaffWorkspace = {
  id: WORKSPACE,
  slug: 'getcanadasim',
  name: 'Get Canada Sim',
  membershipId: MEMBERSHIP,
  roles: ['owner'],
};

class TokenVerifier implements StaffSessionVerifier {
  async verify(accessToken: string) {
    return accessToken === 'token'
      ? ({ actorId: ACTOR, verifiedEmail: 'owner@example.test' } satisfies VerifiedStaffSession)
      : undefined;
  }
}

class MemoryStaffStore implements StaffStore {
  access: StaffAccessSnapshot | undefined = {
    membershipId: MEMBERSHIP,
    status: 'active',
    roles: ['owner'],
    permissions: [],
  };
  setDisplayName = async () => 1;
  /** Optional per-test replacement for the membership read. */
  loader?: () => Promise<StaffAccessSnapshot | undefined>;
  async bootstrapStaff() {
    return [workspace];
  }
  async loadStaffAccess() {
    return this.loader ? this.loader() : this.access;
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

const siteContext: AiSiteContextStore = {
  siteContext: async () => ({
    siteId: WORKSPACE,
    slug: 'getcanadasim',
    name: 'Get Canada Sim',
    leadTypes: ['sim_order'],
  }),
};

const lead: LeadRow = {
  id: LEAD,
  lead_type: 'sim_order',
  stage: 'pending',
  status: 'submitted',
  external_ref: 'MS-TEST-101',
  full_name: 'Ada Lovelace',
  assignee_name: 'Owner',
  created_at: new Date('2026-10-20T12:00:00.000Z'),
  updated_at: new Date('2026-10-21T12:00:00.000Z'),
  deleted_at: null,
};

const reads: AiReadService = {
  overview: async () => ({ received: 0, submitted: 0, byStage: [] }),
  findLeads: async () => ({ rows: [lead], total: 1 }),
  leadSummary: async () => undefined,
  openTasks: async () => ({ rows: [], total: 0 }),
  isActiveMember: async () => true,
  leadHint: async () => undefined,
};

const reports: ReportStore = {
  sourceReport: async () => ({
    totals: { received: 0, submitted: 0, madeIt: 0 },
    rows: [],
    withSourceData: 0,
  }),
};

function config(overrides: Partial<AiAssistantConfig> = {}): AiAssistantConfig {
  return {
    enabled: true,
    apiKey: 'test-key-not-real',
    modelId: 'test/model',
    workspaceIds: new Set([WORKSPACE]),
    ...overrides,
  };
}

let server: Server;
let baseUrl: string;
let staff: MemoryStaffStore;

function appWith(
  options: {
    work?: DatabaseLeadWorkStore;
    config?: AiAssistantConfig;
    engine?: AssistantEngine;
    turns?: readonly FakeTurn[];
    rateLimit?: () => Promise<{ allowed: boolean; retryAfterSeconds: number }>;
    loadAccess?: () => Promise<StaffAccessSnapshot | undefined>;
  } = {},
) {
  staff = new MemoryStaffStore();
  staff.loader = options.loadAccess;
  return createApp({
    staff: {
      ...(options.work === undefined ? {} : { leadWorkStore: options.work }),
      sessionVerifier: new TokenVerifier(),
      store: staff,
      credentialStore: noopCredentialStore,
      leadStore: unusedLeadStore,
      reportStore: reports,
      ai: {
        config: options.config ?? config(),
        siteContext,
        reads,
        engine:
          options.engine ??
          createFakeEngine(options.turns ?? [{ chunks: ['You received ', '1 SIM order.'] }]),
        rateLimit: options.rateLimit ?? (async () => ({ allowed: true, retryAfterSeconds: 0 })),
        now: () => NOW,
      },
    },
  });
}

async function start(app = appWith()) {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected TCP server');
  baseUrl = `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const chatUrl = () => `${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/ai/chat`;

const body = (overrides: Record<string, unknown> = {}) => ({
  requestId: REQUEST_ID,
  message: 'How many SIM orders did we receive?',
  history: [],
  ...overrides,
});

async function readParts(response: Response): Promise<AiStreamPart[]> {
  if (!response.body) throw new Error('expected a stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const parts: AiStreamPart[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const payload = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (payload.length > 0 && payload !== '[DONE]')
        parts.push(aiWirePartSchema.parse(JSON.parse(payload)).data);
      boundary = buffer.indexOf('\n\n');
    }
  }
  return parts;
}

describe('POST /workspaces/:id/ai/chat', () => {
  it('revises only the signed lead and action kind without saving', async () => {
    vi.spyOn(reads, 'leadHint').mockResolvedValue({
      leadId: LEAD,
      reference: 'MS-101',
      name: 'Example',
      stage: 'pending',
      leadType: 'sim_order',
    });
    const token = signAiAction(
      {
        id: REQUEST_ID,
        actorId: ACTOR,
        workspaceId: WORKSPACE,
        expiresAt: new Date(NOW.getTime() + 60000).toISOString(),
        draft: { kind: 'note', leadId: LEAD, body: 'Original' },
      },
      'test-key-not-real',
    );
    const work = new DatabaseLeadWorkStore();
    const write = vi.spyOn(work, 'addNote');
    await start(appWith({ work }));
    const revise = (draft: unknown) =>
      fetch(`${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/ai/actions/revise`, {
        method: 'POST',
        headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
        body: JSON.stringify({ token, draft }),
      });
    expect((await revise({ kind: 'note', leadId: ACTOR, body: 'Changed lead' })).status).toBe(400);
    const response = await revise({ kind: 'note', leadId: LEAD, body: 'Edited' });
    expect(response.status).toBe(200);
    const proposal = aiActionProposalSchema.parse(await response.json());
    expect(proposal.id).not.toBe(REQUEST_ID);
    expect(
      verifyAiAction(
        proposal.token,
        'test-key-not-real',
        { actorId: ACTOR, workspaceId: WORKSPACE },
        NOW,
      )?.draft,
    ).toEqual({ kind: 'note', leadId: LEAD, body: 'Edited' });
    expect(write).not.toHaveBeenCalled();
  });

  it('releases a guided question only after a completed turn', async () => {
    await start(
      appWith({
        turns: [
          {
            toolCalls: [
              {
                name: 'askFollowUp',
                input: { question: 'When?', choices: ['Tomorrow', 'No due date'] },
              },
            ],
            chunks: [],
          },
        ],
      }),
    );
    const response = await fetch(chatUrl(), {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify(body()),
    });
    expect(await readParts(response)).toContainEqual({
      type: 'follow_up',
      followUp: { question: 'When?', choices: ['Tomorrow', 'No due date'] },
    });
  });

  it('queues only the signed email on explicit confirmation', async () => {
    const work = new DatabaseLeadWorkStore();
    const queue = vi
      .spyOn(work, 'queueAiEmail')
      .mockResolvedValue({ status: 'queued', recordId: LEAD });
    const draft = {
      kind: 'email' as const,
      leadId: LEAD,
      subject: 'Hello',
      body: 'Please call us.',
    };
    const token = signAiAction(
      {
        id: REQUEST_ID,
        actorId: ACTOR,
        workspaceId: WORKSPACE,
        expiresAt: new Date(NOW.getTime() + 60000).toISOString(),
        draft,
        emailContext: { toAddress: 'customer@example.test', fromAddress: 'staff@example.test' },
      },
      'test-key-not-real',
    );
    await start(appWith({ work }));
    const response = await fetch(
      `${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/ai/actions/confirm`,
      {
        method: 'POST',
        headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      },
    );
    expect(response.status).toBe(200);
    expect(queue).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE,
        actorId: ACTOR,
        creationId: REQUEST_ID,
        draft,
      }),
    );
  });

  it('prepares a note without writing and saves only the signed content on confirmation', async () => {
    const work = new DatabaseLeadWorkStore();
    const add = vi.spyOn(work, 'addNote').mockResolvedValue({
      status: 'created',
      activity: {
        id: REQUEST_ID,
        actorId: ACTOR,
        createdAt: NOW.toISOString(),
        kind: 'note',
        body: 'Called the customer.',
      },
    });
    vi.spyOn(reads, 'leadHint').mockResolvedValue({
      leadId: LEAD,
      reference: 'MS-101',
      name: 'Test',
      stage: 'pending',
      leadType: 'sim_order',
    });
    await start(
      appWith({
        work,
        turns: [
          {
            toolCalls: [
              { name: 'prepareNote', input: { leadId: LEAD, body: 'Called the customer.' } },
            ],
            chunks: ['Draft ready.'],
          },
        ],
      }),
    );
    const response = await fetch(chatUrl(), {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify(body()),
    });
    const actions = (await readParts(response)).find((part) => part.type === 'actions');
    if (actions?.type !== 'actions') throw new Error('expected confirmation card');
    const proposal = actions.actions[0];
    if (!proposal) throw new Error('expected proposal');
    expect(add).not.toHaveBeenCalled();
    const saved = await fetch(
      `${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/ai/actions/confirm`,
      {
        method: 'POST',
        headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
        body: JSON.stringify({ token: proposal.token }),
      },
    );
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      status: 'saved',
      kind: 'note',
      actionId: proposal.id,
    });
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE,
        actorId: ACTOR,
        leadId: LEAD,
        body: 'Called the customer.',
        creationId: proposal.id,
      }),
    );
  });

  it.each([
    'expired',
    'foreign_actor',
    'foreign_site',
    'tampered',
    'extra_fields',
    'read_only',
    'revoked',
    'disabled',
    'site_disabled',
    'missing_membership',
    'pending_membership',
    'orders_only',
  ] as const)('rejects %s confirmations without calling a write store', async (mode) => {
    const work = new DatabaseLeadWorkStore();
    const add = vi.spyOn(work, 'addNote').mockResolvedValue({ status: 'not_found' });
    const task = vi.spyOn(work, 'createTask').mockResolvedValue({ status: 'not_found' });
    const action = {
      id: REQUEST_ID,
      actorId: mode === 'foreign_actor' ? LEAD : ACTOR,
      workspaceId: mode === 'foreign_site' ? LEAD : WORKSPACE,
      expiresAt: new Date(NOW.getTime() + (mode === 'expired' ? -1 : 60000)).toISOString(),
      draft: { kind: 'note' as const, leadId: LEAD, body: 'Exact note' },
    };
    let token = signAiAction(action, 'test-key-not-real');
    if (mode === 'tampered') token = 'x' + token;
    await start(
      appWith({
        work,
        config: config({
          enabled: mode !== 'disabled',
          ...(mode === 'site_disabled' ? { workspaceIds: new Set<string>() } : {}),
        }),
        loadAccess: async () =>
          mode === 'missing_membership'
            ? undefined
            : {
                membershipId: MEMBERSHIP,
                status:
                  mode === 'revoked'
                    ? 'revoked'
                    : mode === 'pending_membership'
                      ? 'pending'
                      : 'active',
                roles:
                  mode === 'read_only'
                    ? ['finance']
                    : mode === 'orders_only'
                      ? ['orders']
                      : ['owner'],
                permissions: [],
              },
      }),
    );
    const response = await fetch(
      `${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/ai/actions/confirm`,
      {
        method: 'POST',
        headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
        body: JSON.stringify({
          token,
          ...(mode === 'extra_fields' ? { body: 'Forged body' } : {}),
        }),
      },
    );
    const expectedStatus =
      mode === 'disabled' || mode === 'site_disabled'
        ? 503
        : [
              'read_only',
              'revoked',
              'missing_membership',
              'pending_membership',
              'orders_only',
            ].includes(mode)
          ? 403
          : 400;
    expect(response.status).toBe(expectedStatus);
    expect(add).not.toHaveBeenCalled();
    expect(task).not.toHaveBeenCalled();
  });

  it('confirms a task using the asking member and calendar-day due date', async () => {
    const work = new DatabaseLeadWorkStore();
    const task = vi.spyOn(work, 'createTask').mockResolvedValue({
      status: 'saved',
      task: {
        id: REQUEST_ID,
        leadId: LEAD,
        title: 'Call',
        dueAt: '2026-11-05T12:00:00.000Z',
        assignedActorId: ACTOR,
        status: 'open',
        completedAt: null,
        createdBy: ACTOR,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
    });
    await start(appWith({ work }));
    const token = signAiAction(
      {
        id: REQUEST_ID,
        ...{ workspaceId: WORKSPACE, actorId: ACTOR },
        expiresAt: new Date(NOW.getTime() + 60000).toISOString(),
        draft: { kind: 'task', leadId: LEAD, title: 'Call', dueDate: '2026-11-05', assignee: 'me' },
      },
      'test-key-not-real',
    );
    const response = await fetch(
      `${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/ai/actions/confirm`,
      {
        method: 'POST',
        headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      },
    );
    expect(response.status).toBe(200);
    expect(task).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Call',
        dueAt: '2026-11-05T12:00:00.000Z',
        assignedActorId: ACTOR,
        creationId: REQUEST_ID,
      }),
    );
  });
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('streams text incrementally and ends with verified sources then done', async () => {
    await start(
      appWith({
        turns: [
          {
            toolCalls: [{ name: 'findLeads', input: { search: 'Ada' } }],
            chunks: ['You received ', '1 SIM order.'],
          },
        ],
      }),
    );
    const response = await fetch(chatUrl(), {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify(body()),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-store');

    const parts = await readParts(response);
    const types = parts.map((part) => part.type);
    expect(types.filter((type) => type === 'text')).toHaveLength(2);
    expect(types).toContain('progress');
    expect(types.at(-2)).toBe('sources');
    expect(types.at(-1)).toBe('done');

    const text = parts
      .filter((part): part is Extract<AiStreamPart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('');
    expect(text).toBe('You received 1 SIM order.');

    const sources = parts.find((part) => part.type === 'sources');
    expect(sources).toBeDefined();
    if (sources?.type === 'sources') {
      expect(sources.sources).toHaveLength(1);
      expect(sources.sources[0]?.href).toBe(`/w/getcanadasim/leads/${LEAD}`);
      expect(sources.sources[0]?.label).toBe('MS-TEST-101');
    }
  });

  it('answers a disabled deployment with a JSON error before any stream', async () => {
    await start(
      appWith({ config: { enabled: false, reason: 'disabled', workspaceIds: new Set() } }),
    );
    const response = await fetch(chatUrl(), {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify(body()),
    });
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect((await apiErrorResponseSchema.parse(await response.json())).error.code).toBe(
      'ai_unavailable',
    );
  });

  it('refuses a role that may not see lead detail', async () => {
    const viewer: StaffAccessSnapshot = {
      membershipId: MEMBERSHIP,
      status: 'active',
      roles: ['viewer'],
      permissions: [],
    };
    await start(appWith({ loadAccess: async () => viewer }));
    const response = await fetch(chatUrl(), {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify(body()),
    });
    expect(response.status).toBe(403);
    expect((await apiErrorResponseSchema.parse(await response.json())).error.code).toBe(
      'permission_denied',
    );
  });

  it('rejects a body that tries to supply an actor, site or model', async () => {
    await start();
    for (const extra of [{ actorId: 'x' }, { workspaceId: WORKSPACE }, { model: 'other' }]) {
      const response = await fetch(chatUrl(), {
        method: 'POST',
        headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
        body: JSON.stringify(body(extra)),
      });
      expect(response.status).toBe(400);
    }
  });

  it('rejects a conversation over the character or byte ceiling', async () => {
    await start();
    const tooLong = await fetch(chatUrl(), {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify(body({ message: 'a'.repeat(4001) })),
    });
    expect(tooLong.status).toBe(400);

    const history = Array.from({ length: 12 }, () => ({ role: 'user', text: 'a'.repeat(4000) }));
    const tooBig = await fetch(chatUrl(), {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify(body({ message: 'and?', history })),
    });
    expect(tooBig.status).toBe(400);
  });

  it('rejects a body over the 48 KiB byte ceiling even under the character ceiling', async () => {
    await start();
    // Four-byte characters: 13,200 characters fit the conversation budget but
    // 52,800 UTF-8 bytes do not, so only the byte ceiling can refuse this.
    const history = Array.from({ length: 3 }, () => ({ role: 'user', text: '😀'.repeat(4000) }));
    const response = await fetch(chatUrl(), {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify(body({ message: '😀'.repeat(1200), history })),
    });
    expect(response.status).toBe(400);
  });

  it('answers a rate limit with 429 and a retry-after before opening a stream', async () => {
    await start(appWith({ rateLimit: async () => ({ allowed: false, retryAfterSeconds: 42 }) }));
    const response = await fetch(chatUrl(), {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify(body()),
    });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('42');
    expect((await apiErrorResponseSchema.parse(await response.json())).error.code).toBe(
      'ai_rate_limited',
    );
  });

  it('refuses the same client request id twice inside a minute', async () => {
    await start();
    const send = () =>
      fetch(chatUrl(), {
        method: 'POST',
        headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
        body: JSON.stringify(body()),
      });
    expect((await send()).status).toBe(200);
    const duplicate = await send();
    expect(duplicate.status).toBe(409);
    expect((await apiErrorResponseSchema.parse(await duplicate.json())).error.code).toBe(
      'conflict',
    );
  });

  it('sends a typed error part when the provider fails, never a fabricated answer', async () => {
    await start(appWith({ turns: [{ failWith: 'provider_unavailable' }] }));
    const response = await fetch(chatUrl(), {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify(body()),
    });
    const parts = await readParts(response);
    const error = parts.find((part) => part.type === 'error');
    expect(error).toBeDefined();
    if (error?.type === 'error') expect(error.code).toBe('provider_unavailable');
    expect(parts.some((part) => part.type === 'text')).toBe(false);
    expect(parts.some((part) => part.type === 'done')).toBe(false);
  });

  it('stops with access_lost when the membership is revoked during the turn', async () => {
    let calls = 0;
    await start(
      appWith({
        turns: [{ toolCalls: [{ name: 'findLeads', input: {} }], chunks: ['Answer.'] }],
        loadAccess: async () => {
          calls += 1;
          const active: StaffAccessSnapshot = {
            membershipId: MEMBERSHIP,
            status: 'active',
            roles: ['owner'],
            permissions: [],
          };
          const revoked: StaffAccessSnapshot = { ...active, status: 'revoked' };
          // Revoked on the second read: the per-tool check, not the final one,
          // so this proves the model loop was aborted from inside a tool.
          return calls >= 2 ? revoked : active;
        },
      }),
    );
    const response = await fetch(chatUrl(), {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify(body()),
    });
    const parts = await readParts(response);
    const error = parts.find((part) => part.type === 'error');
    expect(error?.type === 'error' ? error.code : undefined).toBe('access_lost');
    // The aborted turn must not release an answer or look complete.
    expect(parts.some((part) => part.type === 'done')).toBe(false);
    expect(parts.some((part) => part.type === 'text')).toBe(false);
  });

  it('does not mark a truncated engine stream as a completed answer', async () => {
    await start(
      appWith({
        engine: {
          kind: 'fake',
          async *stream() {
            yield { type: 'text', text: 'An unfinished answer' };
          },
        },
      }),
    );
    const response = await fetch(chatUrl(), {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify(body()),
    });
    const parts = await readParts(response);
    expect(parts).toContainEqual({ type: 'text', text: 'An unfinished answer' });
    expect(
      parts.some((part) => part.type === 'error' && part.code === 'provider_unavailable'),
    ).toBe(true);
    expect(parts.some((part) => part.type === 'done' || part.type === 'sources')).toBe(false);
  });

  it('cancels upstream when the client aborts mid-stream', async () => {
    await start(appWith({ turns: [{ hangMs: 5_000, chunks: ['late'] }] }));
    const controller = new AbortController();
    const response = await fetch(chatUrl(), {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify(body()),
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    controller.abort();
    await expect(reader.read()).rejects.toThrow();
  });

  it('answers 401 before any provider call without a session', async () => {
    await start();
    const response = await fetch(chatUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body()),
    });
    expect(response.status).toBe(401);
  });
  it('delivers two text frames while the HTTP response is still open', async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await start(
      appWith({
        engine: {
          kind: 'fake',
          async *stream() {
            yield { type: 'text', text: 'First chunk' };
            yield { type: 'text', text: 'Second chunk' };
            await held;
            yield { type: 'finish' };
          },
        },
      }),
    );
    try {
      const response = await fetch(chatUrl(), {
        method: 'POST',
        headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
        body: JSON.stringify(body()),
        signal: AbortSignal.timeout(3000),
      });
      expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1');
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let received = '';
      while (!received.includes('Second chunk')) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        received += decoder.decode(chunk.value);
      }
      expect(received).toContain('First chunk');
      expect(received).not.toContain('[DONE]');
      release();
      while (!(await reader.read()).done) {
        /* drain */
      }
    } finally {
      release();
    }
  });
});
