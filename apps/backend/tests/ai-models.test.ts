import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import {
  aiCapabilitiesResponseSchema,
  aiModelSettingsResponseSchema,
  aiWirePartSchema,
  apiErrorResponseSchema,
  updateAiModelSettingsResponseSchema,
  type AiModelChoice,
  type AiStreamPart,
  type StaffWorkspace,
} from '@gt-sales/contracts';
import type { RateLimitInput } from '@gt-sales/db';

import { createApp } from '../src/app.js';
import type { AiAssistantConfig } from '../src/ai/config.js';
import {
  createFakeEngine,
  createGatewayEngine,
  gatewayRouting,
  type EngineEvent,
  type EngineInput,
  type FakeAssistantEngine,
} from '../src/ai/engine.js';
import type { AiTurnLog } from '../src/ai/logging.js';
import {
  CachedModelCatalogue,
  catalogueModels,
  pricePerMillion,
  type AiModelCatalogue,
  type GatewayCatalogueEntry,
} from '../src/ai/model-catalogue.js';
import type {
  AiModelSettingsStore,
  StoredAiModelSettings,
} from '../src/ai/model-settings-store.js';
import type { AiReadService } from '../src/ai/read-service.js';
import type { AiSiteContextStore } from '../src/ai/site-context.js';
import type { StaffSessionVerifier, VerifiedStaffSession } from '../src/auth/session.js';
import type { LeadStore } from '../src/leads/store.js';
import type { ReportStore } from '../src/reports/store.js';
import type { StaffAccessSnapshot } from '../src/staff/authorization.js';
import type { StaffStore } from '../src/staff/store.js';
import type { WebsiteCredentialStore } from '../src/website/store.js';

// Settings → AI models and the composer's model picker, over the HTTP routes
// with a fake engine, an in-memory settings store and a scripted catalogue:
// the Gateway is never called.

const ACTOR = '20000000-0000-4000-8000-000000000d81';
const WORKSPACE = '10000000-0000-4000-8000-000000000d81';
const MEMBERSHIP = '30000000-0000-4000-8000-000000000d81';
const NOW = new Date('2026-11-20T12:00:00.000Z');

const MODEL_ONE = 'vendor-a/model-one';
const MODEL_TWO = 'vendor-b/model-two';
const MODEL_THREE = 'vendor-c/model-three';

const OWNER: StaffAccessSnapshot = {
  membershipId: MEMBERSHIP,
  status: 'active',
  roles: ['owner'],
  permissions: [],
};
const LEADS_MEMBER: StaffAccessSnapshot = { ...OWNER, roles: ['leads'] };

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
  constructor(public access: StaffAccessSnapshot | undefined = OWNER) {}
  setDisplayName = async () => 1;
  async bootstrapStaff() {
    return [workspace];
  }
  async loadStaffAccess() {
    return this.access;
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

/** The settings store as the database keeps it, with the schema switch and a failure switch. */
class MemoryModelSettings implements AiModelSettingsStore {
  saved: StoredAiModelSettings | undefined;
  ready = true;
  failReads = false;
  saves: { requestId: string; allowedModels: readonly AiModelChoice[]; defaultModel: string }[] =
    [];
  async available() {
    return this.ready;
  }
  async get() {
    if (this.failReads) throw Object.assign(new Error('connection lost'), { code: '08006' });
    return this.ready ? this.saved : undefined;
  }
  async save(
    scope: { requestId: string },
    input: { allowedModels: readonly AiModelChoice[]; defaultModel: string },
  ) {
    if (!this.ready) return { status: 'unavailable' as const };
    this.saves.push({ requestId: scope.requestId, ...input });
    this.saved = { ...input, updatedAt: NOW };
    return { status: 'saved' as const, settings: this.saved };
  }
}

const entries: GatewayCatalogueEntry[] = [
  {
    id: MODEL_ONE,
    name: 'Model One',
    description: 'A fast model.',
    pricing: { input: '0.0000005', output: '0.0000015' },
    modelType: 'language',
  },
  { id: MODEL_TWO, name: 'Model Two', description: null, pricing: null, modelType: 'language' },
  { id: MODEL_THREE, name: 'Model Three', modelType: null },
  { id: 'vendor-a/embedder', name: 'Embedder', modelType: 'embedding' },
];

function scriptedCatalogue(result: 'ok' | 'unavailable' = 'ok') {
  const calls: { fresh?: boolean }[] = [];
  const catalogue: AiModelCatalogue = {
    async models(options = {}) {
      calls.push(options);
      return result === 'ok'
        ? { status: 'ok', models: catalogueModels(entries) }
        : { status: 'unavailable' };
    },
  };
  return { catalogue, calls };
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

function config(overrides: Partial<AiAssistantConfig> = {}): AiAssistantConfig {
  return {
    enabled: true,
    apiKey: 'test-key-not-real',
    signingKey: 'test-key-not-real',
    modelId: 'deploy/model',
    workspaceIds: new Set([WORKSPACE]),
    ...overrides,
  };
}

let server: Server | undefined;
let baseUrl: string;

interface Harness {
  engine: FakeAssistantEngine;
  settings: MemoryModelSettings;
  catalogueCalls: { fresh?: boolean }[];
  limits: RateLimitInput[];
  turns: AiTurnLog[];
  failures: unknown[];
}

async function start(
  options: {
    config?: AiAssistantConfig;
    access?: StaffAccessSnapshot;
    /** False: a deployment wired without the model settings at all (as before this change). */
    models?: boolean;
    catalogue?: 'ok' | 'unavailable' | 'none';
    saved?: StoredAiModelSettings;
  } = {},
): Promise<Harness> {
  const engine = createFakeEngine([{ chunks: ['Fine.'] }]);
  const settings = new MemoryModelSettings();
  settings.saved = options.saved;
  const scripted = scriptedCatalogue(options.catalogue === 'unavailable' ? 'unavailable' : 'ok');
  const limits: RateLimitInput[] = [];
  const turns: AiTurnLog[] = [];
  const failures: unknown[] = [];
  const app = createApp({
    staff: {
      errorTracker: { captureException: (error: unknown) => void failures.push(error) },
      sessionVerifier: new TokenVerifier(),
      store: new MemoryStaffStore(options.access ?? OWNER),
      credentialStore: noopCredentialStore,
      leadStore: unusedLeadStore,
      reportStore: reports,
      ai: {
        config: options.config ?? config(),
        siteContext,
        reads,
        engine,
        rateLimit: async (input) => {
          limits.push(input);
          return { allowed: true, retryAfterSeconds: 0 };
        },
        turns: { record: async (turn) => void turns.push(turn) },
        ...(options.models === false
          ? {}
          : {
              models: {
                settings,
                ...(options.catalogue === 'none' ? {} : { catalogue: scripted.catalogue }),
              },
            }),
        now: () => NOW,
      },
    },
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server?.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected TCP server');
  baseUrl = `http://127.0.0.1:${address.port}`;
  return { engine, settings, catalogueCalls: scripted.calls, limits, turns, failures };
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
  vi.restoreAllMocks();
});

const api = (path: string) => `${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/ai/${path}`;
const auth = { authorization: 'Bearer token' };
const json = { ...auth, 'content-type': 'application/json' };

const saved = (
  ids: readonly string[],
  defaultModel: string = ids[0] ?? MODEL_ONE,
): StoredAiModelSettings => ({
  allowedModels: ids.map((id) => ({ id, label: `Label ${id}` })),
  defaultModel,
  updatedAt: NOW,
});

const getSettings = () => fetch(api('model-settings'), { headers: auth });
const putSettings = (body: unknown) =>
  fetch(api('model-settings'), { method: 'PUT', headers: json, body: JSON.stringify(body) });
const getCapabilities = async () =>
  aiCapabilitiesResponseSchema.parse(
    await (await fetch(api('capabilities'), { headers: auth })).json(),
  );
const chat = (overrides: Record<string, unknown> = {}) =>
  fetch(api('chat'), {
    method: 'POST',
    headers: json,
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      message: 'How many SIM orders did we receive?',
      history: [],
      ...overrides,
    }),
  });

async function readParts(response: Response): Promise<AiStreamPart[]> {
  const text = await response.text();
  return text
    .split('\n\n')
    .map((frame) =>
      frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n'),
    )
    .filter((payload) => payload.length > 0 && payload !== '[DONE]')
    .map((payload) => aiWirePartSchema.parse(JSON.parse(payload)).data);
}

async function refusal(response: Response) {
  return { status: response.status, ...apiErrorResponseSchema.parse(await response.json()).error };
}

describe('the Gateway catalogue', () => {
  it('keeps language models only (an untyped entry counts as one), with cleaned text and prices per million', () => {
    expect(
      catalogueModels([
        ...entries,
        { id: 'no-vendor', name: 'Bad id' },
        { id: MODEL_ONE, name: 'Duplicate' },
        {
          id: 'vendor-d/long',
          name: '  Spaced\n\u0007Name  ',
          description: 'x'.repeat(400),
          pricing: { input: 'not a number', output: '-1' },
        },
      ]),
    ).toEqual([
      {
        id: MODEL_ONE,
        name: 'Model One',
        vendor: 'vendor-a',
        description: 'A fast model.',
        inputPricePerMillion: 0.5,
        outputPricePerMillion: 1.5,
      },
      {
        id: MODEL_TWO,
        name: 'Model Two',
        vendor: 'vendor-b',
        description: null,
        inputPricePerMillion: null,
        outputPricePerMillion: null,
      },
      {
        id: MODEL_THREE,
        name: 'Model Three',
        vendor: 'vendor-c',
        description: null,
        inputPricePerMillion: null,
        outputPricePerMillion: null,
      },
      {
        id: 'vendor-d/long',
        name: 'Spaced Name',
        vendor: 'vendor-d',
        description: `${'x'.repeat(239)}…`,
        inputPricePerMillion: null,
        outputPricePerMillion: null,
      },
    ]);
    expect(pricePerMillion('0.000003')).toBe(3);
    expect(pricePerMillion('0')).toBe(0);
    expect(pricePerMillion('')).toBeNull();
    expect(pricePerMillion(undefined)).toBeNull();
  });

  it('keeps a read for ten minutes, a failure for one, and reads afresh for a save', async () => {
    let clock = 0;
    let fail = false;
    const fetchEntries = vi.fn(async () => {
      if (fail) throw new Error('gateway said: secret request body');
      return { models: entries };
    });
    const catalogue = new CachedModelCatalogue(fetchEntries, { now: () => clock });
    const [first, second] = await Promise.all([catalogue.models(), catalogue.models()]);
    expect(first).toEqual(second);
    expect(fetchEntries).toHaveBeenCalledTimes(1);
    clock = 9 * 60_000;
    await catalogue.models();
    expect(fetchEntries).toHaveBeenCalledTimes(1);
    await catalogue.models({ fresh: true });
    expect(fetchEntries).toHaveBeenCalledTimes(2);
    clock += 10 * 60_000;
    fail = true;
    expect(await catalogue.models()).toEqual({ status: 'unavailable' });
    expect(fetchEntries).toHaveBeenCalledTimes(3);
    fail = false;
    clock += 30_000;
    expect(await catalogue.models()).toEqual({ status: 'unavailable' });
    clock += 31_000;
    expect((await catalogue.models()).status).toBe('ok');
    expect(fetchEntries).toHaveBeenCalledTimes(4);
  });
});

describe('the gateway engine with a site’s model', () => {
  const usage = {
    inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 4, text: 4, reasoning: undefined },
  };
  const answering = () =>
    new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start' as const, id: 't' },
            { type: 'text-delta' as const, id: 't', delta: 'ok' },
            { type: 'text-end' as const, id: 't' },
            {
              type: 'finish' as const,
              finishReason: { unified: 'stop' as const, raw: undefined },
              usage,
            },
          ],
        }),
      }),
    });
  const input = (overrides: Partial<EngineInput> = {}): EngineInput => ({
    system: 's',
    messages: [{ role: 'user', text: 'Hello' }],
    tools: {},
    signal: new AbortController().signal,
    ...overrides,
  });
  async function run(
    options: Parameters<typeof createGatewayEngine>[0],
    turn: Partial<EngineInput>,
  ) {
    const asked: string[] = [];
    const model = answering();
    const events: EngineEvent[] = [];
    const engine = createGatewayEngine(options, (modelId) => {
      asked.push(modelId);
      return model;
    });
    for await (const event of engine.stream(input(turn))) events.push(event);
    return { asked, call: model.doStreamCalls[0], events };
  }
  const deployment = {
    apiKey: 'k',
    modelId: 'deploy/model',
    highEffort: { modelId: 'deploy/thinker', ownModel: true as const, reasoning: 'low' as const },
  };

  it('serves a turn with no site model on the deployment’s models, routed exactly as before', async () => {
    expect((await run(deployment, {})).asked).toEqual(['deploy/model']);
    const high = await run(deployment, { effort: 'high' });
    expect(high.asked).toEqual(['deploy/thinker']);
    expect(high.call?.providerOptions).toBeUndefined();
    expect(gatewayRouting(undefined, false)).toBeUndefined();
  });

  it('serves the site’s model at both levels and asks the Gateway for hosts with tool calls', async () => {
    const normal = await run(deployment, { modelId: MODEL_TWO });
    expect(normal.asked).toEqual([MODEL_TWO]);
    expect(normal.call?.providerOptions).toEqual({ gateway: { has: ['tool-use'] } });
    const high = await run(deployment, { modelId: MODEL_TWO, effort: 'high' });
    expect(high.asked).toEqual([MODEL_TWO]);
    // High keeps its budgets and its reasoning word on the chosen model.
    expect(high.call?.reasoning).toBe('low');
    expect(high.call?.maxOutputTokens).toBe(12_000);
    expect(high.events.at(-1)).toMatchObject({ type: 'finish' });
  });

  it('keeps the host pin for every model', async () => {
    const pinned = await run(
      { ...deployment, providers: ['host-a', 'host-b'] },
      { modelId: MODEL_ONE },
    );
    expect(pinned.call?.providerOptions).toEqual({
      gateway: { only: ['host-a', 'host-b'], order: ['host-a', 'host-b'], has: ['tool-use'] },
    });
    const deploymentModel = await run({ ...deployment, providers: ['host-a'] }, {});
    expect(deploymentModel.call?.providerOptions).toEqual({
      gateway: { only: ['host-a'], order: ['host-a'] },
    });
  });
});

describe('GET /workspaces/:id/ai/model-settings', () => {
  it('shows the owner the catalogue’s language models, the saved list and the deployment', async () => {
    await start({
      config: config({
        providers: ['host-a'],
        highEffort: { modelId: 'deploy/thinker', ownModel: true },
      }),
      saved: saved([MODEL_ONE, MODEL_TWO], MODEL_TWO),
    });
    const response = await getSettings();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = aiModelSettingsResponseSchema.parse(await response.json());
    expect(body.assistant).toEqual({
      enabled: true,
      configuredModel: 'deploy/model',
      highEffortModel: 'deploy/thinker',
    });
    expect(body.storage).toBe(true);
    expect(body.providers).toEqual(['host-a']);
    expect(body.saved).toEqual({
      allowedModels: [
        { id: MODEL_ONE, label: `Label ${MODEL_ONE}` },
        { id: MODEL_TWO, label: `Label ${MODEL_TWO}` },
      ],
      defaultModel: MODEL_TWO,
      updatedAt: NOW.toISOString(),
    });
    expect(body.catalogue.available).toBe(true);
    expect(body.catalogue.models.map((model) => model.id)).toEqual([
      MODEL_ONE,
      MODEL_TWO,
      MODEL_THREE,
    ]);
    expect(body.maxAllowed).toBe(8);
    expect(JSON.stringify(body)).not.toContain('test-key-not-real');
  });

  it('refuses everyone but the owner, a leads member with Ask AI included', async () => {
    const harness = await start({ access: LEADS_MEMBER });
    const response = await getSettings();
    expect(response.status).toBe(403);
    expect(
      (await refusal(await putSettings({ allowedModels: [MODEL_ONE], defaultModel: MODEL_ONE })))
        .status,
    ).toBe(403);
    expect(harness.settings.saves).toEqual([]);
    expect(harness.catalogueCalls).toEqual([]);
  });

  it('says before migration 0040 that nothing can be stored, and with no key that the catalogue is unavailable', async () => {
    const harness = await start({ catalogue: 'none' });
    harness.settings.ready = false;
    const body = aiModelSettingsResponseSchema.parse(await (await getSettings()).json());
    expect(body.storage).toBe(false);
    expect(body.saved).toBeNull();
    expect(body.catalogue).toEqual({ available: false, models: [] });
  });

  it('reads while Ask AI is off for the site, so the owner can prepare the list', async () => {
    await start({ config: config({ workspaceIds: new Set() }) });
    const body = aiModelSettingsResponseSchema.parse(await (await getSettings()).json());
    expect(body.assistant.enabled).toBe(false);
    expect(body.catalogue.available).toBe(true);
  });

  it('answers a deployment wired without model settings as storage off', async () => {
    await start({ models: false });
    const body = aiModelSettingsResponseSchema.parse(await (await getSettings()).json());
    expect(body.storage).toBe(false);
    expect(body.catalogue.available).toBe(false);
  });
});

describe('PUT /workspaces/:id/ai/model-settings', () => {
  it('checks every id against a fresh catalogue and saves the catalogue’s names as labels', async () => {
    const harness = await start();
    const response = await putSettings({
      allowedModels: [MODEL_TWO, MODEL_THREE],
      defaultModel: MODEL_THREE,
    });
    expect(response.status).toBe(200);
    const body = updateAiModelSettingsResponseSchema.parse(await response.json());
    expect(body.saved).toEqual({
      allowedModels: [
        { id: MODEL_TWO, label: 'Model Two' },
        { id: MODEL_THREE, label: 'Model Three' },
      ],
      defaultModel: MODEL_THREE,
      updatedAt: NOW.toISOString(),
    });
    expect(harness.catalogueCalls).toEqual([{ fresh: true }]);
    expect(harness.settings.saves).toEqual([
      {
        requestId: body.requestId,
        allowedModels: [
          { id: MODEL_TWO, label: 'Model Two' },
          { id: MODEL_THREE, label: 'Model Three' },
        ],
        defaultModel: MODEL_THREE,
      },
    ]);
  });

  it('refuses an id the catalogue does not hold as a language model, naming it', async () => {
    const harness = await start();
    for (const id of ['vendor-a/embedder', 'vendor-z/unknown']) {
      const error = await refusal(
        await putSettings({ allowedModels: [MODEL_ONE, id], defaultModel: MODEL_ONE }),
      );
      expect(error).toMatchObject({
        status: 400,
        code: 'invalid_request',
        details: { reason: 'model_unavailable', modelId: id },
      });
    }
    expect(harness.settings.saves).toEqual([]);
  });

  it('refuses a malformed save: no models, more than 8, a repeat or a default outside the list', async () => {
    const harness = await start();
    const nine = Array.from({ length: 9 }, (_, index) => `vendor-a/model-${String(index)}`);
    for (const body of [
      { allowedModels: [], defaultModel: MODEL_ONE },
      { allowedModels: nine, defaultModel: 'vendor-a/model-0' },
      { allowedModels: [MODEL_ONE, MODEL_ONE], defaultModel: MODEL_ONE },
      { allowedModels: [MODEL_ONE], defaultModel: MODEL_TWO },
      { allowedModels: [MODEL_ONE], defaultModel: MODEL_ONE, labels: ['Mine'] },
    ]) {
      expect((await refusal(await putSettings(body))).code).toBe('invalid_request');
    }
    expect(harness.catalogueCalls).toEqual([]);
    expect(harness.settings.saves).toEqual([]);
  });

  it('cannot save before migration 0040, nor when the catalogue does not answer, nor without a key', async () => {
    const before = await start();
    before.settings.ready = false;
    expect(
      await refusal(await putSettings({ allowedModels: [MODEL_ONE], defaultModel: MODEL_ONE })),
    ).toMatchObject({ status: 503, code: 'ai_models_unavailable', details: { reason: 'storage' } });
    expect(before.catalogueCalls).toEqual([]);
    await new Promise<void>((resolve) => server?.close(() => resolve()));

    const silent = await start({ catalogue: 'unavailable' });
    expect(
      await refusal(await putSettings({ allowedModels: [MODEL_ONE], defaultModel: MODEL_ONE })),
    ).toMatchObject({
      status: 503,
      code: 'ai_models_unavailable',
      details: { reason: 'catalogue' },
    });
    expect(silent.settings.saves).toEqual([]);
    await new Promise<void>((resolve) => server?.close(() => resolve()));

    await start({ config: config({ enabled: false, reason: 'not_configured' }) });
    expect(
      await refusal(await putSettings({ allowedModels: [MODEL_ONE], defaultModel: MODEL_ONE })),
    ).toMatchObject({ status: 503, code: 'ai_unavailable' });
  });
});

describe('capabilities list the site’s models', () => {
  it('lists more than one saved model, the default first, and nothing for one, none or before 0040', async () => {
    const harness = await start({ saved: saved([MODEL_ONE, MODEL_TWO, MODEL_THREE], MODEL_TWO) });
    const listed = await getCapabilities();
    expect(listed.models).toEqual([
      { id: MODEL_TWO, label: `Label ${MODEL_TWO}` },
      { id: MODEL_ONE, label: `Label ${MODEL_ONE}` },
      { id: MODEL_THREE, label: `Label ${MODEL_THREE}` },
    ]);
    expect(listed.defaultModel).toBe(MODEL_TWO);

    harness.settings.saved = saved([MODEL_ONE]);
    expect(await getCapabilities()).not.toHaveProperty('models');
    harness.settings.saved = undefined;
    expect(await getCapabilities()).not.toHaveProperty('models');
    harness.settings.saved = saved([MODEL_ONE, MODEL_TWO]);
    harness.settings.ready = false;
    const before = await getCapabilities();
    expect(before).not.toHaveProperty('models');
    expect(before).not.toHaveProperty('defaultModel');
  });

  it('leaves the picker out, not the assistant, when the settings cannot be read', async () => {
    const harness = await start({ saved: saved([MODEL_ONE, MODEL_TWO]) });
    harness.settings.failReads = true;
    const response = await fetch(api('capabilities'), { headers: auth });
    expect(response.status).toBe(200);
    const body = aiCapabilitiesResponseSchema.parse(await response.json());
    expect(body.available).toBe(true);
    expect(body).not.toHaveProperty('models');
    expect(harness.failures.map(String)).toContain('Error: ai_model_settings_failed:08006');
  });

  it('lists no models where Ask AI is unavailable for the site', async () => {
    await start({
      config: config({ workspaceIds: new Set() }),
      saved: saved([MODEL_ONE, MODEL_TWO]),
    });
    expect(await getCapabilities()).not.toHaveProperty('models');
  });
});

describe('a chat turn on a chosen model', () => {
  it('serves a model from the saved list at Normal, recording and logging it', async () => {
    const harness = await start({ saved: saved([MODEL_ONE, MODEL_TWO]) });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const parts = await readParts(await chat({ model: MODEL_TWO }));
    expect(parts.at(-1)?.type).toBe('done');
    expect(harness.engine.inputs[0]?.modelId).toBe(MODEL_TWO);
    expect(harness.turns[0]).toMatchObject({ modelId: MODEL_TWO, effort: 'normal' });
    const line = info.mock.calls
      .map((call) => String(call[0]))
      .find((entry) => entry.includes('"event":"ai_turn"'));
    expect(JSON.parse(line ?? '{}')).toMatchObject({ model: MODEL_TWO });
  });

  it('serves the chosen model at High too, with High’s own limits', async () => {
    const harness = await start({
      config: config({ highEffort: { modelId: 'deploy/thinker', ownModel: true } }),
      saved: saved([MODEL_ONE, MODEL_TWO]),
    });
    await readParts(await chat({ model: MODEL_TWO, effort: 'high' }));
    expect(harness.engine.inputs[0]).toMatchObject({ modelId: MODEL_TWO, effort: 'high' });
    expect(harness.turns[0]).toMatchObject({ modelId: MODEL_TWO, effort: 'high' });
    expect(harness.limits.map((limit) => limit.bucketKey.split(':')[0])).toContain('ai_high_actor');
  });

  it('refuses a model outside the saved list before any limiter or model work', async () => {
    for (const setup of [
      { saved: saved([MODEL_ONE, MODEL_TWO]), model: MODEL_THREE },
      { saved: undefined, model: MODEL_ONE },
    ]) {
      const harness = await start(setup.saved ? { saved: setup.saved } : {});
      const error = await refusal(await chat({ model: setup.model }));
      expect(error).toMatchObject({
        status: 400,
        code: 'invalid_request',
        details: { reason: 'model_unavailable' },
      });
      expect(harness.limits).toEqual([]);
      expect(harness.engine.inputs).toEqual([]);
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });

  it('refuses a named model before 0040 and on a deployment without model settings', async () => {
    const before = await start({ saved: saved([MODEL_ONE, MODEL_TWO]) });
    before.settings.ready = false;
    expect((await refusal(await chat({ model: MODEL_TWO }))).details).toEqual({
      reason: 'model_unavailable',
    });
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    const unwired = await start({ models: false });
    expect((await refusal(await chat({ model: MODEL_TWO }))).status).toBe(400);
    expect(unwired.engine.inputs).toEqual([]);
  });

  it('serves a question with no model on the site’s saved default, at Normal and at High without a model of its own', async () => {
    const harness = await start({
      config: config({ highEffort: { modelId: 'deploy/model' } }),
      saved: saved([MODEL_ONE, MODEL_TWO], MODEL_TWO),
    });
    await readParts(await chat());
    await readParts(await chat({ effort: 'high' }));
    expect(harness.engine.inputs.map((input) => input.modelId)).toEqual([MODEL_TWO, MODEL_TWO]);
    expect(harness.turns.map((turn) => turn.modelId)).toEqual([MODEL_TWO, MODEL_TWO]);
  });

  it('keeps AI_GATEWAY_MODEL_HIGH for a High question with no model chosen', async () => {
    const harness = await start({
      config: config({ highEffort: { modelId: 'deploy/thinker', ownModel: true } }),
      saved: saved([MODEL_ONE, MODEL_TWO], MODEL_TWO),
    });
    await readParts(await chat({ effort: 'high' }));
    expect(harness.engine.inputs[0]).not.toHaveProperty('modelId');
    expect(harness.turns[0]?.modelId).toBe('deploy/thinker');
  });

  it('runs exactly as before with nothing saved, before 0040 or with no model settings wired', async () => {
    const runs: { input: unknown; model: string | undefined }[] = [];
    for (const setup of ['nothing saved', 'before 0040', 'unwired'] as const) {
      const harness = await start(setup === 'unwired' ? { models: false } : {});
      if (setup === 'before 0040') harness.settings.ready = false;
      await readParts(await chat({ requestId: '50000000-0000-4000-8000-000000000d81' }));
      const {
        signal: _signal,
        executeTool: _execute,
        tools,
        ...rest
      } = harness.engine.inputs[0] ?? {};
      runs.push({
        input: {
          ...Object.fromEntries(
            Object.entries(rest).map(([key, value]) => [
              key,
              typeof value === 'function' ? 'function' : value,
            ]),
          ),
          tools: Object.keys(tools ?? {}),
        },
        model: harness.turns[0]?.modelId,
      });
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
    expect(runs[0]?.model).toBe('deploy/model');
    expect(runs[0]?.input).not.toHaveProperty('modelId');
  });

  it('serves an unnamed question on the deployment’s model when the settings cannot be read, and refuses a named one', async () => {
    const harness = await start({ saved: saved([MODEL_ONE, MODEL_TWO], MODEL_TWO) });
    harness.settings.failReads = true;
    const parts = await readParts(await chat());
    expect(parts.at(-1)?.type).toBe('done');
    expect(harness.engine.inputs[0]).not.toHaveProperty('modelId');
    expect(harness.turns[0]?.modelId).toBe('deploy/model');
    const named = await refusal(await chat({ model: MODEL_TWO }));
    expect(named).toMatchObject({ status: 503, code: 'ai_unavailable' });
    expect(harness.engine.inputs).toHaveLength(1);
  });
});
