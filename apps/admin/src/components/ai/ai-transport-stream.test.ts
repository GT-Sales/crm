import { describe, expect, it, vi } from 'vitest';
import type { AiStreamPart } from '@gt-sales/contracts';

/**
 * `streamAnswer` decides how a turn ended, which is what the panel shows. The
 * SDK is mocked at the one seam the transport uses (`askAiAssistant`), because
 * the point of these cases is the end-of-stream logic, not the HTTP client
 * (that has its own tests in `@gt-sales/contracts`).
 */

const stream = vi.hoisted(() => {
  const state: { parts: AiStreamPart[]; fail?: Error } = { parts: [] };
  return state;
});

vi.mock('../../lib/api', () => ({
  BackendError: class BackendError extends Error {
    readonly code: string;
    readonly status = 500;
    readonly requestId = '00000000-0000-4000-8000-000000000002';
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
  askAiAssistant: async function* askAiAssistant() {
    for (const part of stream.parts) yield part;
    if (stream.fail) throw stream.fail;
  },
}));

const { streamAnswer } = await import('../../lib/ai-transport');

const REQUEST = {
  requestId: '00000000-0000-4000-8000-000000000001',
  message: 'How many orders?',
  history: [],
};

describe('streamAnswer', () => {
  it('returns undefined only when the server said done', async () => {
    stream.parts = [
      { type: 'progress', label: 'Checking lead counts' },
      { type: 'text', text: 'Twelve.' },
      { type: 'done' },
    ];
    stream.fail = undefined;
    const seen: AiStreamPart[] = [];
    const result = await streamAnswer({
      accessToken: 'token',
      workspaceId: '10000000-0000-4000-8000-000000000001',
      request: REQUEST,
      onPart: (part) => seen.push(part),
    });
    expect(result).toBeUndefined();
    expect(seen.map((part) => part.type)).toEqual(['progress', 'text', 'done']);
  });

  it('treats a stream that stops without done as failed, never as a complete answer', async () => {
    stream.parts = [{ type: 'text', text: 'Twelve' }];
    stream.fail = undefined;
    const result = await streamAnswer({
      accessToken: 'token',
      workspaceId: '10000000-0000-4000-8000-000000000001',
      request: REQUEST,
      onPart: () => {},
    });
    expect(result).toBe('failed');
  });

  it('maps a typed error part and stops reading', async () => {
    stream.parts = [
      { type: 'text', text: 'Partial' },
      { type: 'error', code: 'access_lost', message: 'Access changed.' },
      { type: 'text', text: 'must not arrive' },
    ];
    stream.fail = undefined;
    const seen: AiStreamPart[] = [];
    const result = await streamAnswer({
      accessToken: 'token',
      workspaceId: '10000000-0000-4000-8000-000000000001',
      request: REQUEST,
      onPart: (part) => seen.push(part),
    });
    expect(result).toBe('denied');
    expect(seen.map((part) => part.type)).toEqual(['text', 'error']);
  });

  it('reports a cancelled signal as cancelled, not failed', async () => {
    stream.parts = [{ type: 'text', text: 'Twelve' }];
    stream.fail = undefined;
    const controller = new AbortController();
    controller.abort();
    const result = await streamAnswer({
      accessToken: 'token',
      workspaceId: '10000000-0000-4000-8000-000000000001',
      request: REQUEST,
      signal: controller.signal,
      onPart: () => {},
    });
    expect(result).toBe('cancelled');
  });
});
