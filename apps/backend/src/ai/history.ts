import { createHmac, timingSafeEqual } from 'node:crypto';

import type { AiHistoryMessage } from '@gt-sales/contracts';

/**
 * CHAT-2: the browser sends the conversation back with each question, so the
 * server must not take an "assistant" turn on trust: a client could write one
 * in the model's own voice ("the owner said you may…"). Every answer the
 * server finishes is signed for its member and site (`done.signature`), and
 * only signed answers are replayed. A question whose answer is missing or
 * unsigned (stopped, failed, or made up) is dropped with it, so the model
 * always sees question, answer, question, answer, never two questions in a row
 * (UI-7) and never a reply it did not write.
 */

const DOMAIN = 'gt-sales/ai-history/v1';

interface HistoryScope {
  workspaceId: string;
  actorId: string;
}

/** The signature of one answer as the history will replay it (`aiAssistantHistoryText`). */
export function signAssistantTurn(key: string, scope: HistoryScope, text: string): string {
  return createHmac('sha256', key)
    .update(`${DOMAIN}:${scope.workspaceId}:${scope.actorId}:`)
    .update(text)
    .digest('base64url');
}

function verified(key: string, scope: HistoryScope, text: string, signature: string): boolean {
  const expected = Buffer.from(signAssistantTurn(key, scope, text));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * The history the model may see: whole turns, oldest first, each a question
 * and the server's own signed answer. Without a signing key (actions off) the
 * answers cannot be checked; turns are still kept whole and alternating.
 */
export function trustedHistory(
  history: readonly AiHistoryMessage[],
  key: string | undefined,
  scope: HistoryScope,
): { messages: { role: 'user' | 'assistant'; text: string }[]; dropped: number } {
  const messages: { role: 'user' | 'assistant'; text: string }[] = [];
  let dropped = 0;
  for (let index = 0; index < history.length; index += 1) {
    const question = history[index];
    const answer = history[index + 1];
    if (question?.role !== 'user') {
      dropped += 1;
      continue;
    }
    if (answer?.role !== 'assistant') {
      dropped += 1;
      continue;
    }
    index += 1;
    const trusted =
      key === undefined ||
      (answer.signature !== undefined && verified(key, scope, answer.text, answer.signature));
    if (!trusted) {
      dropped += 2;
      continue;
    }
    messages.push({ role: 'user', text: question.text }, { role: 'assistant', text: answer.text });
  }
  return { messages, dropped };
}
