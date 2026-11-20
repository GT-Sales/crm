import { createGateway } from 'ai';
import { aiModelIdSchema, AI_MODEL_LIMITS, type AiCatalogueModel } from '@gt-sales/contracts';

/**
 * The Vercel AI Gateway's model catalogue, the candidates an owner picks Ask
 * AI's models from (Settings → AI models). Read on the server with the Gateway
 * provider's `getAvailableModels()` (`@ai-sdk/gateway` 4.0.132:
 * `GatewayFetchMetadataResponse`, one `GatewayLanguageModelEntry` per model
 * with id, name, description, pricing and `modelType`), and kept in memory for
 * `AI_MODEL_CATALOGUE_TTL_MS`. Only the owner's two routes read it: a chat
 * turn never does (it checks the site's saved list), so a catalogue that
 * cannot be read is "catalogue unavailable" in Settings and nothing more.
 *
 * Only language models are candidates: an entry whose `modelType` is set to
 * anything else is left out. An entry with no `modelType` is kept as a
 * language model, as the SDK's own metadata treats it (the field is
 * optional, and the Gateway sets it for every other kind). The metadata
 * carries no capability flags, so whether a model can call tools is not
 * known here: Settings says so, and a chosen model's turns ask the Gateway
 * for hosts with tool calls (`engine.ts`, `gatewayRouting`).
 */

/** How long a catalogue read is kept. */
export const AI_MODEL_CATALOGUE_TTL_MS = 10 * 60_000;
/** How long a failed read is remembered before the Gateway is asked again. */
export const AI_MODEL_CATALOGUE_FAILURE_TTL_MS = 60_000;

/** The fields of the SDK's `GatewayLanguageModelEntry` this file reads. */
export interface GatewayCatalogueEntry {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly pricing?: { readonly input: string; readonly output: string } | null;
  readonly modelType?: string | null;
}

/**
 * A model's list prices exactly as the Gateway sent them: US dollars per
 * token as decimal strings, never turned into a float. The usage page prices
 * tokens with them (`usage-cost.ts`); Settings shows `AiCatalogueModel`'s
 * rounded per-million numbers.
 */
export interface AiModelListPrice {
  readonly input: string;
  readonly output: string;
}

export type AiCatalogueResult =
  | {
      readonly status: 'ok';
      readonly models: readonly AiCatalogueModel[];
      /** The raw prices of the models in `models` that have any, by id. Server-side only. */
      readonly prices: ReadonlyMap<string, AiModelListPrice>;
    }
  | { readonly status: 'unavailable' };

export interface AiModelCatalogue {
  /**
   * The catalogue's language models. `fresh` reads the Gateway now (a save
   * checks ids against the catalogue of that moment) and refreshes the cache.
   * Never rejects: a failure is `unavailable`.
   */
  models(options?: { fresh?: boolean }): Promise<AiCatalogueResult>;
}

/** Control characters and runs of whitespace become one space; the text is trimmed and cut. */
function cleanText(value: string | null | undefined, max: number): string | null {
  if (typeof value !== 'string') return null;
  const flat = value.replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, ' ').trim();
  if (flat.length === 0) return null;
  const characters = Array.from(flat);
  return characters.length <= max
    ? flat
    : `${characters
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`;
}

/** A per-token price in dollars as a per-million price, rounded to 4 places; null when unreadable. */
export function pricePerMillion(perToken: string | undefined): number | null {
  if (perToken === undefined || perToken.trim() === '') return null;
  const value = Number(perToken);
  if (!Number.isFinite(value) || value < 0) return null;
  const perMillion = Math.round(value * 1_000_000 * 10_000) / 10_000;
  return perMillion <= 1_000_000 ? perMillion : null;
}

/** The catalogue entries Settings may offer, in the catalogue's order, bounded. */
export function catalogueModels(entries: readonly GatewayCatalogueEntry[]): AiCatalogueModel[] {
  return catalogueRead(entries).models;
}

/** The models Settings may offer and, for the same models, their raw list prices. */
export function catalogueRead(entries: readonly GatewayCatalogueEntry[]): {
  models: AiCatalogueModel[];
  prices: Map<string, AiModelListPrice>;
} {
  const models: AiCatalogueModel[] = [];
  const prices = new Map<string, AiModelListPrice>();
  const seen = new Set<string>();
  for (const entry of entries) {
    if (models.length >= AI_MODEL_LIMITS.maxCatalogue) break;
    if (entry.modelType !== undefined && entry.modelType !== null && entry.modelType !== 'language')
      continue;
    const id = aiModelIdSchema.safeParse(entry.id);
    if (!id.success || seen.has(id.data)) continue;
    seen.add(id.data);
    const vendor = id.data.slice(0, id.data.indexOf('/')).slice(0, 60);
    models.push({
      id: id.data,
      name: cleanText(entry.name, AI_MODEL_LIMITS.maxLabelChars) ?? id.data.slice(0, 80),
      vendor,
      description: cleanText(entry.description, AI_MODEL_LIMITS.maxDescriptionChars),
      inputPricePerMillion: pricePerMillion(entry.pricing?.input),
      outputPricePerMillion: pricePerMillion(entry.pricing?.output),
    });
    const pricing = entry.pricing;
    if (pricing && typeof pricing.input === 'string' && typeof pricing.output === 'string')
      prices.set(id.data, { input: pricing.input, output: pricing.output });
  }
  return { models, prices };
}

/**
 * The catalogue over one fetch function, cached: a read is kept for `ttlMs`
 * and a failure for `failureTtlMs`; concurrent reads share one request.
 */
export class CachedModelCatalogue implements AiModelCatalogue {
  private cached: { result: AiCatalogueResult; at: number } | undefined;
  private pending: Promise<AiCatalogueResult> | undefined;

  constructor(
    private readonly fetchEntries: () => Promise<{
      readonly models: readonly GatewayCatalogueEntry[];
    }>,
    private readonly options: { ttlMs?: number; failureTtlMs?: number; now?: () => number } = {},
  ) {}

  async models(options: { fresh?: boolean } = {}): Promise<AiCatalogueResult> {
    const now = (this.options.now ?? Date.now)();
    const cached = this.cached;
    if (cached && options.fresh !== true) {
      const ttl =
        cached.result.status === 'ok'
          ? (this.options.ttlMs ?? AI_MODEL_CATALOGUE_TTL_MS)
          : (this.options.failureTtlMs ?? AI_MODEL_CATALOGUE_FAILURE_TTL_MS);
      if (now - cached.at < ttl) return cached.result;
    }
    if (options.fresh === true) return this.read();
    this.pending ??= this.read().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async read(): Promise<AiCatalogueResult> {
    let result: AiCatalogueResult;
    try {
      const metadata = await this.fetchEntries();
      result = { status: 'ok', ...catalogueRead(metadata.models) };
    } catch {
      // The Gateway's error may repeat its request; only that it failed is kept.
      result = { status: 'unavailable' };
    }
    this.cached = { result, at: (this.options.now ?? Date.now)() };
    return result;
  }
}

/**
 * The real catalogue, through the Gateway provider with the deployment's key.
 * A new provider per read, so the SDK's own metadata cache never answers a
 * save with an older list than the one asked for.
 */
export function createGatewayModelCatalogue(apiKey: string): AiModelCatalogue {
  return new CachedModelCatalogue(() => createGateway({ apiKey }).getAvailableModels());
}
