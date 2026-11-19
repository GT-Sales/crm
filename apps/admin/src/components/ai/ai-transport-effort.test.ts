import { describe, expect, it, vi } from 'vitest';
import { aiChatRequestSchema } from '@gt-sales/contracts';

/**
 * Effort levels on the wire: the request names `effort` only for High, and
 * only where the site offers it, so a Normal request is byte for byte what it
 * was and an older backend (whose strict request does not know the key) never
 * receives it. The two High refusals map to their own words.
 */

const refusal = vi.hoisted((): { error: Error | undefined } => ({ error: undefined }));

vi.mock('../../lib/api', () => ({
  BackendError: class BackendError extends Error {
    readonly code: string;
    readonly status: number;
    readonly requestId: string;
    readonly details?: Record<string, unknown>;
    constructor(
      code: string,
      status = 400,
      requestId = 'req-00000000',
      details?: Record<string, unknown>,
    ) {
      super(code);
      this.code = code;
      this.status = status;
      this.requestId = requestId;
      this.details = details;
    }
  },
  // eslint-disable-next-line require-yield
  askAiAssistant: async function* askAiAssistant() {
    if (refusal.error) throw refusal.error;
  },
}));

const { BackendError } = await import('../../lib/api');
const { buildAiChatRequest, streamAnswer } = await import('../../lib/ai-transport');

const REQUEST_ID = '00000000-0000-4000-8000-000000000001';
const CONVERSATION_ID = '00000000-0000-4000-8000-0000000000c1';
const LIMITS = { maxMessageChars: 100, maxHistoryMessages: 12, maxConversationChars: 1_000 };
const base = {
  message: 'Why did orders drop?',
  history: [
    { role: 'user' as const, text: 'Hello' },
    { role: 'assistant' as const, text: 'Hi' },
  ],
  limits: LIMITS,
  requestId: REQUEST_ID,
};

describe('buildAiChatRequest and the effort level', () => {
  it('sends effort only as high, only when chosen and offered', () => {
    const plain = buildAiChatRequest(base).request;
    for (const extra of [
      { effort: 'normal' as const },
      { effort: 'normal' as const, efforts: ['normal', 'high'] as const },
      // High chosen, but this backend offers nothing (older, or High off).
      { effort: 'high' as const },
      { effort: 'high' as const, efforts: [] },
      { effort: 'high' as const, efforts: ['normal'] as const },
    ]) {
      const { request } = buildAiChatRequest({ ...base, ...extra });
      expect(request, JSON.stringify(extra)).toEqual(plain);
      expect(JSON.stringify(request)).toBe(JSON.stringify(plain));
      expect(request).not.toHaveProperty('effort');
    }
    const high = buildAiChatRequest({ ...base, effort: 'high', efforts: ['normal', 'high'] });
    expect(high.request).toEqual({ ...plain, effort: 'high' });
    expect(aiChatRequestSchema.parse(high.request).effort).toBe('high');
  });

  it('carries High on a stored conversation too', () => {
    const { request } = buildAiChatRequest({
      ...base,
      conversationId: CONVERSATION_ID,
      effort: 'high',
      efforts: ['normal', 'high'],
    });
    expect(request).toMatchObject({ conversationId: CONVERSATION_ID, history: [], effort: 'high' });
    expect(
      buildAiChatRequest({ ...base, conversationId: CONVERSATION_ID, effort: 'high' }).request,
    ).not.toHaveProperty('effort');
  });
});

describe('streamAnswer and the High refusals', () => {
  const ask = (onRetryAfter?: (seconds: number) => void) =>
    streamAnswer({
      accessToken: 'token',
      workspaceId: '10000000-0000-4000-8000-000000000001',
      request: { requestId: REQUEST_ID, message: 'Why?', history: [], effort: 'high' },
      onPart: () => undefined,
      ...(onRetryAfter ? { onRetryAfter } : {}),
    });

  it('names High’s own rate limit and hands on its wait', async () => {
    refusal.error = new BackendError('ai_rate_limited', 429, 'req-1', {
      reason: 'high_effort',
      retryAfterSeconds: 1_500,
    });
    const waits: number[] = [];
    expect(await ask((seconds) => waits.push(seconds))).toBe('high_effort_limited');
    expect(waits).toEqual([1_500]);
  });

  it('keeps the general rate limit for every other refusal', async () => {
    refusal.error = new BackendError('ai_rate_limited', 429, 'req-1');
    expect(await ask()).toBe('rate_limited');
    refusal.error = new BackendError('ai_rate_limited', 429, 'req-1', { reason: 'something_else' });
    expect(await ask()).toBe('rate_limited');
  });

  it('names a site that stopped offering High, and nothing else that is invalid', async () => {
    refusal.error = new BackendError('invalid_request', 400, 'req-1', {
      reason: 'effort_unavailable',
    });
    expect(await ask()).toBe('effort_unavailable');
    refusal.error = new BackendError('invalid_request', 400, 'req-1');
    expect(await ask()).toBe('failed');
  });
});

describe('buildAiChatRequest and the card kinds the admin shows (T12)', () => {
  it('says it shows every card kind only when told, on both kinds of request', () => {
    const plain = buildAiChatRequest(base).request;
    expect(plain).not.toHaveProperty('wide');
    expect(buildAiChatRequest({ ...base, wide: false }).request).toEqual(plain);
    const wide = buildAiChatRequest({ ...base, wide: true }).request;
    expect(wide).toEqual({ ...plain, wide: true });
    expect(aiChatRequestSchema.parse(wide).wide).toBe(true);
    const stored = buildAiChatRequest({ ...base, conversationId: CONVERSATION_ID, wide: true });
    expect(stored.request).toMatchObject({ conversationId: CONVERSATION_ID, wide: true });
    expect(aiChatRequestSchema.safeParse(stored.request).success).toBe(true);
  });
});
