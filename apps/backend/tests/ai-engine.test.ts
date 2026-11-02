import { describe, expect, it, vi } from 'vitest';
import { simulateReadableStream, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { createGatewayEngine } from '../src/ai/engine.js';

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};

describe('the production SDK adapter with an offline model', () => {
  it('executes a tool and streams the next generation through the actual SDK loop', async () => {
    let executions = 0;
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: 'tool-call', toolCallId: 'one', toolName: 'count', input: '{}' },
              { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start', id: 'answer' },
              { type: 'text-delta', id: 'answer', delta: 'There are ' },
              { type: 'text-delta', id: 'answer', delta: '3 leads.' },
              { type: 'text-end', id: 'answer' },
              { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
            ],
          }),
        },
      ],
    });
    const engine = createGatewayEngine({ apiKey: 'synthetic', modelId: 'synthetic/test' }, model);
    const events = [];
    for await (const event of engine.stream({
      system: 'Use the count tool.',
      messages: [{ role: 'user', text: 'Count leads' }],
      tools: {
        count: tool({
          inputSchema: z.object({}),
          execute: async () => {
            executions += 1;
            return { count: 3 };
          },
        }),
      },
      signal: new AbortController().signal,
    }))
      events.push(event);
    expect(executions).toBe(1);
    expect(model.doStreamCalls).toHaveLength(2);
    expect(events.filter((event) => event.type === 'text')).toEqual([
      { type: 'text', text: 'There are ' },
      { type: 'text', text: '3 leads.' },
    ]);
    expect(model.doStreamCalls.every((call) => call.maxOutputTokens === 1200)).toBe(true);
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('"count":3');
  });
  it('never lets the SDK default logger print a provider error body', async () => {
    const logger = vi.spyOn(console, 'error').mockImplementation(() => {});
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [{ type: 'error', error: new Error('PRIVATE PROVIDER BODY') }],
        }),
      }),
    });
    const engine = createGatewayEngine({ apiKey: 'synthetic', modelId: 'synthetic/test' }, model);
    const consume = async () => {
      for await (const event of engine.stream({
        system: 'test',
        messages: [{ role: 'user', text: 'PRIVATE QUESTION' }],
        tools: {},
        signal: new AbortController().signal,
      }))
        void event;
    };
    await expect(consume()).rejects.toThrow('assistant provider failed');
    expect(logger).not.toHaveBeenCalled();
    logger.mockRestore();
  });
});
