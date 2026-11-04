import { sanitizeLogIdentifier } from '../http/logger.js';

/**
 * One line per attempted answer, allowlisted on purpose.
 *
 * No prompt, no chat history, no tool arguments, no tool results, no record
 * text, no bearer token, no provider body: an operator can see that a turn
 * happened, for which site and actor, with which model, how it ended, how long
 * it took and what it cost in tokens — and nothing a customer wrote.
 */
export interface AiTurnLog {
  readonly requestId: string;
  readonly workspaceId: string;
  readonly actorId: string;
  readonly engine: 'gateway' | 'fake';
  readonly modelId?: string;
  readonly promptVersion: number;
  readonly outcome: 'completed' | 'cancelled' | 'failed' | 'access_lost';
  readonly durationMs: number;
  readonly outputTokens?: number;
  readonly recoveredDraft?: boolean;
  readonly failureCode?: import('@gt-sales/contracts').AiStreamErrorCode;
  readonly toolCalls: number;
  readonly records: number;
  readonly dataBytes: number;
}

export function logAiTurn(record: AiTurnLog): void {
  console.info(
    JSON.stringify({
      event: 'ai_turn',
      requestId: sanitizeLogIdentifier(record.requestId),
      workspaceId: sanitizeLogIdentifier(record.workspaceId),
      actorId: sanitizeLogIdentifier(record.actorId),
      engine: record.engine,
      model: record.modelId === undefined ? 'unset' : sanitizeLogIdentifier(record.modelId),
      promptVersion: record.promptVersion,
      outcome: record.outcome,
      durationMs: record.durationMs,
      outputTokens: record.outputTokens ?? 0,
      ...(record.recoveredDraft ? { recoveredDraft: true } : {}),
      ...(record.failureCode ? { failureCode: record.failureCode } : {}),
      toolCalls: record.toolCalls,
      records: record.records,
      dataBytes: record.dataBytes,
    }),
  );
}
