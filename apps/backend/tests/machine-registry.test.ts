import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  MachineRegistry,
  loadMachineRegistry,
  type MachineRegistryConfig,
} from '../src/machines/registry.js';

const WORKSPACE_A = '10000000-0000-4000-8000-000000000101';
const WORKSPACE_B = '10000000-0000-4000-8000-000000000102';
const WEBHOOK_SECRET = 'webhook-verification-secret-0001';
const SCHEDULER_SECRET = 'scheduler-shared-secret-000000001';
const SCHEDULER_ACTOR = '10000000-0000-4000-8000-000000000199';
const WEBHOOK_ACTOR = '10000000-0000-4000-8000-000000000198';

const config: MachineRegistryConfig = {
  webhooks: [
    {
      selector: 'sanity-site-1',
      provider: 'sanity',
      providerAccount: 'acct_site1',
      workspaceId: WORKSPACE_A,
      actorId: WEBHOOK_ACTOR,
      verificationSecret: WEBHOOK_SECRET,
      revoked: false,
    },
    {
      selector: 'sanity-retired',
      provider: 'sanity',
      providerAccount: 'acct_old',
      workspaceId: WORKSPACE_A,
      actorId: WEBHOOK_ACTOR,
      verificationSecret: WEBHOOK_SECRET,
      revoked: true,
    },
  ],
  schedulers: [
    {
      selector: 'outbox-runner',
      secret: SCHEDULER_SECRET,
      actorId: SCHEDULER_ACTOR,
      workspaceIds: [WORKSPACE_A],
      scopes: ['outbox:run'],
      revoked: false,
    },
  ],
};

const NOW_MS = Date.parse('2026-09-16T00:00:00.000Z');
const registry = new MachineRegistry(config, () => NOW_MS);
const rawBody = JSON.stringify({ event: 'offer.published', id: 'offer_1' });
// Sanity signs with a millisecond Unix timestamp.
const timestamp = String(NOW_MS);
const sign = (secret: string, body = rawBody) =>
  `t=${timestamp},v1=${createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('base64url')}`;
const validSignature = sign(WEBHOOK_SECRET);

describe('machine webhook resolution', () => {
  it('resolves a registered webhook with a valid signature and matching account', () => {
    const result = registry.resolveWebhook({
      selector: 'sanity-site-1',
      providerAccount: 'acct_site1',
      signature: validSignature,
      rawBody,
    });
    expect(result).toEqual({
      ok: true,
      selector: 'sanity-site-1',
      provider: 'sanity',
      workspaceId: WORKSPACE_A,
      providerAccount: 'acct_site1',
      actorId: WEBHOOK_ACTOR,
    });
  });

  it('fails closed on an unknown selector', () => {
    expect(
      registry.resolveWebhook({
        selector: 'does-not-exist',
        providerAccount: 'acct_site1',
        signature: validSignature,
        rawBody,
      }),
    ).toEqual({ ok: false, reason: 'machine_unknown' });
  });

  it('treats a revoked selector as unknown', () => {
    expect(
      registry.resolveWebhook({
        selector: 'sanity-retired',
        providerAccount: 'acct_old',
        signature: sign(WEBHOOK_SECRET),
        rawBody,
      }),
    ).toEqual({ ok: false, reason: 'machine_unknown' });
  });

  it('rejects an invalid signature', () => {
    expect(
      registry.resolveWebhook({
        selector: 'sanity-site-1',
        providerAccount: 'acct_site1',
        signature: sign('wrong-secret'),
        rawBody,
      }),
    ).toEqual({ ok: false, reason: 'machine_signature_invalid' });
  });

  it('rejects a signature over a tampered body', () => {
    expect(
      registry.resolveWebhook({
        selector: 'sanity-site-1',
        providerAccount: 'acct_site1',
        signature: validSignature,
        rawBody: `${rawBody} `,
      }).ok,
    ).toBe(false);
  });

  it('rejects the wrong provider account', () => {
    expect(
      registry.resolveWebhook({
        selector: 'sanity-site-1',
        providerAccount: 'acct_other',
        signature: validSignature,
        rawBody,
      }),
    ).toEqual({ ok: false, reason: 'machine_account_mismatch' });
  });

  it('fails closed on cross-workspace confusion', () => {
    expect(
      registry.resolveWebhook({
        selector: 'sanity-site-1',
        providerAccount: 'acct_site1',
        signature: validSignature,
        rawBody,
        expectedWorkspaceId: WORKSPACE_B,
      }),
    ).toEqual({ ok: false, reason: 'machine_workspace_mismatch' });
  });
});

describe('machine scheduler resolution', () => {
  it('resolves a scheduler identity with the correct secret', () => {
    const result = registry.resolveScheduler({
      selector: 'outbox-runner',
      secret: SCHEDULER_SECRET,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.actorId).toBe(SCHEDULER_ACTOR);
    expect(result.workspaceIds).toEqual([WORKSPACE_A]);
    expect(result.hasScope('outbox:run')).toBe(true);
    expect(result.hasScope('reconcile:run')).toBe(false);
    expect(result.authorizeWorkspace(WORKSPACE_A)).toBe(true);
    expect(result.authorizeWorkspace(WORKSPACE_B)).toBe(false);
  });

  it('rejects an invalid scheduler secret', () => {
    expect(
      registry.resolveScheduler({ selector: 'outbox-runner', secret: 'nope-nope-nope-000000001' }),
    ).toEqual({
      ok: false,
      reason: 'machine_signature_invalid',
    });
  });

  it('fails closed on an unknown scheduler selector', () => {
    expect(registry.resolveScheduler({ selector: 'ghost', secret: SCHEDULER_SECRET })).toEqual({
      ok: false,
      reason: 'machine_unknown',
    });
  });
});

describe('scheduler identity lookup for offline tooling', () => {
  const reconcileScheduler: MachineRegistryConfig['schedulers'][number] = {
    selector: 'reconcile-runner',
    secret: 'reconcile-secret-000000000000001',
    actorId: SCHEDULER_ACTOR,
    workspaceIds: [WORKSPACE_A],
    scopes: ['reconcile:run'],
    revoked: false,
  };
  const reconcileConfig: MachineRegistryConfig = {
    webhooks: [],
    schedulers: [reconcileScheduler],
  };

  it('returns the registry actor for a workspace the identity authorizes with the scope', () => {
    const local = new MachineRegistry(reconcileConfig);
    expect(local.schedulerForWorkspace(WORKSPACE_A, 'reconcile:run')).toEqual({
      selector: 'reconcile-runner',
      actorId: SCHEDULER_ACTOR,
    });
  });

  it('returns undefined without a matching scope or workspace', () => {
    const local = new MachineRegistry(reconcileConfig);
    expect(local.schedulerForWorkspace(WORKSPACE_A, 'outbox:run')).toBeUndefined();
    expect(local.schedulerForWorkspace(WORKSPACE_B, 'reconcile:run')).toBeUndefined();
  });

  it('ignores revoked identities and fails closed on ambiguity', () => {
    const revoked = new MachineRegistry({
      webhooks: [],
      schedulers: [{ ...reconcileScheduler, revoked: true }],
    });
    expect(revoked.schedulerForWorkspace(WORKSPACE_A, 'reconcile:run')).toBeUndefined();

    const ambiguous = new MachineRegistry({
      webhooks: [],
      schedulers: [
        reconcileScheduler,
        {
          ...reconcileScheduler,
          selector: 'reconcile-runner-two',
          secret: 'reconcile-secret-000000000000002',
        },
      ],
    });
    expect(ambiguous.schedulerForWorkspace(WORKSPACE_A, 'reconcile:run')).toBeUndefined();
  });
});

describe('registry loading', () => {
  it('produces a deny-all registry when no configuration is provided', () => {
    const empty = loadMachineRegistry('');
    expect(
      empty.resolveWebhook({
        selector: 'sanity-site-1',
        providerAccount: 'acct_site1',
        signature: validSignature,
        rawBody,
      }),
    ).toEqual({ ok: false, reason: 'machine_unknown' });
  });

  it('parses and validates registry JSON', () => {
    const loaded = loadMachineRegistry(JSON.stringify(config));
    expect(
      loaded.resolveScheduler({ selector: 'outbox-runner', secret: SCHEDULER_SECRET }).ok,
    ).toBe(true);
  });

  it('rejects structurally invalid registry JSON', () => {
    expect(() => loadMachineRegistry(JSON.stringify({ webhooks: [{ selector: 'x' }] }))).toThrow();
  });

  it('rejects a webhook entry that omits the required actorId', () => {
    expect(() =>
      loadMachineRegistry(
        JSON.stringify({
          webhooks: [
            {
              selector: 'sanity-site-1',
              provider: 'sanity',
              providerAccount: 'acct_site1',
              workspaceId: WORKSPACE_A,
              verificationSecret: WEBHOOK_SECRET,
            },
          ],
        }),
      ),
    ).toThrow();
  });
});
