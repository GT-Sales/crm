/*
 * C14: every limiter and readiness check Ask AI leans on fails closed. The
 * audit found each of these sound; these tests pin it, so later work cannot
 * quietly turn one into a pass-through: a limiter that cannot be reached
 * refuses the chat, the card routes and the upload; a schema probe that is
 * not ready (or cannot be asked) keeps the saved chat off; a plain-task probe
 * that says no (or fails) offers no plain task.
 */
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryR2DocumentStore } from '@gt-sales/adapters';
import {
  aiCapabilitiesResponseSchema,
  apiErrorResponseSchema,
  type StaffWorkspace,
} from '@gt-sales/contracts';
import type { RateLimitInput } from '@gt-sales/db';

import { createApp } from '../src/app.js';
import type { AiAttachmentStore } from '../src/ai/attachment-store.js';
import { AiAttachmentService } from '../src/ai/attachments.js';
import { fixedAiChatSchema, type AiChatSchemaProbe } from '../src/ai/chat-schema.js';
import type { AiAssistantConfig } from '../src/ai/config.js';
import type { AiConversationStore } from '../src/ai/conversation-store.js';
import { createFakeEngine, type EngineInput } from '../src/ai/engine.js';
import type { AiReadService } from '../src/ai/read-service.js';
import type { StaffSessionVerifier } from '../src/auth/session.js';
import type { DatabaseLeadWorkStore } from '../src/leads/work-store.js';
import type { LeadStore } from '../src/leads/store.js';
import type { ReportStore } from '../src/reports/store.js';
import type { StaffAccessSnapshot } from '../src/staff/authorization.js';
import type { StaffStore } from '../src/staff/store.js';
import type { WebsiteCredentialStore } from '../src/website/store.js';

const ACTOR = '20000000-0000-4000-8000-000000000d81';
const WORKSPACE = '10000000-0000-4000-8000-000000000d81';
const MEMBERSHIP = '30000000-0000-4000-8000-000000000d81';
const LEAD = '40000000-0000-4000-8000-000000000d81';

type Limiter = (input: RateLimitInput) => Promise<{ allowed: boolean; retryAfterSeconds: number }>;

const workspace: StaffWorkspace = {
  id: WORKSPACE,
  slug: 'fail-closed',
  name: 'Fail Closed',
  membershipId: MEMBERSHIP,
  roles: ['owner'],
};

const access: StaffAccessSnapshot = {
  membershipId: MEMBERSHIP,
  status: 'active',
  roles: ['owner'],
  permissions: [],
};

const verifier: StaffSessionVerifier = {
  verify: async (token) =>
    token === 'token' ? { actorId: ACTOR, verifiedEmail: 'owner@example.test' } : undefined,
};

const staffStore: StaffStore = {
  setDisplayName: async () => 1,
  bootstrapStaff: async () => [workspace],
  loadStaffAccess: async () => access,
  inviteStaff: async () => {
    throw new Error('unused');
  },
  revokeStaff: async () => 'not_found' as const,
  listAssignableMembers: async () => [],
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

const noopCredentialStore: WebsiteCredentialStore = {
  createCredential: async () => {
    throw new Error('unused');
  },
  listCredentials: async () => [],
  revokeCredential: async () => ({ status: 'not_found' }),
};

const reads: AiReadService = {
  overview: async () => ({ received: 0, submitted: 0, byStage: [] }),
  findLeads: async () => ({ rows: [], total: 0 }),
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

const config: AiAssistantConfig = {
  enabled: true,
  apiKey: 'test-key-not-real',
  signingKey: 'test-key-not-real',
  modelId: 'test/model',
  workspaceIds: new Set([WORKSPACE]),
};

const allow: Limiter = async () => ({ allowed: true, retryAfterSeconds: 0 });

/** A store whose every method is a mock that fails the test if a refusal let it run. */
function untouched<T extends object>(): { store: T; calls: () => string[] } {
  const called: string[] = [];
  // A null-prototype target, so the proxy may stand in for any store.
  const store: T = new Proxy(Object.create(null), {
    get: (_target, property) =>
      typeof property === 'string' && property !== 'then'
        ? vi.fn(async () => {
            called.push(property);
            throw new Error(`${property} must not run`);
          })
        : undefined,
  });
  return { store, calls: () => called };
}

let server: Server | undefined;
let baseUrl = '';

async function start(options: {
  rateLimit?: Limiter;
  schema?: AiChatSchemaProbe;
  conversations?: AiConversationStore;
  attachmentStore?: AiAttachmentStore;
  work?: DatabaseLeadWorkStore;
  engineCalls?: EngineInput[];
}): Promise<void> {
  const engine = createFakeEngine([{ chunks: ['An answer.'] }]);
  const app = createApp({
    staff: {
      sessionVerifier: verifier,
      store: staffStore,
      credentialStore: noopCredentialStore,
      leadStore: unusedLeadStore,
      reportStore: reports,
      ...(options.work ? { leadWorkStore: options.work } : {}),
      ai: {
        config,
        siteContext: {
          siteContext: async () => ({
            siteId: WORKSPACE,
            slug: 'fail-closed',
            name: 'Fail Closed',
            leadTypes: ['sim_order'],
          }),
        },
        reads,
        engine: {
          kind: 'fake',
          stream: (input: EngineInput) => {
            options.engineCalls?.push(input);
            return engine.stream(input);
          },
        },
        rateLimit: options.rateLimit ?? allow,
        chat: {
          schema: options.schema ?? fixedAiChatSchema(),
          ...(options.conversations ? { conversations: options.conversations } : {}),
          ...(options.attachmentStore
            ? {
                attachments: new AiAttachmentService(
                  options.attachmentStore,
                  new InMemoryR2DocumentStore(),
                  { bucket: 'documents', kinds: ['image', 'pdf', 'text'] },
                ),
              }
            : {}),
        },
      },
    },
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server?.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected TCP server');
  baseUrl = `http://127.0.0.1:${address.port}/api/v1/staff/workspaces/${WORKSPACE}/ai`;
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
});

function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function code(response: Response): Promise<string> {
  return apiErrorResponseSchema.parse(await response.json()).error.code;
}

const chatBody = (overrides: Record<string, unknown> = {}) => ({
  requestId: crypto.randomUUID(),
  message: 'How many SIM orders?',
  history: [],
  ...overrides,
});

describe('a limiter that cannot be reached refuses (C14)', () => {
  it.each(['ai_actor:', 'ai_site:', 'ai_site_day:', 'ai_replay:'])(
    'refuses the chat when its %s budget cannot be read, before the model is called',
    async (prefix) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const engineCalls: EngineInput[] = [];
      await start({
        engineCalls,
        rateLimit: async (input) => {
          if (input.bucketKey.startsWith(prefix)) throw new Error('limiter down');
          return { allowed: true, retryAfterSeconds: 0 };
        },
      });
      const response = await post('/chat', chatBody());
      expect(response.status).toBe(503);
      expect(await code(response)).toBe('ai_unavailable');
      expect(engineCalls).toHaveLength(0);
    },
  );

  it.each(['confirm', 'revise'])(
    'refuses %s when the card budget cannot be read, before any token is read or saved',
    async (path) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const work = untouched<DatabaseLeadWorkStore>();
      const request =
        path === 'confirm'
          ? { token: 'not-checked-before-the-limit' }
          : {
              token: 'not-checked-before-the-limit',
              draft: { kind: 'note', leadId: LEAD, body: 'Note' },
            };
      await start({
        work: work.store,
        rateLimit: async (input) => {
          if (input.bucketKey.startsWith('ai_card:')) throw new Error('limiter down');
          return { allowed: true, retryAfterSeconds: 0 };
        },
      });
      const refused = await post(`/actions/${path}`, request);
      expect(refused.status).toBe(503);
      expect(await code(refused)).toBe('ai_unavailable');
      expect(work.calls()).toEqual([]);

      // The same request with a working limiter is refused for its token, not 503:
      // the refusal above came from the limiter.
      if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
      await start({ work: work.store });
      const checked = await post(`/actions/${path}`, request);
      expect(checked.status).not.toBe(503);
      expect(checked.status).toBeGreaterThanOrEqual(400);
    },
  );

  it('refuses an upload when the upload budget cannot be read, before any row is written', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const attachments = untouched<AiAttachmentStore>();
    const conversations = untouched<AiConversationStore>();
    await start({
      conversations: conversations.store,
      attachmentStore: attachments.store,
      rateLimit: async (input) => {
        if (input.bucketKey.startsWith('ai_upload:')) throw new Error('limiter down');
        return { allowed: true, retryAfterSeconds: 0 };
      },
    });
    const response = await post('/attachments/intents', {
      fileName: 'letter.png',
      mediaType: 'image/png',
      byteSize: 100,
    });
    expect(response.status).toBe(503);
    expect(await code(response)).toBe('attachments_unavailable');
    expect(attachments.calls()).toEqual([]);
  });
});

describe('a readiness check that is not ready keeps the feature off (C14)', () => {
  const notReady = fixedAiChatSchema({
    conversations: false,
    inputTokens: false,
    attachmentSweep: false,
    effort: false,
    chatErasure: false,
  });
  const failing: AiChatSchemaProbe = {
    state: async () => {
      throw new Error('database down');
    },
  };

  it.each([
    ['not ready', notReady],
    ['unanswerable', failing],
  ] as const)(
    'claims no saved chat and refuses a stored turn while the chat schema is %s',
    async (_label, schema) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const conversations = untouched<AiConversationStore>();
      const engineCalls: EngineInput[] = [];
      await start({ schema, conversations: conversations.store, engineCalls });
      const capabilities = aiCapabilitiesResponseSchema.parse(
        await (
          await fetch(`${baseUrl}/capabilities`, { headers: { authorization: 'Bearer token' } })
        ).json(),
      );
      expect(capabilities.conversations).toBeUndefined();
      expect(capabilities.attachments).toBeUndefined();
      const stored = await post(
        '/chat',
        chatBody({ conversationId: crypto.randomUUID(), newConversation: true }),
      );
      expect(stored.status).toBe(503);
      expect(await code(stored)).toBe('ai_unavailable');
      expect(conversations.calls()).toEqual([]);
      expect(engineCalls).toHaveLength(0);
      const list = await fetch(`${baseUrl}/conversations`, {
        headers: { authorization: 'Bearer token' },
      });
      expect(list.status).toBe(503);
    },
  );

  it.each([
    ['says no', async (): Promise<boolean> => false],
    [
      'fails',
      async (): Promise<boolean> => {
        throw new Error('database down');
      },
    ],
  ] as const)('offers no plain task while the plain-task probe %s', async (_label, probe) => {
    const work: DatabaseLeadWorkStore = Object.assign(Object.create(null), {
      createPlainTask: vi.fn(async () => {
        throw new Error('must not run');
      }),
      plainTasksReady: vi.fn(probe),
    });
    await start({ work });
    const capabilities = aiCapabilitiesResponseSchema.parse(
      await (
        await fetch(`${baseUrl}/capabilities`, { headers: { authorization: 'Bearer token' } })
      ).json(),
    );
    expect(capabilities.taskActions ?? []).not.toContain('plain_task');
    expect(vi.mocked(work.plainTasksReady)).toHaveBeenCalled();
  });

  it('does offer both when the checks say yes (the control for the tests above)', async () => {
    const conversations = untouched<AiConversationStore>();
    const work: DatabaseLeadWorkStore = Object.assign(Object.create(null), {
      createPlainTask: vi.fn(),
      plainTasksReady: vi.fn(async () => true),
    });
    await start({ conversations: conversations.store, work });
    const capabilities = aiCapabilitiesResponseSchema.parse(
      await (
        await fetch(`${baseUrl}/capabilities`, { headers: { authorization: 'Bearer token' } })
      ).json(),
    );
    expect(capabilities.conversations).toBe(true);
    expect(capabilities.taskActions).toContain('plain_task');
  });
});
