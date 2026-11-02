import { AI_ASSISTANT_LIMITS } from '@gt-sales/contracts';

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
  private toolCalls = 0;
  private records = 0;
  private dataBytes = 0;
  private leadSummaries = 0;

  /** Reserves one tool call; false once the turn's allowance is spent. */
  reserveToolCall(): boolean {
    if (this.toolCalls >= AI_ASSISTANT_LIMITS.maxToolCalls) return false;
    this.toolCalls += 1;
    return true;
  }

  /** Reserves one lead summary; summaries are the most expensive read. */
  reserveLeadSummary(): boolean {
    if (this.leadSummaries >= AI_ASSISTANT_LIMITS.maxLeadSummaries) return false;
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
