import {
  AI_USAGE_MAX_MODELS,
  type AiUsageCost,
  type AiUsageCostDay,
  type AiUsageCostMember,
  type AiUsageCostModel,
  type AiUsageCostReason,
} from '@gt-sales/contracts';

import type { AiCatalogueResult } from './model-catalogue.js';

/**
 * The approximate cost on Settings → AI usage (docs/RUNBOOKS/ai-assistant.md):
 * each model's input and output tokens in the period, at the Gateway
 * catalogue's current list price, in exact integer arithmetic. A price is
 * read from its decimal string into whole atto-dollars (US$ 10^-18) per
 * token, a token count is a bigint, every product and sum is exact, and only
 * the amounts sent are rounded, half up, to whole micro-dollars. A float
 * never touches a price.
 *
 * Only a Gateway turn with a recorded model the catalogue lists with both
 * prices is priced. Every other turn (no model recorded, the test engine, a
 * model the catalogue no longer lists or lists without a price) is counted
 * as unpriced, never guessed; with no catalogue, every turn is.
 *
 * What it is not: the price on the day of the turn (the catalogue only has
 * today's), cached-token discounts, retries the provider billed, or anything
 * outside Ask AI. The Gateway's invoice is the real figure.
 */

/** The price basis the response names: today's list prices, not the turn day's. */
export const AI_USAGE_COST_BASIS = 'current_list_prices';
export const AI_USAGE_COST_CURRENCY = 'USD';

/** Tokens and turns for one (engine, model) pair in one group. */
export interface AiUsageTokenRow {
  readonly engine: string;
  readonly model: string | null;
  readonly turns: number;
  readonly inputTokens: bigint;
  readonly outputTokens: bigint;
}

/** The period's tokens per model, by Toronto day and by member: the input to the cost. */
export interface AiUsageTokenBreakdown {
  readonly byDay: readonly (AiUsageTokenRow & { readonly day: string })[];
  readonly byMember: readonly (AiUsageTokenRow & { readonly actorId: string })[];
}

/** A model's prices in atto-dollars per token, null when it cannot be priced, and its catalogue name. */
export interface AiUsageModelPrice {
  readonly label: string;
  readonly input: bigint | null;
  readonly output: bigint | null;
}

export type AiUsagePriceList = ReadonlyMap<string, AiUsageModelPrice>;

const ATTO_PER_USD = 10n ** 18n;
const ATTO_PER_MICRO = 10n ** 12n;
/** A dollar a token: the most a price may be (the catalogue's own per-million bound). */
const MAX_ATTO_PER_TOKEN = ATTO_PER_USD;
const DECIMAL = /^(\d+)(?:\.(\d+))?(?:[eE]([-+]?\d{1,3}))?$/;
const MAX_PRICE_CHARS = 40;
const MAX_EXPONENT = 30;

/**
 * A per-token price in US dollars, as the Gateway writes it ("0.0000025",
 * "1.5e-7"), in whole atto-dollars: exact up to 18 decimal places, rounded
 * half up past them. Null for anything that is not a plain non-negative
 * number of at most a dollar.
 */
export function parseUsdPerToken(value: string | null | undefined): bigint | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length === 0 || text.length > MAX_PRICE_CHARS) return null;
  const match = DECIMAL.exec(text);
  if (!match) return null;
  const whole = match[1] ?? '';
  const fraction = match[2] ?? '';
  const exponent = Number(match[3] ?? '0');
  if (Math.abs(exponent) > MAX_EXPONENT) return null;
  const digits = BigInt(whole + fraction);
  // value = digits × 10^(exponent − fraction digits); in atto-dollars, × 10^18.
  const shift = 18 + exponent - fraction.length;
  let atto: bigint;
  if (shift >= 0) {
    atto = digits * 10n ** BigInt(shift);
  } else {
    const divisor = 10n ** BigInt(-shift);
    atto = (digits * 2n + divisor) / (divisor * 2n);
  }
  return atto <= MAX_ATTO_PER_TOKEN ? atto : null;
}

/** Atto-dollars as whole micro-dollars, half up; a non-zero amount is at least 1. */
export function microUsdOf(atto: bigint): number {
  if (atto <= 0n) return 0;
  const micro = (atto + ATTO_PER_MICRO / 2n) / ATTO_PER_MICRO;
  return Number(micro > 0n ? micro : 1n);
}

/** A per-token price in atto-dollars as dollars per million tokens, an exact decimal ("2.5"). */
export function usdPerMillionText(attoPerToken: bigint): string {
  // × 10^6 tokens ÷ 10^18 atto: dollars per million is the atto price over 10^12.
  const whole = attoPerToken / ATTO_PER_MICRO;
  const fraction = (attoPerToken % ATTO_PER_MICRO).toString().padStart(12, '0').replace(/0+$/, '');
  return fraction.length === 0 ? whole.toString() : `${whole.toString()}.${fraction}`;
}

/**
 * The catalogue's models as a price list: every listed language model by id
 * with its name, and both prices when both are readable. Undefined when the
 * catalogue could not be read.
 */
export function usagePriceList(catalogue: AiCatalogueResult): AiUsagePriceList | undefined {
  if (catalogue.status !== 'ok') return undefined;
  const list = new Map<string, AiUsageModelPrice>();
  for (const model of catalogue.models) {
    const raw = catalogue.prices.get(model.id);
    const input = parseUsdPerToken(raw?.input);
    const output = parseUsdPerToken(raw?.output);
    list.set(
      model.id,
      input === null || output === null
        ? { label: model.name, input: null, output: null }
        : { label: model.name, input, output },
    );
  }
  return list;
}

/** A row's priced cost in atto-dollars, or null when the row cannot be priced. */
function attoOf(row: AiUsageTokenRow, prices: AiUsagePriceList): bigint | null {
  if (row.engine !== 'gateway' || row.model === null) return null;
  const price = prices.get(row.model);
  if (!price || price.input === null || price.output === null) return null;
  return row.inputTokens * price.input + row.outputTokens * price.output;
}

interface Tally {
  atto: bigint;
  pricedTurns: number;
  unpricedTurns: number;
}

const emptyTally = (): Tally => ({ atto: 0n, pricedTurns: 0, unpricedTurns: 0 });

function add(tally: Tally, row: AiUsageTokenRow, atto: bigint | null): void {
  if (atto === null) {
    tally.unpricedTurns += row.turns;
  } else {
    tally.atto += atto;
    tally.pricedTurns += row.turns;
  }
}

const modelKey = (row: Pick<AiUsageTokenRow, 'engine' | 'model'>) =>
  `${row.engine}\u0000${row.model ?? ''}`;

/** Costliest first, then most turns, then by engine and model (no model last), so the order never wobbles. */
function compareModels(a: AiUsageCostModel, b: AiUsageCostModel): number {
  const costA = a.costMicroUsd ?? -1;
  const costB = b.costMicroUsd ?? -1;
  if (costA !== costB) return costB - costA;
  if (a.turns !== b.turns) return b.turns - a.turns;
  if (a.engine !== b.engine) return a.engine < b.engine ? -1 : 1;
  if (a.model === b.model) return 0;
  if (a.model === null) return 1;
  if (b.model === null) return -1;
  return a.model < b.model ? -1 : 1;
}

/**
 * The cost of the period from its token breakdown. `days` is the series the
 * usage answer holds (every Toronto day of the period, oldest first); each
 * gets its cost, zero for a quiet day. `prices` undefined means the catalogue
 * could not be read: nothing is priced and the reason says so.
 */
export function priceAiUsage(
  breakdown: AiUsageTokenBreakdown,
  days: readonly string[],
  prices: AiUsagePriceList | undefined,
): AiUsageCost {
  const turns = breakdown.byDay.reduce((sum, row) => sum + row.turns, 0);
  if (prices === undefined) {
    return {
      currency: AI_USAGE_COST_CURRENCY,
      basis: AI_USAGE_COST_BASIS,
      priced: false,
      reason: 'catalogue_unavailable' satisfies AiUsageCostReason,
      totalMicroUsd: 0,
      pricedTurns: 0,
      unpricedTurns: turns,
      models: [],
      daily: [],
      members: [],
    };
  }

  const total = emptyTally();
  const byDay = new Map<string, Tally>(days.map((day) => [day, emptyTally()]));
  const byModel = new Map<
    string,
    {
      engine: string;
      model: string | null;
      turns: number;
      input: bigint;
      output: bigint;
      atto: bigint | null;
    }
  >();
  for (const row of breakdown.byDay) {
    const atto = attoOf(row, prices);
    add(total, row, atto);
    const day = byDay.get(row.day);
    if (day) add(day, row, atto);
    const key = modelKey(row);
    const model = byModel.get(key) ?? {
      engine: row.engine,
      model: row.model,
      turns: 0,
      input: 0n,
      output: 0n,
      atto: atto === null ? null : 0n,
    };
    model.turns += row.turns;
    model.input += row.inputTokens;
    model.output += row.outputTokens;
    if (model.atto !== null && atto !== null) model.atto += atto;
    byModel.set(key, model);
  }

  const byMember = new Map<string, Tally>();
  for (const row of breakdown.byMember) {
    const member = byMember.get(row.actorId) ?? emptyTally();
    add(member, row, attoOf(row, prices));
    byMember.set(row.actorId, member);
  }

  const models = [...byModel.values()]
    .map((entry): AiUsageCostModel => {
      // A Gateway turn's model named as the catalogue names it, priced or not.
      const listed =
        entry.engine === 'gateway' && entry.model !== null ? prices.get(entry.model) : undefined;
      // A priced row had both prices (`attoOf`).
      const input = entry.atto === null ? null : (listed?.input ?? null);
      const output = entry.atto === null ? null : (listed?.output ?? null);
      return {
        model: entry.model,
        engine: entry.engine,
        label: listed?.label ?? null,
        turns: entry.turns,
        inputTokens: Number(entry.input),
        outputTokens: Number(entry.output),
        inputPricePerMillion: input === null ? null : usdPerMillionText(input),
        outputPricePerMillion: output === null ? null : usdPerMillionText(output),
        costMicroUsd: entry.atto === null ? null : microUsdOf(entry.atto),
      };
    })
    .sort(compareModels)
    .slice(0, AI_USAGE_MAX_MODELS);

  const daily = [...byDay.entries()].map(([day, tally]): AiUsageCostDay => ({
    day,
    costMicroUsd: microUsdOf(tally.atto),
    unpricedTurns: tally.unpricedTurns,
  }));

  const members = [...byMember.entries()]
    .map(([actorId, tally]) => ({ actorId, tally }))
    .sort(
      (a, b) =>
        (a.tally.atto === b.tally.atto ? 0 : a.tally.atto > b.tally.atto ? -1 : 1) ||
        (a.actorId < b.actorId ? -1 : a.actorId > b.actorId ? 1 : 0),
    )
    .slice(0, 1000)
    .map(({ actorId, tally }): AiUsageCostMember => ({
      actorId,
      costMicroUsd: microUsdOf(tally.atto),
      unpricedTurns: tally.unpricedTurns,
    }));

  const nothingPriced = turns > 0 && total.pricedTurns === 0;
  return {
    currency: AI_USAGE_COST_CURRENCY,
    basis: AI_USAGE_COST_BASIS,
    priced: !nothingPriced,
    ...(nothingPriced ? { reason: 'no_priced_turns' satisfies AiUsageCostReason } : {}),
    totalMicroUsd: microUsdOf(total.atto),
    pricedTurns: total.pricedTurns,
    unpricedTurns: total.unpricedTurns,
    models,
    daily,
    members,
  };
}
