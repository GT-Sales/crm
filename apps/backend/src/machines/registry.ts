import { createHmac, timingSafeEqual } from 'node:crypto';

import type { WebsiteAuthErrorCode } from '@gt-sales/contracts';
import { machineScopeNames, type MachineScopeName } from '@gt-sales/types';
import { z } from 'zod';

import { secretsEqual } from '../website/credential.js';

/**
 * Server-only integration registry (PLATFORM_CONTEXT §4b). It is deployment
 * configuration maintained through the owner's release process — never a
 * cross-tenant DB read and no customer data. URL/selector IDs are untrusted;
 * the mapped signature or scheduler secret is verified before any context is
 * derived. Unknown, revoked, account-mismatched or foreign-workspace
 * identities fail closed.
 */

const webhookEntrySchema = z.object({
  selector: z.string().min(1),
  provider: z.string().min(1),
  providerAccount: z.string().min(1),
  workspaceId: z.uuid(),
  /**
   * The verified machine actor recorded for this integration's tenant writes.
   * Required so a webhook ingest (and every later drain of it) is attributed to
   * a stable registry identity rather than the event id or a random UUID.
   */
  actorId: z.uuid(),
  verificationSecret: z.string().min(16),
  sanity: z
    .object({
      projectId: z.string().regex(/^[a-z0-9-]+$/),
      dataset: z.string().regex(/^[a-zA-Z0-9_-]+$/),
      apiVersion: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      readToken: z.string().min(1).optional(),
      revalidateUrl: z.url(),
      revalidateSecret: z.string().min(16),
    })
    .optional(),
  revoked: z.boolean().default(false),
});

const schedulerEntrySchema = z.object({
  selector: z.string().min(1),
  secret: z.string().min(16),
  actorId: z.uuid(),
  workspaceIds: z.array(z.uuid()).min(1),
  scopes: z.array(z.enum(machineScopeNames)).min(1),
  revoked: z.boolean().default(false),
});

export const machineRegistryConfigSchema = z.object({
  webhooks: z.array(webhookEntrySchema).default([]),
  schedulers: z.array(schedulerEntrySchema).default([]),
});

export type MachineRegistryConfig = z.infer<typeof machineRegistryConfigSchema>;
type WebhookEntry = z.infer<typeof webhookEntrySchema>;
type SchedulerEntry = z.infer<typeof schedulerEntrySchema>;

type MachineFailure = { ok: false; reason: WebsiteAuthErrorCode };

export type WebhookResolution =
  | {
      ok: true;
      selector: string;
      provider: string;
      workspaceId: string;
      providerAccount: string;
      actorId: string;
    }
  | MachineFailure;

export interface SanityMachineIntegration {
  selector: string;
  workspaceId: string;
  providerAccount: string;
  projectId: string;
  dataset: string;
  apiVersion?: string;
  readToken?: string;
  revalidateUrl: string;
  revalidateSecret: string;
}

export interface SchedulerIdentity {
  actorId: string;
  workspaceIds: readonly string[];
  scopes: readonly MachineScopeName[];
  /** Fails closed when a job targets a workspace the identity was not granted. */
  authorizeWorkspace(workspaceId: string): boolean;
  hasScope(scope: MachineScopeName): boolean;
}

export type SchedulerResolution = ({ ok: true } & SchedulerIdentity) | MachineFailure;

export interface ResolveWebhookInput {
  selector: string;
  expectedProvider?: string;
  providerAccount: string;
  signature: string;
  rawBody: string | Buffer;
  /** Optional route expectation; a mismatch is cross-workspace confusion. */
  expectedWorkspaceId?: string;
}

export interface ResolveSchedulerInput {
  selector: string;
  secret: string;
}

function hexEqual(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function textEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Sanity signs `timestamp.rawBody` and encodes the HMAC using base64url. The
 * `t` value is a millisecond Unix timestamp (@sanity/webhook rejects anything
 * else), so it is compared with `nowMs` directly.
 */
function verifySanitySignature(
  header: string,
  secret: string,
  rawBody: string | Buffer,
  nowMs: number,
): boolean {
  const values = new Map(
    header.split(/[, ]+/).map((part) => {
      const separator = part.indexOf('=');
      return separator < 1 ? ['', ''] : [part.slice(0, separator), part.slice(separator + 1)];
    }),
  );
  const timestamp = values.get('t');
  const received = values.get('v1');
  if (!timestamp || !received || !/^\d+$/.test(timestamp)) return false;
  const ageMs = Math.abs(nowMs - Number(timestamp));
  if (!Number.isFinite(ageMs) || ageMs > 5 * 60 * 1_000) return false;
  const expected = createHmac('sha256', secret)
    .update(timestamp)
    .update('.')
    .update(rawBody)
    .digest('base64url');
  return textEqual(received, expected);
}

/** Resend uses Standard Webhooks/Svix: id.timestamp.rawBody, whsec_ base64 key.
 * Protocol: resend-node/src/webhooks/webhooks.ts and standard-webhooks JS verifier.
 */
function verifyResendSignature(
  input: {
    id: string;
    timestamp: string;
    signature: string;
    rawBody: Buffer;
  },
  secret: string,
  nowMs: number,
): boolean {
  if (!input.id || input.id.length > 200 || !/^\d+$/.test(input.timestamp)) return false;
  const age = Math.abs(nowMs / 1000 - Number(input.timestamp));
  if (!Number.isFinite(age) || age > 300 || !secret.startsWith('whsec_')) return false;
  const encoded = secret.slice(6);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
  const key = Buffer.from(encoded, 'base64');
  if (key.length < 16) return false;
  const expected = createHmac('sha256', key)
    .update(`${input.id}.${input.timestamp}.`)
    .update(input.rawBody)
    .digest('base64');
  return input.signature.split(' ').some((part) => {
    const [version, signature, extra] = part.split(',');
    return version === 'v1' && extra === undefined && !!signature && textEqual(signature, expected);
  });
}

export class MachineRegistry {
  private readonly webhooks: Map<string, WebhookEntry>;
  private readonly schedulers: Map<string, SchedulerEntry>;

  constructor(
    config: MachineRegistryConfig,
    private readonly now: () => number = Date.now,
  ) {
    this.webhooks = new Map(config.webhooks.map((entry) => [entry.selector, entry]));
    this.schedulers = new Map(config.schedulers.map((entry) => [entry.selector, entry]));
    if (this.webhooks.size !== config.webhooks.length)
      throw new Error('Duplicate webhook selector.');
    const activeWebhookSecrets = config.webhooks
      .filter((entry) => !entry.revoked)
      .map((entry) => entry.verificationSecret);
    if (new Set(activeWebhookSecrets).size !== activeWebhookSecrets.length) {
      throw new Error('Active webhook verification secrets must be unique.');
    }
    if (this.schedulers.size !== config.schedulers.length) {
      throw new Error('Duplicate scheduler selector.');
    }
    const activeSchedulerSecrets = config.schedulers
      .filter((entry) => !entry.revoked)
      .map((entry) => entry.secret);
    if (new Set(activeSchedulerSecrets).size !== activeSchedulerSecrets.length) {
      throw new Error('Active scheduler secrets must be unique.');
    }
  }

  resolveWebhook(input: ResolveWebhookInput): WebhookResolution {
    const entry = this.webhooks.get(input.selector);
    if (!entry || entry.revoked) return { ok: false, reason: 'machine_unknown' };

    if (entry.provider === 'resend') return { ok: false, reason: 'machine_signature_invalid' };
    if (input.expectedProvider && entry.provider !== input.expectedProvider) {
      return { ok: false, reason: 'machine_account_mismatch' };
    }

    const validSignature =
      entry.provider === 'sanity'
        ? verifySanitySignature(
            input.signature,
            entry.verificationSecret,
            input.rawBody,
            this.now(),
          )
        : hexEqual(
            input.signature,
            createHmac('sha256', entry.verificationSecret).update(input.rawBody).digest('hex'),
          );
    if (!validSignature) {
      return { ok: false, reason: 'machine_signature_invalid' };
    }

    if (!secretsEqual(input.providerAccount, entry.providerAccount)) {
      return { ok: false, reason: 'machine_account_mismatch' };
    }

    if (input.expectedWorkspaceId && input.expectedWorkspaceId !== entry.workspaceId) {
      return { ok: false, reason: 'machine_workspace_mismatch' };
    }

    return {
      ok: true,
      selector: entry.selector,
      provider: entry.provider,
      workspaceId: entry.workspaceId,
      providerAccount: entry.providerAccount,
      actorId: entry.actorId,
    };
  }

  resolveResendWebhook(input: {
    selector: string;
    id: string;
    timestamp: string;
    signature: string;
    rawBody: Buffer;
  }): WebhookResolution {
    const entry = this.webhooks.get(input.selector);
    if (!entry || entry.revoked) return { ok: false, reason: 'machine_unknown' };
    if (entry.provider !== 'resend') return { ok: false, reason: 'machine_account_mismatch' };
    if (!verifyResendSignature(input, entry.verificationSecret, this.now())) {
      return { ok: false, reason: 'machine_signature_invalid' };
    }
    return {
      ok: true,
      selector: entry.selector,
      provider: entry.provider,
      providerAccount: entry.providerAccount,
      workspaceId: entry.workspaceId,
      actorId: entry.actorId,
    };
  }

  resendForWorkspace(workspaceId: string): { providerAccount: string } | undefined {
    const matches = [...this.webhooks.values()].filter(
      (entry) => !entry.revoked && entry.provider === 'resend' && entry.workspaceId === workspaceId,
    );
    return matches.length === 1 ? { providerAccount: matches[0]!.providerAccount } : undefined;
  }

  /** Internal-only provider configuration lookup; never accepts caller-supplied workspace context. */
  sanityForWorkspace(workspaceId: string): SanityMachineIntegration | undefined {
    const matches = [...this.webhooks.values()].filter(
      (entry) =>
        !entry.revoked &&
        entry.provider === 'sanity' &&
        entry.workspaceId === workspaceId &&
        entry.sanity !== undefined,
    );
    if (matches.length !== 1) return undefined;
    const entry = matches[0];
    if (!entry?.sanity) return undefined;
    return {
      selector: entry.selector,
      workspaceId: entry.workspaceId,
      providerAccount: entry.providerAccount,
      ...entry.sanity,
    };
  }

  /**
   * Internal read-only lookup for offline/ops tooling that must act as a
   * scheduler machine identity without replaying a scheduler secret (the manual
   * `catalogue:job -- reconcile` handler). Returns the identity only when
   * exactly one non-revoked scheduler entry both authorizes the workspace and
   * holds `scope`; zero or several matches fail closed, so a caller can never
   * pick a synthetic or guessed actor.
   */
  schedulerForWorkspace(
    workspaceId: string,
    scope: MachineScopeName,
  ): { selector: string; actorId: string } | undefined {
    const matches = [...this.schedulers.values()].filter(
      (entry) =>
        !entry.revoked && entry.workspaceIds.includes(workspaceId) && entry.scopes.includes(scope),
    );
    if (matches.length !== 1) return undefined;
    const entry = matches[0];
    if (!entry) return undefined;
    return { selector: entry.selector, actorId: entry.actorId };
  }

  resolveScheduler(input: ResolveSchedulerInput): SchedulerResolution {
    const entry = this.schedulers.get(input.selector);
    if (!entry || entry.revoked) return { ok: false, reason: 'machine_unknown' };

    if (!secretsEqual(input.secret, entry.secret)) {
      return { ok: false, reason: 'machine_signature_invalid' };
    }

    const workspaceIds = entry.workspaceIds;
    const scopes = entry.scopes;
    return {
      ok: true,
      actorId: entry.actorId,
      workspaceIds,
      scopes,
      authorizeWorkspace: (workspaceId) => workspaceIds.includes(workspaceId),
      hasScope: (scope) => scopes.includes(scope),
    };
  }
}

/** Builds the registry from `MACHINE_REGISTRY_JSON`. An unset value yields an empty (deny-all) registry. */
export function loadMachineRegistry(rawJson = process.env.MACHINE_REGISTRY_JSON): MachineRegistry {
  if (!rawJson || rawJson.trim() === '') {
    return new MachineRegistry({ webhooks: [], schedulers: [] });
  }
  const parsed: unknown = JSON.parse(rawJson);
  return new MachineRegistry(machineRegistryConfigSchema.parse(parsed));
}
