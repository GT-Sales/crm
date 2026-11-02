import { z } from 'zod';

import type { AiUnavailableReason } from '@gt-sales/contracts';

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
  /** Why not, when `enabled` is false. Safe to return to an authorized caller. */
  readonly reason?: AiUnavailableReason;
  /** Exact Gateway model id; never defaulted, so an unset value cannot pick a paid model. */
  readonly modelId?: string;
  /** Gateway API key; server-only, never logged or returned. */
  readonly apiKey?: string;
  /** Sites the owner has enabled by id. Empty means none. */
  readonly workspaceIds: ReadonlySet<string>;
}

/** The model id's shape; the Gateway catalogue is authoritative for existence. */
const modelIdSchema = z.string().trim().min(1).max(120);

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
  if (env['AI_ASSISTANT_ENABLED'] !== 'true') {
    return { enabled: false, reason: 'disabled', workspaceIds };
  }
  const apiKey = env['AI_GATEWAY_API_KEY']?.trim();
  const modelId = modelIdSchema.safeParse(env['AI_GATEWAY_MODEL']);
  if (!apiKey || !modelId.success) {
    return { enabled: false, reason: 'not_configured', workspaceIds };
  }
  return { enabled: true, apiKey, modelId: modelId.data, workspaceIds };
}
