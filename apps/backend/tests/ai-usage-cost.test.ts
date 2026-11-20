import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  aiUsageCostSchema,
  aiUsageResponseSchema,
  type AiUsageDay,
  type StaffWorkspace,
} from '@gt-sales/contracts';

import { createApp } from '../src/app.js';
import { fixedAiChatSchema } from '../src/ai/chat-schema.js';
import { createFakeEngine } from '../src/ai/engine.js';
import {
  catalogueRead,
  type AiCatalogueResult,
  type AiModelCatalogue,
} from '../src/ai/model-catalogue.js';
import type { AiModelSettingsStore } from '../src/ai/model-settings-store.js';
import type { AiUsageResult, AiUsageStore } from '../src/ai/usage-store.js';
import type { StaffSessionVerifier, VerifiedStaffSession } from '../src/auth/session.js';
import type { LeadStore } from '../src/leads/store.js';
import { AI_USAGE_CATALOGUE_WAIT_MS } from '../src/routes/ai-conversations.js';
import type { StaffAccessSnapshot } from '../src/staff/authorization.js';
import type { StaffStore } from '../src/staff/store.js';
import {
  AI_USAGE_COST_BASIS,
  microUsdOf,
  parseUsdPerToken,
  priceAiUsage,
  usagePriceList,
  usdPerMillionText,
  type AiUsageTokenBreakdown,
} from '../src/ai/usage-cost.js';

// The approximate cost on Settings → AI usage: exact decimal pricing of each
// model's tokens at the catalogue's list price, with fake model ids. The
// Gateway is never called.

const ONE = 'vendor-a/model-one';
const TWO = 'vendor-b/model-two';
const UNPRICED = 'vendor-c/no-price';
const GONE = 'vendor-d/not-listed';
const ADA = '20000000-0000-4000-8000-0000000000a1';
const BEA = '20000000-0000-4000-8000-0000000000b1';

/** $2.50 in / $15 out per million; $0.15 / $0.60; one listed with no price. */
const catalogue: AiCatalogueResult = {
  status: 'ok',
  ...catalogueRead([
    {
      id: ONE,
      name: 'Model One',
      pricing: { input: '0.0000025', output: '0.000015' },
      modelType: 'language',
    },
    { id: TWO, name: 'Model Two', pricing: { input: '1.5e-7', output: '6e-7' } },
    { id: UNPRICED, name: 'No Price', pricing: null },
    {
      id: 'vendor-a/embedder',
      name: 'Embedder',
      pricing: { input: '1', output: '1' },
      modelType: 'embedding',
    },
  ]),
};

const row = (
  engine: string,
  model: string | null,
  turns: number,
  input: number | bigint,
  output: number | bigint,
) => ({ engine, model, turns, inputTokens: BigInt(input), outputTokens: BigInt(output) });

const DAYS = ['2026-11-16', '2026-11-17', '2026-11-18'];

/** Two members over three days, on two priced models, one unpriced, an unlisted one, no model and the test engine. */
const breakdown: AiUsageTokenBreakdown = {
  byDay: [
    { ...row('gateway', ONE, 2, 1_000_000, 100_000), day: '2026-11-16' },
    { ...row('gateway', TWO, 1, 3, 0), day: '2026-11-16' },
    { ...row('gateway', ONE, 1, 200_000, 20_000), day: '2026-11-18' },
    { ...row('gateway', TWO, 3, 2_000_000, 500_000), day: '2026-11-18' },
    { ...row('gateway', UNPRICED, 1, 5000, 500), day: '2026-11-18' },
    { ...row('gateway', GONE, 1, 4000, 400), day: '2026-11-18' },
    { ...row('gateway', null, 2, 900, 90), day: '2026-11-16' },
    { ...row('fake', ONE, 1, 10, 1), day: '2026-11-18' },
  ],
  byMember: [
    { ...row('gateway', ONE, 3, 1_200_000, 120_000), actorId: ADA },
    { ...row('gateway', TWO, 1, 3, 0), actorId: ADA },
    { ...row('gateway', null, 2, 900, 90), actorId: ADA },
    { ...row('gateway', TWO, 3, 2_000_000, 500_000), actorId: BEA },
    { ...row('gateway', UNPRICED, 1, 5000, 500), actorId: BEA },
    { ...row('gateway', GONE, 1, 4000, 400), actorId: BEA },
    { ...row('fake', ONE, 1, 10, 1), actorId: BEA },
  ],
};

describe('a list price, exactly', () => {
  it('reads a per-token price as whole atto-dollars, decimals and exponents alike', () => {
    expect(parseUsdPerToken('0.0000025')).toBe(2_500_000_000_000n);
    expect(parseUsdPerToken('0.000015')).toBe(15_000_000_000_000n);
    expect(parseUsdPerToken('1.5e-7')).toBe(150_000_000_000n);
    expect(parseUsdPerToken('6E-7')).toBe(600_000_000_000n);
    expect(parseUsdPerToken(' 0.000000123456789 ')).toBe(123_456_789_000n);
    expect(parseUsdPerToken('0')).toBe(0n);
    expect(parseUsdPerToken('1')).toBe(1_000_000_000_000_000_000n);
    // Past 18 places it rounds half up to the atto-dollar.
    expect(parseUsdPerToken('0.0000000000000000015')).toBe(2n);
    expect(parseUsdPerToken('0.0000000000000000014')).toBe(1n);
  });

  it('refuses a price that is not a plain non-negative number up to a dollar a token', () => {
    for (const bad of [
      undefined,
      null,
      '',
      ' ',
      'abc',
      '-0.000001',
      '1.5',
      '2',
      'Infinity',
      'NaN',
      '0x10',
      '1e400',
      '1e-400',
      '.5',
      '5.',
      '1,5',
      '0.'.padEnd(80, '1'),
    ]) {
      expect(parseUsdPerToken(bad), String(bad)).toBeNull();
    }
  });

  it('writes a per-token price per million tokens as an exact decimal', () => {
    expect(usdPerMillionText(2_500_000_000_000n)).toBe('2.5');
    expect(usdPerMillionText(15_000_000_000_000n)).toBe('15');
    expect(usdPerMillionText(150_000_000_000n)).toBe('0.15');
    expect(usdPerMillionText(123_456_789_000n)).toBe('0.123456789');
    expect(usdPerMillionText(1n)).toBe('0.000000000001');
    expect(usdPerMillionText(0n)).toBe('0');
    expect(usdPerMillionText(1_000_000_000_000_000_000n)).toBe('1000000');
  });

  it('rounds atto-dollars to micro-dollars half up, and never a non-zero amount to zero', () => {
    expect(microUsdOf(0n)).toBe(0);
    expect(microUsdOf(1n)).toBe(1);
    expect(microUsdOf(499_999_999_999n)).toBe(1);
    expect(microUsdOf(500_000_000_000n)).toBe(1);
    expect(microUsdOf(1_499_999_999_999n)).toBe(1);
    expect(microUsdOf(1_500_000_000_000n)).toBe(2);
    expect(microUsdOf(4_000_000_000_000_000_000n)).toBe(4_000_000);
  });
});

describe('the catalogue’s list prices', () => {
  it('keeps the raw prices of the language models it lists, beside their names', () => {
    const prices = usagePriceList(catalogue);
    expect(prices?.get(ONE)).toEqual({
      label: 'Model One',
      input: 2_500_000_000_000n,
      output: 15_000_000_000_000n,
    });
    expect(prices?.get(TWO)).toMatchObject({ label: 'Model Two', input: 150_000_000_000n });
    // Listed without a price: named, not priced.
    expect(prices?.get(UNPRICED)).toEqual({ label: 'No Price', input: null, output: null });
    expect(prices?.has('vendor-a/embedder')).toBe(false);
    expect(usagePriceList({ status: 'unavailable' })).toBeUndefined();
  });

  it('prices nothing of a model with only one of its two prices readable', () => {
    const half = usagePriceList({
      status: 'ok',
      ...catalogueRead([{ id: ONE, name: 'One', pricing: { input: '0.000001', output: 'n/a' } }]),
    });
    expect(half?.get(ONE)).toEqual({ label: 'One', input: null, output: null });
  });
});

describe('priceAiUsage', () => {
  const cost = priceAiUsage(breakdown, DAYS, usagePriceList(catalogue));

  it('prices each model’s tokens exactly and sums them before rounding', () => {
    expect(aiUsageCostSchema.parse(cost)).toEqual(cost);
    expect(cost).toMatchObject({
      currency: 'USD',
      basis: AI_USAGE_COST_BASIS,
      priced: true,
      // One: 1.2M in × $2.50/M + 120k out × $15/M = $3 + $1.80 = $4.80.
      // Two: 2,000,003 in × $0.15/M + 500k out × $0.60/M = $0.30000045 + $0.30 = $0.60000045.
      // $5.40000045 in all: 5,400,000.45 µ$, rounded once.
      totalMicroUsd: 5_400_000,
      pricedTurns: 7,
      // No price (1), not listed (1), no model (2), the test engine (1).
      unpricedTurns: 5,
    });
    expect(cost.reason).toBeUndefined();
  });

  it('lists each model with its tokens, its label, its prices per million and its cost, costliest first', () => {
    expect(cost.models).toEqual([
      {
        model: ONE,
        engine: 'gateway',
        label: 'Model One',
        turns: 3,
        inputTokens: 1_200_000,
        outputTokens: 120_000,
        inputPricePerMillion: '2.5',
        outputPricePerMillion: '15',
        costMicroUsd: 4_800_000,
      },
      {
        model: TWO,
        engine: 'gateway',
        label: 'Model Two',
        turns: 4,
        inputTokens: 2_000_003,
        outputTokens: 500_000,
        inputPricePerMillion: '0.15',
        outputPricePerMillion: '0.6',
        // 600,000.45 µ$, rounded half up.
        costMicroUsd: 600_000,
      },
      {
        model: null,
        engine: 'gateway',
        label: null,
        turns: 2,
        inputTokens: 900,
        outputTokens: 90,
        inputPricePerMillion: null,
        outputPricePerMillion: null,
        costMicroUsd: null,
      },
      {
        model: ONE,
        engine: 'fake',
        label: null,
        turns: 1,
        inputTokens: 10,
        outputTokens: 1,
        inputPricePerMillion: null,
        outputPricePerMillion: null,
        costMicroUsd: null,
      },
      {
        model: UNPRICED,
        engine: 'gateway',
        label: 'No Price',
        turns: 1,
        inputTokens: 5000,
        outputTokens: 500,
        inputPricePerMillion: null,
        outputPricePerMillion: null,
        costMicroUsd: null,
      },
      {
        model: GONE,
        engine: 'gateway',
        label: null,
        turns: 1,
        inputTokens: 4000,
        outputTokens: 400,
        inputPricePerMillion: null,
        outputPricePerMillion: null,
        costMicroUsd: null,
      },
    ]);
  });

  it('gives every day of the series its cost and unpriced turns, a quiet day as zeros', () => {
    expect(cost.daily).toEqual([
      // One: $2.50 + $1.50; Two: 3 tokens × $0.15/M = 0.45 µ$, kept apart and not lost.
      { day: '2026-11-16', costMicroUsd: 4_000_000, unpricedTurns: 2 },
      { day: '2026-11-17', costMicroUsd: 0, unpricedTurns: 0 },
      // One: $0.50 + $0.30; Two: $0.30 + $0.30.
      { day: '2026-11-18', costMicroUsd: 1_400_000, unpricedTurns: 3 },
    ]);
  });

  it('gives each member their cost and unpriced turns, costliest first', () => {
    expect(cost.members).toEqual([
      // $4.80 + 0.45 µ$.
      { actorId: ADA, costMicroUsd: 4_800_000, unpricedTurns: 2 },
      { actorId: BEA, costMicroUsd: 600_000, unpricedTurns: 3 },
    ]);
  });

  it('keeps a tiny non-zero cost visible and sums many small rows without float drift', () => {
    const tiny = priceAiUsage(
      {
        byDay: [{ ...row('gateway', TWO, 1, 3, 0), day: '2026-11-18' }],
        byMember: [{ ...row('gateway', TWO, 1, 3, 0), actorId: ADA }],
      },
      ['2026-11-18'],
      usagePriceList(catalogue),
    );
    expect(tiny.totalMicroUsd).toBe(1);
    expect(tiny.models[0]?.costMicroUsd).toBe(1);

    // 0.1 + 0.2 in floats is 0.30000000000000004; here ten rows of 0.1 µ$ are exactly 1 µ$.
    const withTokens = priceAiUsage(
      {
        byDay: Array.from({ length: 10 }, (_, index) => ({
          ...row('gateway', `vendor-e/m${String(index)}`, 1, 1, 0),
          day: '2026-11-18',
        })),
        byMember: [],
      },
      ['2026-11-18'],
      new Map(
        Array.from({ length: 10 }, (_, index) => [
          `vendor-e/m${String(index)}`,
          // $0.0000001 a token: 0.1 µ$.
          { label: `M${String(index)}`, input: 100_000_000_000n, output: 0n },
        ]),
      ),
    );
    expect(withTokens.totalMicroUsd).toBe(1);
    expect(withTokens.daily).toEqual([{ day: '2026-11-18', costMicroUsd: 1, unpricedTurns: 0 }]);
  });

  it('prices big counts exactly', () => {
    const big = priceAiUsage(
      {
        byDay: [{ ...row('gateway', ONE, 1, 123_456_789, 0), day: '2026-11-18' }],
        byMember: [],
      },
      ['2026-11-18'],
      new Map([[ONE, { label: 'One', input: 123_456_789_000n, output: 0n }]]),
    );
    // 123,456,789 × $0.000000123456789 = $15.241578750190521.
    expect(big.totalMicroUsd).toBe(15_241_579);
  });

  it('says the catalogue could not be read, and counts every turn as unpriced', () => {
    const down = priceAiUsage(breakdown, DAYS, undefined);
    expect(aiUsageCostSchema.parse(down)).toEqual(down);
    expect(down).toEqual({
      currency: 'USD',
      basis: AI_USAGE_COST_BASIS,
      priced: false,
      reason: 'catalogue_unavailable',
      totalMicroUsd: 0,
      pricedTurns: 0,
      unpricedTurns: 12,
      models: [],
      daily: [],
      members: [],
    });
  });

  it('says no turn could be priced when every model is unknown, and prices an empty period at zero', () => {
    const none = priceAiUsage(
      {
        byDay: [{ ...row('gateway', null, 4, 100, 10), day: '2026-11-18' }],
        byMember: [{ ...row('gateway', null, 4, 100, 10), actorId: ADA }],
      },
      ['2026-11-18'],
      usagePriceList(catalogue),
    );
    expect(none).toMatchObject({
      priced: false,
      reason: 'no_priced_turns',
      totalMicroUsd: 0,
      pricedTurns: 0,
      unpricedTurns: 4,
    });
    expect(none.members).toEqual([{ actorId: ADA, costMicroUsd: 0, unpricedTurns: 4 }]);

    const empty = priceAiUsage({ byDay: [], byMember: [] }, DAYS, usagePriceList(catalogue));
    expect(empty).toMatchObject({
      priced: true,
      totalMicroUsd: 0,
      pricedTurns: 0,
      unpricedTurns: 0,
    });
    expect(empty.reason).toBeUndefined();
    expect(empty.daily.map((day) => day.costMicroUsd)).toEqual([0, 0, 0]);
    expect(empty.models).toEqual([]);
  });

  it('keeps at most 50 models, the costliest, and the totals over all of them', () => {
    const many = Array.from({ length: 55 }, (_, index) => `vendor-f/m${String(index)}`);
    const wide = priceAiUsage(
      {
        byDay: many.map((model, index) => ({
          ...row('gateway', model, 1, 1_000_000 * (index + 1), 0),
          day: '2026-11-18',
        })),
        byMember: [],
      },
      ['2026-11-18'],
      new Map(
        many.map((model) => [model, { label: model, input: 1_000_000_000_000n, output: 0n }]),
      ),
    );
    expect(wide.models).toHaveLength(50);
    expect(wide.models[0]?.model).toBe('vendor-f/m54');
    // $1 per million: 1 + 2 + … + 55 dollars.
    expect(wide.totalMicroUsd).toBe(1540 * 1_000_000);
    expect(wide.pricedTurns).toBe(55);
  });
});

// The route: GET …/ai/usage over a scripted usage store and catalogue.

const WORKSPACE = '10000000-0000-4000-8000-000000000c51';
const ACTOR = '20000000-0000-4000-8000-000000000c51';
const MEMBERSHIP = '30000000-0000-4000-8000-000000000c51';
const OWNER: StaffAccessSnapshot = {
  membershipId: MEMBERSHIP,
  status: 'active',
  roles: ['owner'],
  permissions: [],
};

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
  constructor(public access: StaffAccessSnapshot | undefined) {}
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

const settings: AiModelSettingsStore = {
  available: async () => true,
  get: async () => undefined,
  save: async () => ({ status: 'unavailable' }),
};

const series: AiUsageDay[] = DAYS.map((day) => ({
  day,
  turns: 0,
  failedTurns: 0,
  inputTokens: 0,
  outputTokens: 0,
}));

/** The usage the store answers: the counts and the breakdown above. */
const stored: AiUsageResult = {
  totals: { turns: 12, inputTokens: 3_209_913, outputTokens: 620_991 },
  members: [],
  models: [],
  daily: series,
  failures: [],
  tokens: breakdown,
};

let server: Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
  vi.useRealTimers();
});

async function start(
  options: {
    access?: StaffAccessSnapshot;
    catalogue?: AiModelCatalogue | 'none';
    usage?: AiUsageResult;
    enabled?: boolean;
  } = {},
) {
  const reads: string[] = [];
  const catalogueSource: AiModelCatalogue =
    options.catalogue === undefined || options.catalogue === 'none'
      ? {
          models: async (read = {}) => {
            reads.push(JSON.stringify(read));
            return catalogue;
          },
        }
      : options.catalogue;
  const usage: AiUsageStore = { usage: async () => options.usage ?? stored };
  const app = createApp({
    staff: {
      sessionVerifier: new TokenVerifier(),
      store: new MemoryStaffStore(options.access ?? OWNER),
      credentialStore: {
        createCredential: async () => {
          throw new Error('unused');
        },
        listCredentials: async () => [],
        revokeCredential: async () => ({ status: 'not_found' }),
      },
      leadStore: unusedLeadStore,
      reportStore: {
        sourceReport: async () => ({
          totals: { received: 0, submitted: 0, madeIt: 0 },
          rows: [],
          withSourceData: 0,
        }),
      },
      ai: {
        config: {
          enabled: options.enabled ?? true,
          apiKey: 'test-key-not-real',
          signingKey: 'test-key-not-real',
          modelId: ONE,
          workspaceIds: new Set([WORKSPACE]),
        },
        siteContext: {
          siteContext: async () => ({
            siteId: WORKSPACE,
            slug: 'getcanadasim',
            name: 'Get Canada Sim',
            leadTypes: ['sim_order'],
          }),
        },
        reads: {
          overview: async () => ({ received: 0, submitted: 0, byStage: [] }),
          findLeads: async () => ({ rows: [], total: 0 }),
          leadSummary: async () => undefined,
          openTasks: async () => ({ rows: [], total: 0 }),
          isActiveMember: async () => true,
          leadHint: async () => undefined,
        },
        engine: createFakeEngine([{ chunks: ['Fine.'] }]),
        rateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
        chat: { schema: fixedAiChatSchema(), usage },
        models: {
          settings,
          ...(options.catalogue === 'none' ? {} : { catalogue: catalogueSource }),
        },
      },
    },
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server?.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected TCP server');
  const url = `http://127.0.0.1:${String(address.port)}/api/v1/staff/workspaces/${WORKSPACE}/ai/usage?period=7`;
  return {
    reads,
    get: () => fetch(url, { headers: { authorization: 'Bearer token' } }),
  };
}

describe('GET /workspaces/:id/ai/usage, the cost', () => {
  it('prices the period at the catalogue’s cached list prices, beside the counts', async () => {
    const harness = await start();
    const response = await harness.get();
    expect(response.status).toBe(200);
    const raw: unknown = await response.json();
    const body = aiUsageResponseSchema.parse(raw);
    expect(body.cost).toEqual(priceAiUsage(breakdown, DAYS, usagePriceList(catalogue)));
    expect(body.cost?.totalMicroUsd).toBe(5_400_000);
    expect(body.totals).toEqual(stored.totals);
    // The breakdown is the cost's input, never sent; the cached catalogue is read, not a fresh one.
    expect(raw).not.toHaveProperty('tokens');
    expect(harness.reads).toEqual(['{}']);
    expect(JSON.stringify(raw)).not.toContain('test-key-not-real');
  });

  it('answers the usage without a cost when the catalogue cannot be read', async () => {
    const harness = await start({ catalogue: { models: async () => ({ status: 'unavailable' }) } });
    const response = await harness.get();
    expect(response.status).toBe(200);
    const body = aiUsageResponseSchema.parse(await response.json());
    expect(body.totals.turns).toBe(12);
    expect(body.cost).toMatchObject({
      priced: false,
      reason: 'catalogue_unavailable',
      totalMicroUsd: 0,
      unpricedTurns: 12,
      models: [],
    });
  });

  it('answers without prices when the catalogue throws, and with no Gateway key or Ask AI off', async () => {
    for (const options of [
      {
        catalogue: {
          models: () => Promise.reject(new Error('gateway https://example.invalid down')),
        },
      },
      { catalogue: 'none' as const },
      { enabled: false },
    ]) {
      const harness = await start(options);
      const response = await harness.get();
      expect(response.status).toBe(200);
      const raw = await response.text();
      expect(raw).not.toContain('example.invalid');
      expect(aiUsageResponseSchema.parse(JSON.parse(raw)).cost?.reason).toBe(
        'catalogue_unavailable',
      );
      if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });

  it('does not wait on a catalogue that does not answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const harness = await start({ catalogue: { models: () => new Promise(() => undefined) } });
    const pending = harness.get();
    await vi.waitFor(() => vi.getTimerCount() > 0 || Promise.reject(new Error('no timer yet')));
    await vi.advanceTimersByTimeAsync(AI_USAGE_CATALOGUE_WAIT_MS);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(aiUsageResponseSchema.parse(await response.json()).cost?.reason).toBe(
      'catalogue_unavailable',
    );
  });

  it('sends no cost from a store that does not break tokens down', async () => {
    const { tokens: _tokens, ...older } = stored;
    const harness = await start({ usage: older });
    const response = await harness.get();
    expect(response.status).toBe(200);
    const body = aiUsageResponseSchema.parse(await response.json());
    expect(body).not.toHaveProperty('cost');
    expect(body.totals).toEqual(stored.totals);
  });

  it('refuses everyone but the owner, without reading the catalogue', async () => {
    for (const roles of [['leads'], ['finance'], ['viewer']] as const) {
      const harness = await start({ access: { ...OWNER, roles: [...roles] } });
      const response = await harness.get();
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).not.toContain('totalMicroUsd');
      expect(text).not.toContain('PricePerMillion');
      expect(harness.reads).toEqual([]);
      if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });
});
