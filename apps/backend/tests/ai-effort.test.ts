import { describe, expect, it, vi } from 'vitest';
import { APICallError, simulateReadableStream, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { AI_ASSISTANT_LIMITS } from '@gt-sales/contracts';

import {
  createFakeEngine,
  createGatewayEngine,
  outputTokenLimit,
  type EngineEvent,
  type EngineInput,
} from '../src/ai/engine.js';
import { TurnBudget, turnLimits } from '../src/ai/limits.js';

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 6, reasoning: 4 },
};

/** A provider stream part, as the offline model takes it. */
type Chunk =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer T>
    ? T
    : never;

function answer(chunks: readonly Chunk[]) {
  return {
    stream: simulateReadableStream<Chunk>({
      chunks: [
        ...chunks,
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
      ],
    }),
  };
}

const SECRET = 'PRIVATE REASONING ABOUT ADA LOVELACE';

/** A generation that reasons (in two deltas) before it answers. */
function reasoningThenText(text: string): Chunk[] {
  return [
    { type: 'reasoning-start', id: 'r' },
    { type: 'reasoning-delta', id: 'r', delta: `${SECRET} part one` },
    { type: 'reasoning-delta', id: 'r', delta: `${SECRET} part two` },
    { type: 'reasoning-end', id: 'r' },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: text },
    { type: 'text-end', id: 't' },
  ];
}

function input(overrides: Partial<EngineInput> = {}): EngineInput {
  return {
    system: 's',
    messages: [{ role: 'user', text: 'Why did orders drop?' }],
    tools: {},
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function collect(stream: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('the turn limits at each effort level', () => {
  it('keeps Normal exactly at the limits it always had', () => {
    expect(turnLimits()).toEqual({
      modelSteps: 5,
      toolCalls: 6,
      leadSummaries: 3,
      outputTokens: 1_200,
      timeoutMs: 60_000,
    });
    expect(turnLimits('normal')).toEqual(turnLimits());
  });

  it('gives High its own budgets and the same data limits', () => {
    expect(turnLimits('high')).toEqual({
      modelSteps: 8,
      toolCalls: 10,
      leadSummaries: 5,
      outputTokens: 4_000,
      timeoutMs: 180_000,
    });
  });

  it('lets a High turn make 10 tool calls and read 5 summaries, a Normal one 6 and 3', () => {
    const reserve = (budget: TurnBudget, what: 'reserveToolCall' | 'reserveLeadSummary') => {
      let granted = 0;
      while (budget[what]()) granted += 1;
      return granted;
    };
    expect(reserve(new TurnBudget(), 'reserveToolCall')).toBe(6);
    expect(reserve(new TurnBudget('normal'), 'reserveLeadSummary')).toBe(3);
    expect(reserve(new TurnBudget('high'), 'reserveToolCall')).toBe(10);
    expect(reserve(new TurnBudget('high'), 'reserveLeadSummary')).toBe(5);
    // Records and bytes: the same ceilings at both levels.
    for (const budget of [new TurnBudget(), new TurnBudget('high')]) {
      expect(budget.remainingRecords).toBe(AI_ASSISTANT_LIMITS.maxRecordsPerTurn);
      expect(budget.remainingBytes).toBe(AI_ASSISTANT_LIMITS.maxToolResultBytes);
      expect(
        budget.acceptResult({ bytes: AI_ASSISTANT_LIMITS.maxToolResultBytes + 1, records: 1 })
          .rejected,
      ).toBe(true);
    }
  });

  it('sizes the output limit: Normal unchanged, High’s answer kept clear of its reasoning', () => {
    expect(outputTokenLimit({})).toBe(1_200);
    expect(outputTokenLimit({ automationAuthoring: true })).toBe(4_800);
    expect(outputTokenLimit({ effort: 'normal', reasoning: true })).toBe(1_200);
    expect(outputTokenLimit({ effort: 'high' })).toBe(4_000);
    // Authoring keeps its larger limit at High.
    expect(outputTokenLimit({ effort: 'high', automationAuthoring: true })).toBe(4_800);
    expect(outputTokenLimit({ effort: 'high', reasoning: true })).toBe(12_000);
    expect(outputTokenLimit({ effort: 'high', automationAuthoring: true, reasoning: true })).toBe(
      12_800,
    );
  });
});

describe('the gateway engine at High effort', () => {
  const high = { modelId: 'synthetic/thinker', reasoning: 'medium' as const };

  it('sends a Normal turn exactly as before, even when High is configured', async () => {
    const plain = new MockLanguageModelV4({ doStream: [answer(reasoningThenText('ok'))] });
    const withHigh = new MockLanguageModelV4({ doStream: [answer(reasoningThenText('ok'))] });
    await collect(
      createGatewayEngine({ apiKey: 'k', modelId: 'synthetic/test' }, plain).stream(input()),
    );
    await collect(
      createGatewayEngine(
        { apiKey: 'k', modelId: 'synthetic/test', highEffort: high },
        withHigh,
      ).stream(input()),
    );
    const call = (model: MockLanguageModelV4) => {
      const first = model.doStreamCalls[0];
      if (!first) throw new Error('no model call');
      const { abortSignal: _signal, ...rest } = first;
      return rest;
    };
    expect(call(withHigh)).toEqual(call(plain));
    expect(call(plain).maxOutputTokens).toBe(1_200);
    expect(call(plain).reasoning).toBeUndefined();
  });

  it('asks a High turn to reason at the configured word, with room for it, and nothing else new', async () => {
    const model = new MockLanguageModelV4({ doStream: [answer(reasoningThenText('ok'))] });
    await collect(
      createGatewayEngine(
        { apiKey: 'k', modelId: 'synthetic/test', providers: ['baseten'], highEffort: high },
        model,
      ).stream(input({ effort: 'high' })),
    );
    const call = model.doStreamCalls[0];
    expect(call?.reasoning).toBe('medium');
    expect(call?.maxOutputTokens).toBe(12_000);
    // The Gateway host pin applies to both levels.
    expect(call?.providerOptions).toEqual({ gateway: { only: ['baseten'], order: ['baseten'] } });
  });

  it('sends no reasoning option at High when none is configured: bigger budgets only', async () => {
    const model = new MockLanguageModelV4({ doStream: [answer(reasoningThenText('ok'))] });
    await collect(
      createGatewayEngine(
        { apiKey: 'k', modelId: 'synthetic/test', highEffort: { modelId: 'synthetic/test' } },
        model,
      ).stream(input({ effort: 'high' })),
    );
    expect(model.doStreamCalls[0]?.reasoning).toBeUndefined();
    expect(model.doStreamCalls[0]?.maxOutputTokens).toBe(4_000);
  });

  it('stops a High turn at eight generations, a Normal one at five', async () => {
    const looping = () =>
      new MockLanguageModelV4({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              {
                type: 'tool-call',
                toolCallId: crypto.randomUUID(),
                toolName: 'getSiteOverview',
                input: '{}',
              },
              { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
            ],
          }),
        }),
      });
    const tools = {
      getSiteOverview: tool({ inputSchema: z.object({}), execute: async () => 'ok' }),
    };
    for (const [effort, steps] of [
      [undefined, 5],
      ['high', 8],
    ] as const) {
      const model = looping();
      await expect(
        collect(
          createGatewayEngine(
            { apiKey: 'k', modelId: 'synthetic/test', highEffort: high },
            model,
          ).stream(input({ tools, ...(effort ? { effort } : {}) })),
        ),
      ).rejects.toThrow('assistant provider failed');
      expect(model.doStreamCalls).toHaveLength(steps);
    }
  });

  it('says once per step that the model is reasoning, and never yields its text', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              ...reasoningThenText('').slice(0, 4),
              { type: 'tool-call', toolCallId: 'one', toolName: 'getSiteOverview', input: '{}' },
              { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
            ],
          }),
        },
        answer(reasoningThenText('Orders dropped because the plan changed.')),
      ],
    });
    const events = await collect(
      createGatewayEngine(
        { apiKey: 'k', modelId: 'synthetic/test', highEffort: high },
        model,
      ).stream(
        input({
          effort: 'high',
          tools: {
            getSiteOverview: tool({ inputSchema: z.object({}), execute: async () => 'ok' }),
          },
        }),
      ),
    );
    expect(events.filter((event) => event.type === 'reasoning')).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(events.filter((event) => event.type === 'text')).toEqual([
      { type: 'text', text: 'Orders dropped because the plan changed.' },
    ]);
    // Reasoning tokens arrive inside the output count (`outputTokens.total`).
    expect(events.at(-1)).toEqual({ type: 'finish', inputTokens: 6, outputTokens: 20 });
  });

  it('turns a provider that refuses the reasoning option into a typed failure, never a broken stream', async () => {
    const logger = vi.spyOn(console, 'error').mockImplementation(() => {});
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new APICallError({
          message: 'reasoning is not supported for this model',
          url: 'https://gateway.invalid',
          requestBodyValues: {},
          statusCode: 400,
          isRetryable: false,
        });
      },
    });
    await expect(
      collect(
        createGatewayEngine(
          { apiKey: 'k', modelId: 'synthetic/test', highEffort: high },
          model,
        ).stream(input({ effort: 'high' })),
      ),
    ).rejects.toMatchObject({ name: 'AssistantProviderError', code: 'provider_unavailable' });
    expect(logger).not.toHaveBeenCalled();
    logger.mockRestore();
  });
});

describe('the fake engine’s scripted reasoning', () => {
  it('yields one reasoning event per scripted step before the answer', async () => {
    const engine = createFakeEngine([{ reasoningSteps: 2, chunks: ['Done.'] }]);
    expect((await collect(engine.stream(input({ effort: 'high' })))).map((e) => e.type)).toEqual([
      'reasoning',
      'reasoning',
      'text',
      'finish',
    ]);
  });
});
