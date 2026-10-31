import { z } from 'zod';

/**
 * The keys of a site's automation flows (phase 8 spec §3). A built-in flow
 * keeps phase 4's rule key; a flow staff build gets `flow_` and 16 random
 * lower-case letters or digits. The built-in key list and the custom pattern
 * are also CHECK constraints in the database (`automations_key_check`), tied to
 * these values by `automation-sql-contracts.integration.test.ts`.
 *
 * This module imports zod only, so `automations.ts`, `automation-flows.ts` and
 * `customer-email.ts` can all use it without a cycle.
 */

export const BUILT_IN_AUTOMATION_KEYS = [
  'order_received',
  'sim_order_information_needed',
  'sim_order_dispatched',
  'sim_order_activated',
  'sim_order_cancelled',
  'mobility_activated',
] as const;
export const builtInAutomationKeySchema = z.enum(BUILT_IN_AUTOMATION_KEYS);
export type BuiltInAutomationKey = z.infer<typeof builtInAutomationKeySchema>;

/** A custom flow's key: `flow_` and 16 of `[a-z0-9]`. */
export const CUSTOM_FLOW_KEY_PATTERN = /^flow_[a-z0-9]{16}$/;
export const customFlowKeySchema = z.string().regex(CUSTOM_FLOW_KEY_PATTERN);

/** Any flow's key: a built-in's or a custom flow's. */
export const automationKeySchema = z.union([builtInAutomationKeySchema, customFlowKeySchema]);
export type AutomationKey = z.infer<typeof automationKeySchema>;

/** The shape every automation key stored on a run has (`automation_runs_key_check`). */
export const AUTOMATION_KEY_SHAPE = /^[a-z][a-z0-9_]{2,63}$/;

/** Flows per site that are not archived, the six built-ins included (spec ruling R1). */
export const AUTOMATION_MAX_FLOWS = 50;

export function isBuiltInAutomationKey(key: string): key is BuiltInAutomationKey {
  return BUILT_IN_AUTOMATION_KEYS.some((entry) => entry === key);
}

const KEY_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
/** The largest multiple of the alphabet's length below 256: bytes from it up are drawn again, so every character is equally likely. */
const UNBIASED_LIMIT = 256 - (256 % KEY_ALPHABET.length);

/** `length` characters of `[a-z0-9]` from `crypto.getRandomValues`. */
export function randomKeySuffix(length: number): string {
  let suffix = '';
  while (suffix.length < length) {
    const bytes = new Uint8Array(length * 2);
    globalThis.crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= UNBIASED_LIMIT) continue;
      suffix += KEY_ALPHABET.charAt(byte % KEY_ALPHABET.length);
      if (suffix.length === length) break;
    }
  }
  return suffix;
}

/** `flow_` + 16 of [a-z0-9] from `crypto.getRandomValues`. */
export function generateFlowKey(): string {
  return `flow_${randomKeySuffix(16)}`;
}
