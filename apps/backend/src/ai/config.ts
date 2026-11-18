import { z } from 'zod';

import {
  aiAttachmentKindSchema,
  type AiAttachmentKind,
  type AiUnavailableReason,
} from '@gt-sales/contracts';

/**
 * Ask AI's server configuration.
 *
 * The feature is off unless the owner switches it on explicitly
 * (`AI_ASSISTANT_ENABLED=true`) and every needed value is present. A broken or
 * partial configuration disables the assistant only: it never stops the rest of
 * the CRM from booting, and the reason it reports is a bounded code, never a
 * configuration value.
 */
export interface AiAssistantConfig {
  /** True only when every requirement is met; the route still rechecks the site allowlist. */
  readonly enabled: boolean;
  readonly automationWorkspaceIds?: ReadonlySet<string>;
  /** Why not, when `enabled` is false. Safe to return to an authorized caller. */
  readonly reason?: AiUnavailableReason;
  /** Exact Gateway model id; never defaulted, so an unset value cannot pick a paid model. */
  readonly modelId?: string;
  /**
   * Gateway hosts allowed to serve the model, in preference order
   * (`AI_GATEWAY_PROVIDERS`). Unset lets the Gateway choose. Set, the Gateway
   * uses only these, so an open model cannot be served from an unvetted host.
   */
  readonly providers?: readonly string[];
  /** Gateway API key; server-only, never logged or returned. */
  readonly apiKey?: string;
  /**
   * The key that signs reviewed action cards and automation proposals:
   * `AI_ACTION_SIGNING_SECRET` when set (32+ characters), else, so a deploy
   * before the secret is configured keeps working, the Gateway key as before
   * (`signingKeySource: 'gateway'`, reported at startup). A secret that is
   * set but too short leaves it unset: no card can be signed or confirmed.
   */
  readonly signingKey?: string;
  readonly signingKeySource?: 'dedicated' | 'gateway';
  /** Sites the owner has enabled by id. Empty means none. */
  readonly workspaceIds: ReadonlySet<string>;
  /**
   * The kinds of file a member may attach to a message (`AI_ATTACHMENT_KINDS`,
   * a comma list of `image`, `pdf`, `text`), in that order. Unset, empty or
   * all-unknown means none: uploads are off, like every AI setting until the
   * owner turns it on. Storage must be configured too; the routes check that.
   */
  readonly attachmentKinds?: readonly AiAttachmentKind[];
}

/** The shortest `AI_ACTION_SIGNING_SECRET` accepted, in characters. */
export const AI_SIGNING_SECRET_MIN = 32;

/** The model id's shape; the Gateway catalogue is authoritative for existence. */
const modelIdSchema = z.string().trim().min(1).max(120);

/** A Gateway provider slug, such as `baseten` or `vertexAnthropic`. */
const providerSlugSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,39}$/);

/** At most this many hosts in `AI_GATEWAY_PROVIDERS`. */
export const AI_GATEWAY_PROVIDERS_MAX = 8;

/**
 * Reads `AI_GATEWAY_PROVIDERS`. Malformed entries are dropped, duplicates
 * removed and the list capped. A value with no valid entry is `undefined`
 * rather than an empty list, which the Gateway would read as "no host".
 */
function parseProviders(raw: string | undefined): readonly string[] | undefined {
  const providers: string[] = [];
  for (const entry of (raw ?? '').split(',')) {
    const parsed = providerSlugSchema.safeParse(entry.trim());
    if (parsed.success && !providers.includes(parsed.data)) providers.push(parsed.data);
  }
  return providers.length > 0 ? providers.slice(0, AI_GATEWAY_PROVIDERS_MAX) : undefined;
}

/** Reads `AI_ATTACHMENT_KINDS`: unknown entries are ignored, the order is fixed. */
export function parseAttachmentKinds(raw: string | undefined): readonly AiAttachmentKind[] {
  const named = new Set<AiAttachmentKind>();
  for (const entry of (raw ?? '').split(',')) {
    const parsed = aiAttachmentKindSchema.safeParse(entry.trim().toLowerCase());
    if (parsed.success) named.add(parsed.data);
  }
  return aiAttachmentKindSchema.options.filter((kind) => named.has(kind));
}

function parseWorkspaceIds(raw: string | undefined): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const entry of (raw ?? '').split(',')) {
    const parsed = z.uuid().safeParse(entry.trim());
    // A malformed id is dropped rather than failing the whole feature: one typo
    // must not take a working site offline. It enables nothing by itself.
    if (parsed.success) ids.add(parsed.data);
  }
  return ids;
}

/**
 * Reads the assistant's configuration from the environment. Pure, so tests can
 * cover every combination without touching `process.env`.
 */
export function loadAiAssistantConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AiAssistantConfig {
  const workspaceIds = parseWorkspaceIds(env['AI_ASSISTANT_WORKSPACE_IDS']);
  const kinds = parseAttachmentKinds(env['AI_ATTACHMENT_KINDS']);
  const attachments = kinds.length > 0 ? { attachmentKinds: kinds } : {};
  if (env['AI_ASSISTANT_ENABLED'] !== 'true') {
    return { enabled: false, reason: 'disabled', workspaceIds, ...attachments };
  }
  const apiKey = env['AI_GATEWAY_API_KEY']?.trim();
  const modelId = modelIdSchema.safeParse(env['AI_GATEWAY_MODEL']);
  if (!apiKey || !modelId.success) {
    return { enabled: false, reason: 'not_configured', workspaceIds, ...attachments };
  }
  const secret = env['AI_ACTION_SIGNING_SECRET']?.trim();
  const signing =
    secret === undefined || secret === ''
      ? { signingKey: apiKey, signingKeySource: 'gateway' as const }
      : secret.length >= AI_SIGNING_SECRET_MIN
        ? { signingKey: secret, signingKeySource: 'dedicated' as const }
        : {};
  const providers = parseProviders(env['AI_GATEWAY_PROVIDERS']);
  return {
    enabled: true,
    apiKey,
    modelId: modelId.data,
    ...(providers ? { providers } : {}),
    ...signing,
    workspaceIds,
    ...attachments,
    ...(env['AI_AUTOMATION_WORKSPACE_IDS']
      ? { automationWorkspaceIds: parseWorkspaceIds(env['AI_AUTOMATION_WORKSPACE_IDS']) }
      : {}),
  };
}
