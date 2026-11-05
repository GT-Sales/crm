import { describe, expect, it } from 'vitest';

import {
  buildAiChatRequest,
  uiErrorForBackendCode,
  uiErrorForStreamCode,
  type AiHistoryEntry,
} from '../../lib/ai-transport';

const REQUEST_ID = '00000000-0000-4000-8000-000000000001';
const LEAD_ID = '90000000-0000-4000-8000-000000000001';

const LIMITS = { maxMessageChars: 100, maxHistoryMessages: 12, maxConversationChars: 1_000 };

function turn(index: number): AiHistoryEntry[] {
  return [
    { role: 'user', text: `question ${index}` },
    { role: 'assistant', text: `answer ${index}` },
  ];
}

describe('buildAiChatRequest', () => {
  it('keeps the newest whole turns and reports the trim', () => {
    const history = [...turn(1), ...turn(2), ...turn(3)];
    const { request, trimmed } = buildAiChatRequest({
      message: 'What next?',
      history,
      limits: { ...LIMITS, maxHistoryMessages: 4 },
      requestId: REQUEST_ID,
    });

    expect(trimmed).toBe(true);
    expect(request.history).toEqual([...turn(2), ...turn(3)]);
    expect(request.message).toBe('What next?');
    expect(request.history.length).toBeLessThanOrEqual(4);
  });

  it('drops a whole turn rather than half of one when the character budget is short', () => {
    const history: AiHistoryEntry[] = [
      { role: 'user', text: 'o' },
      { role: 'assistant', text: 'o' },
      { role: 'user', text: '12345' },
      { role: 'assistant', text: '123456' },
    ];
    const { request, trimmed } = buildAiChatRequest({
      message: 'q',
      history,
      limits: { ...LIMITS, maxConversationChars: 11 },
      requestId: REQUEST_ID,
    });

    expect(trimmed).toBe(true);
    // The newest turn is 11 characters and the question is 1, so no part of it
    // fits; dropping only its answer would leave half a turn and a gap.
    expect(request.history).toEqual([]);
  });

  it('reports a question shortened to the message limit', () => {
    const { request, trimmed } = buildAiChatRequest({
      message: 'x'.repeat(120),
      history: [],
      limits: { ...LIMITS, maxMessageChars: 10 },
      requestId: REQUEST_ID,
    });

    expect(trimmed).toBe(true);
    expect(request.message).toBe('x'.repeat(10));
  });

  it('sends the open lead as context only when it is a uuid', () => {
    const base = {
      message: 'How is this lead?',
      history: [],
      limits: LIMITS,
      requestId: REQUEST_ID,
    };
    expect(buildAiChatRequest({ ...base, leadId: LEAD_ID }).request.context).toEqual({
      leadId: LEAD_ID,
    });
    expect(buildAiChatRequest({ ...base, leadId: 'not-a-uuid' }).request).not.toHaveProperty(
      'context',
    );
  });

  it('does not flag an untouched conversation as trimmed', () => {
    const { request, trimmed } = buildAiChatRequest({
      message: 'What is due?',
      history: turn(1),
      limits: LIMITS,
      requestId: REQUEST_ID,
    });
    expect(trimmed).toBe(false);
    expect(request.history).toEqual(turn(1));
  });
});

describe('UI error mapping', () => {
  it('maps the contract codes the panel can explain', () => {
    expect(uiErrorForBackendCode('ai_unavailable')).toBe('unavailable');
    expect(uiErrorForBackendCode('ai_rate_limited')).toBe('rate_limited');
    expect(uiErrorForBackendCode('invalid_session')).toBe('session_expired');
    expect(uiErrorForBackendCode('permission_denied')).toBe('denied');
    expect(uiErrorForBackendCode('internal_error')).toBe('failed');
    expect(uiErrorForStreamCode('cancelled')).toBe('cancelled');
    expect(uiErrorForStreamCode('provider_unavailable')).toBe('unavailable');
    // UI-10: a timeout and an over-budget turn get their own advice.
    expect(uiErrorForStreamCode('timeout')).toBe('timeout');
    expect(uiErrorForStreamCode('budget_exceeded')).toBe('too_long');
  });
});
