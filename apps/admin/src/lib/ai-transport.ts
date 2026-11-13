import {
  AI_ASSISTANT_LIMITS,
  type AiCapabilitiesResponse,
  type AiChatRequest,
  type AiStreamPart,
} from '@gt-sales/contracts';

import { BackendError, askAiAssistant } from './api';
import { errorKind } from './error-text';

/**
 * Ask AI's transport: the small, typed seam between the assistant's local
 * conversation and the contracts client. It builds the one request the
 * backend accepts (trimming the oldest whole turns until it fits), and turns
 * every way an answer can fail into the handful of states the panel knows how
 * to explain. Nothing here reads storage or holds a provider detail.
 */

/** Why an answer did not arrive, in the terms the panel can show. */
export type AiUiError =
  | 'unavailable'
  | 'session_expired'
  | 'denied'
  | 'rate_limited'
  | 'failed'
  /** The CRM could not be reached: no connection, a timeout before the answer started, an edge 502–504. */
  | 'offline'
  | 'cancelled'
  | 'timeout'
  | 'too_long';

/** One earlier turn as text only: the model never receives stored tool data. */
export interface AiHistoryEntry {
  role: 'user' | 'assistant';
  text: string;
  /** An answer's signature from its `done` part (CHAT-2); the server replays only signed answers. */
  signature?: string;
}

/** The capability limits the composer and the request builder must obey. */
export type AiRequestLimits = AiCapabilitiesResponse['limits'];

export interface BuildChatRequestInput {
  /** The new question, already trimmed by the caller. */
  message: string;
  /** The conversation before this question, oldest first. */
  history: readonly AiHistoryEntry[];
  limits: AiRequestLimits;
  requestId: string;
  /** The lead whose record is open, when the question is about that lead. */
  leadId?: string;
}

export interface BuiltChatRequest {
  request: AiChatRequest;
  /** Whether anything was dropped or shortened to fit the server's limits. */
  trimmed: boolean;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** UTF-8 bytes, counted without TextEncoder so the limit holds in every runtime. */
function utf8Length(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // A surrogate pair is one code point: four bytes, two UTF-16 units.
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Groups history into turns so the request never starts with half a turn: a
 * user message opens a turn and the assistant message that follows belongs to
 * it. A leading assistant message (which the admin never makes) is a turn of
 * its own.
 */
function groupTurns(history: readonly AiHistoryEntry[]): AiHistoryEntry[][] {
  const turns: AiHistoryEntry[][] = [];
  for (const entry of history) {
    const last = turns[turns.length - 1];
    if (entry.role === 'user' || last === undefined) {
      turns.push([entry]);
      continue;
    }
    last.push(entry);
  }
  return turns;
}

function clipped(entry: AiHistoryEntry, maxChars: number): AiHistoryEntry {
  // A shortened answer no longer matches its signature, so it travels without one.
  return Array.from(entry.text).length <= maxChars
    ? entry
    : { role: entry.role, text: Array.from(entry.text).slice(0, maxChars).join('') };
}

/**
 * Builds the one request body the backend accepts. History is a suffix of the
 * conversation, so the oldest whole turns go first until the message count and
 * the conversation's character budget fit; a single over-long history text is
 * shortened too. `trimmed` reports that the server will see less than the
 * admin has in memory.
 */
export function buildAiChatRequest(input: BuildChatRequestInput): BuiltChatRequest {
  const maxMessageChars = Math.min(
    input.limits.maxMessageChars,
    AI_ASSISTANT_LIMITS.maxMessageChars,
  );
  const message =
    Array.from(input.message).length <= maxMessageChars
      ? input.message
      : Array.from(input.message).slice(0, maxMessageChars).join('');
  let trimmed = message.length !== input.message.length;

  const history: AiHistoryEntry[] = [];
  for (const entry of input.history) {
    const next = clipped(entry, maxMessageChars);
    if (next !== entry) trimmed = true;
    if (next.text.length > 0) history.push(next);
  }

  const turns = groupTurns(history);
  const kept: AiHistoryEntry[][] = [];
  let keptMessages = 0;
  let keptChars = Array.from(message).length;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn === undefined) continue;
    const turnChars = turn.reduce((total, entry) => total + Array.from(entry.text).length, 0);
    if (keptMessages + turn.length > input.limits.maxHistoryMessages) break;
    if (keptChars + turnChars > input.limits.maxConversationChars) break;
    kept.unshift([...turn]);
    keptMessages += turn.length;
    keptChars += turnChars;
  }
  if (kept.length !== turns.length) trimmed = true;

  const contextLeadId =
    input.leadId !== undefined && UUID_PATTERN.test(input.leadId) ? input.leadId : undefined;

  function compose(): AiChatRequest {
    const conversation = kept.flat();
    return {
      requestId: input.requestId,
      message,
      history: conversation.map((entry) => ({
        role: entry.role,
        text: entry.text,
        ...(entry.signature === undefined ? {} : { signature: entry.signature }),
      })),
      ...(contextLeadId === undefined ? {} : { context: { leadId: contextLeadId } }),
    };
  }

  let request = compose();
  while (
    kept.length > 0 &&
    utf8Length(JSON.stringify(request)) > AI_ASSISTANT_LIMITS.maxRequestBytes
  ) {
    kept.shift();
    trimmed = true;
    request = compose();
  }

  return { request, trimmed };
}

/** The contract error code, mapped to what the panel can say about it. */
export function uiErrorForBackendCode(code: string): AiUiError {
  switch (code) {
    case 'ai_unavailable':
    case 'feature_not_ready':
      return 'unavailable';
    case 'missing_session':
    case 'invalid_session':
      return 'session_expired';
    case 'permission_denied':
    case 'membership_missing':
    case 'membership_pending':
    case 'membership_revoked':
    case 'workspace_not_found':
      return 'denied';
    case 'ai_rate_limited':
    case 'rate_limited':
      return 'rate_limited';
    default:
      return 'failed';
  }
}

/** A streamed `error` part's code, mapped the same way. */
export function uiErrorForStreamCode(code: string): AiUiError {
  switch (code) {
    case 'cancelled':
      return 'cancelled';
    case 'rate_limited':
      return 'rate_limited';
    case 'provider_unavailable':
      return 'unavailable';
    case 'access_lost':
      return 'denied';
    // UI-10: what the person can do differs, so the words do too.
    case 'timeout':
      return 'timeout';
    case 'budget_exceeded':
      return 'too_long';
    default:
      return 'failed';
  }
}

export interface StreamAnswerInput {
  accessToken: string;
  workspaceId: string;
  request: AiChatRequest;
  signal?: AbortSignal;
  onPart(part: AiStreamPart): void;
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true) return true;
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Iterates the answer's parts, handing each to `onPart`. Resolves to the error
 * state the panel should show, or `undefined` when the answer finished
 * normally. An abort is `cancelled`, never `failed`; a stream that just stops —
 * a dropped connection, a proxy timeout — is `failed`, never a complete answer.
 */
export async function streamAnswer(input: StreamAnswerInput): Promise<AiUiError | undefined> {
  try {
    for await (const part of askAiAssistant(
      input.accessToken,
      input.workspaceId,
      input.request,
      input.signal === undefined ? undefined : { signal: input.signal },
    )) {
      if (input.signal?.aborted === true) return 'cancelled';
      input.onPart(part);
      if (part.type === 'error') return uiErrorForStreamCode(part.code);
      if (part.type === 'done') return undefined;
    }
    return input.signal?.aborted === true ? 'cancelled' : 'failed';
  } catch (error) {
    if (isAbort(error, input.signal)) return 'cancelled';
    // The client's whole-turn limit: the answer took too long, the CRM was there.
    if (error instanceof Error && error.name === 'TimeoutError') return 'timeout';
    if (errorKind(error) === 'offline') return 'offline';
    if (error instanceof BackendError) return uiErrorForBackendCode(error.code);
    return 'failed';
  }
}
