import type { AiModelSettingsResponse, AiUsageResponse } from '@gt-sales/contracts';

/**
 * Tokens and the model that served a turn are not in the chat stream; the
 * site's usage (Settings → AI usage, owner only) has them per model. The
 * runner reads it before and after each prompt and keeps the difference,
 * which is exact while nobody else asks on the test site at the same time.
 */
export interface UsageSnapshot {
  readonly turns: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly toolCalls: number | undefined;
  /** Per `engine/model`: turns and tokens. */
  readonly models: Readonly<
    Record<string, { turns: number; inputTokens: number; outputTokens: number }>
  >;
}

export interface UsageDelta {
  readonly turns: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly toolCalls: number | null;
  /** The model ids whose turn count went up (normally one). */
  readonly modelsUsed: readonly string[];
}

export function usageSnapshot(usage: AiUsageResponse): UsageSnapshot {
  const models: Record<string, { turns: number; inputTokens: number; outputTokens: number }> = {};
  for (const row of usage.models ?? []) {
    models[`${row.engine}/${row.model ?? 'unknown'}`] = {
      turns: row.turns,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
    };
  }
  return {
    turns: usage.totals.turns,
    inputTokens: usage.totals.inputTokens,
    outputTokens: usage.totals.outputTokens,
    toolCalls: usage.totals.toolCalls,
    models,
  };
}

/**
 * The usage between two snapshots; null when it cannot be trusted (the
 * seven-day window moved past a day with turns, so a total went down).
 */
export function usageDelta(before: UsageSnapshot, after: UsageSnapshot): UsageDelta | null {
  const turns = after.turns - before.turns;
  const inputTokens = after.inputTokens - before.inputTokens;
  const outputTokens = after.outputTokens - before.outputTokens;
  if (turns < 0 || inputTokens < 0 || outputTokens < 0) return null;
  const modelsUsed: string[] = [];
  for (const [key, row] of Object.entries(after.models)) {
    const earlier = before.models[key]?.turns ?? 0;
    if (row.turns > earlier) modelsUsed.push(key.slice(key.indexOf('/') + 1));
  }
  const toolCalls =
    before.toolCalls === undefined || after.toolCalls === undefined
      ? null
      : after.toolCalls - before.toolCalls;
  return {
    turns,
    inputTokens,
    outputTokens,
    toolCalls: toolCalls !== null && toolCalls >= 0 ? toolCalls : null,
    modelsUsed,
  };
}

/** US$ per million tokens, from the Gateway catalogue Settings → AI models reads. */
export type PriceTable = Record<string, { input: number | null; output: number | null }>;

export function priceTable(settings: AiModelSettingsResponse): PriceTable {
  const table: PriceTable = {};
  for (const model of settings.catalogue.models) {
    table[model.id] = { input: model.inputPricePerMillion, output: model.outputPricePerMillion };
  }
  return table;
}

/** A turn's approximate cost in US$ at list price; null without both prices. */
export function turnCostUsd(
  prices: PriceTable,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const price = prices[model];
  if (!price || price.input === null || price.output === null) return null;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}
