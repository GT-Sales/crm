import type { RateLimitInput, RateLimitResult } from '@gt-sales/db';
import { AI_ASSISTANT_LIMITS, AI_CHAT_LIMITS, type AiEffort } from '@gt-sales/contracts';

/**
 * What one turn may spend at its effort level. A Normal turn reads exactly the
 * limits it always had; a High turn the `…High` ones. The data limits (bytes
 * per result and per turn, records per turn) are the same at both levels.
 */
export interface TurnLimits {
  readonly modelSteps: number;
  readonly toolCalls: number;
  readonly leadSummaries: number;
  /** The answer's output tokens of one generation (authoring raises it; reasoning adds to it). */
  readonly outputTokens: number;
  readonly timeoutMs: number;
}

export function turnLimits(effort: AiEffort = 'normal'): TurnLimits {
  return effort === 'high'
    ? {
        modelSteps: AI_ASSISTANT_LIMITS.maxModelStepsHigh,
        toolCalls: AI_ASSISTANT_LIMITS.maxToolCallsHigh,
        leadSummaries: AI_ASSISTANT_LIMITS.maxLeadSummariesHigh,
        outputTokens: AI_ASSISTANT_LIMITS.maxOutputTokensHigh,
        timeoutMs: AI_ASSISTANT_LIMITS.requestTimeoutMsHigh,
      }
    : {
        modelSteps: AI_ASSISTANT_LIMITS.maxModelSteps,
        toolCalls: AI_ASSISTANT_LIMITS.maxToolCalls,
        leadSummaries: AI_ASSISTANT_LIMITS.maxLeadSummaries,
        outputTokens: AI_ASSISTANT_LIMITS.maxOutputTokens,
        timeoutMs: AI_ASSISTANT_LIMITS.requestTimeoutMs,
      };
}

/**
 * One turn's budget, shared by every tool call the model makes.
 *
 * The model may ask for more than the product allows, in parallel or in
 * sequence; each reservation here is atomic within the turn, so ten tool calls
 * in one assistant message still stop at six, and a tool that would push the
 * record or byte ceiling is trimmed (whole records only) with `truncated: true`
 * rather than silently changing a total or slicing JSON.
 */
export interface TurnUsage {
  readonly toolCalls: number;
  readonly records: number;
  readonly dataBytes: number;
  readonly leadSummaries: number;
}

export interface AcceptedResult {
  /** How many records of the proposed set still fit; trim the rest off the end. */
  readonly allowedRecords: number;
  /** True when the result had to be cut, or would not fit at all. */
  readonly truncated: boolean;
  /** True when not one byte could be accepted; the caller returns a bounded note. */
  readonly rejected: boolean;
}

export class TurnBudget {
  private readonly limits: TurnLimits;
  private toolCalls = 0;
  private records = 0;
  private dataBytes = 0;
  private leadSummaries = 0;

  /** A High turn may make more tool calls and read more lead summaries; nothing else changes. */
  constructor(effort: AiEffort = 'normal') {
    this.limits = turnLimits(effort);
  }

  /** Reserves one tool call; false once the turn's allowance is spent. */
  reserveToolCall(): boolean {
    if (this.toolCalls >= this.limits.toolCalls) return false;
    this.toolCalls += 1;
    return true;
  }

  /** Reserves one lead summary; summaries are the most expensive read. */
  reserveLeadSummary(): boolean {
    if (this.leadSummaries >= this.limits.leadSummaries) return false;
    this.leadSummaries += 1;
    return true;
  }

  /**
   * Accepts a tool's result within the byte and record ceilings. `bytes` is the
   * serialized result as it would be handed to the model.
   */
  acceptResult(proposed: { bytes: number; records: number }): AcceptedResult {
    if (proposed.bytes > this.remainingBytes || proposed.records > this.remainingRecords) {
      return { allowedRecords: 0, truncated: true, rejected: true };
    }
    this.dataBytes += proposed.bytes;
    this.records += proposed.records;
    return { allowedRecords: proposed.records, truncated: false, rejected: false };
  }

  get remainingBytes(): number {
    return Math.min(
      AI_ASSISTANT_LIMITS.maxToolResultBytes,
      AI_ASSISTANT_LIMITS.maxToolDataBytes - this.dataBytes,
    );
  }

  get remainingRecords(): number {
    return AI_ASSISTANT_LIMITS.maxRecordsPerTurn - this.records;
  }

  get usage(): TurnUsage {
    return {
      toolCalls: this.toolCalls,
      records: this.records,
      dataBytes: this.dataBytes,
      leadSummaries: this.leadSummaries,
    };
  }
}

/**
 * Audit B7: charges a turn's attachment bytes to the member's daily budget on
 * this site (`AI_CHAT_LIMITS.attachmentBytesPerActorPerDay`), in whole
 * `attachmentBudgetUnitBytes`, through the shared limiter: one hit per unit,
 * so the database's own counter is the budget and every replica sees it.
 * `spent` once a hit is refused (the rest are not asked); `unavailable` when
 * the limiter cannot be reached. Either way the caller sends no file: the
 * budget fails closed. A refused turn's units still count, so a member past
 * the budget stays past it until the UTC day ends.
 */
export async function chargeDailyAttachmentBytes(
  rateLimit: (input: RateLimitInput) => Promise<RateLimitResult>,
  scope: { workspaceId: string; actorId: string },
  bytes: number,
): Promise<'allowed' | 'spent' | 'unavailable'> {
  const unit = AI_CHAT_LIMITS.attachmentBudgetUnitBytes;
  const units = Math.ceil(Math.max(0, bytes) / unit);
  for (let charged = 0; charged < units; charged += 1) {
    let result: RateLimitResult;
    try {
      result = await rateLimit({
        bucketKey: `ai_file_bytes:${scope.actorId}:${scope.workspaceId}`,
        windowSeconds: 86_400,
        maxCount: Math.floor(AI_CHAT_LIMITS.attachmentBytesPerActorPerDay / unit),
      });
    } catch {
      return 'unavailable';
    }
    if (!result.allowed) return 'spent';
  }
  return 'allowed';
}
