import postgres from 'postgres';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/app.js';
import { MachineRegistry } from '../src/machines/registry.js';
import { buildUnsubscribeToken } from '../src/routes/email.js';
import { createOutboxJobHandlers } from '../src/jobs/providers.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabaseClient, emailSuppressions, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';
import { DatabaseEmailStore, type ProviderEventInput } from '../src/email/store.js';
import { hashContact } from '../src/email/hash.js';

const migrationUrl = process.env.TEST_MIGRATION_DATABASE_URL;
if (migrationUrl || process.env.DB_TEST_ALLOW_DESTRUCTIVE || process.env.CI) {
  if (
    !migrationUrl ||
    process.env.DB_TEST_ALLOW_DESTRUCTIVE !== '1' ||
    !decodeURIComponent(new URL(migrationUrl).pathname).endsWith('_test')
  )
    throw new Error('Email tests require a disposable _test database and destructive-test opt-in.');
}
const A = '10000000-0000-4000-8000-000000000871';
const B = '10000000-0000-4000-8000-000000000872';
const ACTOR = '20000000-0000-4000-8000-000000000871';
const LEAD = '30000000-0000-4000-8000-000000000871';
const CONTACT = hashContact('customer@example.test', 'integration-contact-hash-secret');

describe.skipIf(!migrationUrl)('email persistence with restricted runtime RLS', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let store: DatabaseEmailStore;
  beforeAll(async () => {
    await applyMigrations({ connectionString: migrationUrl!, ssl: false });
    admin = postgres(migrationUrl!, { max: 1, prepare: false, ssl: false });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe("ALTER ROLE app_runtime PASSWORD 'local_ci_runtime_password'");
    });
    // Provider ids are unique per workspace/account and persist between local
    // runs; removing the sites cascades every email row from the last run.
    await admin`delete from app.workspaces where id in (${A}, ${B})`;
    await admin`insert into app.workspaces(id, slug, name) values (${A}, 'ci-email-a', 'Email A'), (${B}, 'ci-email-b', 'Email B') on conflict do nothing`;
    await admin`insert into app.leads(id, workspace_id, lead_type, status, consent_version) values (${LEAD}, ${A}, 'sim_order', 'incomplete', 'privacy-v2') on conflict do nothing`;
    const runtime = new URL(migrationUrl!);
    runtime.username = 'app_runtime';
    runtime.password = 'local_ci_runtime_password';
    database = createDatabaseClient({
      connectionString: runtime.toString(),
      ssl: false,
      maxConnections: 4,
    });
    store = new DatabaseEmailStore(database);
  });
  afterAll(async () => {
    await database?.close();
    await admin?.end();
  });

  async function prepared(workspaceId = A, providerAccount = 'account-a') {
    const messageId = crypto.randomUUID();
    await store.prepareDelivery({
      workspaceId,
      actorId: ACTOR,
      messageId,
      template: 'order_status',
      messageClass: 'transactional',
      contactHash: CONTACT,
      provider: 'resend',
      providerAccount,
    });
    return messageId;
  }
  function event(
    messageId: string,
    overrides: Partial<ProviderEventInput> = {},
  ): ProviderEventInput {
    return {
      workspaceId: A,
      actorId: ACTOR,
      provider: 'resend',
      providerAccount: 'account-a',
      providerEventId: crypto.randomUUID(),
      providerMessageId: `resend-${messageId}`,
      messageId,
      eventType: 'bounce',
      hardBounce: true,
      contactHash: CONTACT,
      receivedAt: new Date(),
      ...overrides,
    };
  }

  it('reproduces the old invalid actor failure; valid scheduler checks do not fail RLS', async () => {
    await admin`insert into app.email_suppressions(workspace_id, contact_hash, reason) values (${A}, 'old-actor-trigger', 'manual') on conflict do nothing`;
    await expect(
      store.checkTransactional({
        workspaceId: A,
        actorId: 'system:email',
        contactHash: 'old-actor-trigger',
      }),
    ).rejects.toThrow();
    expect(
      await store.checkTransactional({
        workspaceId: A,
        actorId: ACTOR,
        contactHash: 'old-actor-trigger',
      }),
    ).toEqual({ eligible: false, reason: 'manual' });
    expect(
      await store.checkTransactional({
        workspaceId: B,
        actorId: ACTOR,
        contactHash: 'old-actor-trigger',
      }),
    ).toEqual({ eligible: true });
    expect(
      await store.checkMarketing({ workspaceId: A, actorId: ACTOR, contactHash: 'no-consent' }),
    ).toEqual({ eligible: false, reason: 'no_recorded_consent' });
  });
  it('records public unsubscribe under the signed tenant UUID and blocks later marketing only', async () => {
    const hash = hashContact('unsubscribe@example.test', 'integration-contact-hash-secret');
    await admin`insert into app.marketing_consents(workspace_id, lead_id, contact_hash, marketing_opt_in, version, captured_at) values (${A}, ${LEAD}, ${hash}, true, '1', now() - interval '1 minute')`;
    expect(
      (await store.checkMarketing({ workspaceId: A, actorId: ACTOR, contactHash: hash })).eligible,
    ).toBe(true);
    await store.recordUnsubscribe({
      workspaceId: A,
      leadId: LEAD,
      contactHash: hash,
      version: '2',
      now: new Date(),
    });
    expect(
      await store.checkMarketing({ workspaceId: A, actorId: ACTOR, contactHash: hash }),
    ).toEqual({ eligible: false, reason: 'opted_out' });
    expect(
      await store.checkTransactional({ workspaceId: A, actorId: ACTOR, contactHash: hash }),
    ).toEqual({ eligible: true });
  });
  it('deduplicates hard bounces and records exactly one suppression for the contact', async () => {
    const messageId = await prepared();
    const input = event(messageId);
    expect(await store.applyProviderEvent(input)).toBe('applied');
    expect(await store.applyProviderEvent(input)).toBe('duplicate');
    const events =
      await admin`select * from app.email_provider_events where workspace_id = ${A} and provider_event_id = ${input.providerEventId}`;
    expect(events).toHaveLength(1);
    expect(
      await admin`select * from app.email_suppressions where workspace_id = ${A} and contact_hash = ${CONTACT} and reason = 'hard_bounce'`,
    ).toHaveLength(1);
    expect(
      (await store.checkTransactional({ workspaceId: A, actorId: ACTOR, contactHash: CONTACT }))
        .eligible,
    ).toBe(false);
  });
  it('cannot correlate foreign tenants, accounts, recipients or conflicting provider IDs', async () => {
    const messageId = await prepared();
    const input = event(messageId);
    for (const override of [
      { workspaceId: B },
      { providerAccount: 'account-b' },
      { contactHash: 'foreign-hash' },
    ]) {
      expect(await store.applyProviderEvent({ ...input, ...override })).toBe('invalid');
    }
    expect(await store.applyProviderEvent(input)).toBe('applied');
    expect(
      await store.applyProviderEvent(
        event(messageId, { providerMessageId: 'different-provider-id' }),
      ),
    ).toBe('invalid');
    expect(
      await admin`select * from app.email_provider_events where message_id = ${messageId}`,
    ).toHaveLength(1);
  });
  it('supports early events, provider-ID lookup and late delivery without erasing complaints', async () => {
    const messageId = await prepared();
    const input = event(messageId, { eventType: 'complaint' });
    expect(await store.applyProviderEvent(input)).toBe('applied');
    await store.recordDeliveryResult({
      workspaceId: A,
      actorId: ACTOR,
      messageId,
      result: { status: 'delivered', providerId: input.providerMessageId },
    });
    expect(
      await store.applyProviderEvent(
        event(messageId, { messageId: undefined, eventType: 'delivered' }),
      ),
    ).toBe('applied');
    expect(
      (await store.listDelivery(A, ACTOR)).find((row) => row.messageId === messageId)?.status,
    ).toBe('complained');
  });
  it('namespaces duplicate event IDs by account and workspace', async () => {
    const first = await prepared(A, 'account-a');
    const second = await prepared(A, 'account-b');
    const id = crypto.randomUUID();
    expect(await store.applyProviderEvent(event(first, { providerEventId: id }))).toBe('applied');
    expect(
      await store.applyProviderEvent(
        event(second, { workspaceId: A, providerAccount: 'account-b', providerEventId: id }),
      ),
    ).toBe('applied');
  });
  it('runs signed native events and no-login unsubscribe through the actual app and runtime role', async () => {
    const secret = 'integration-contact-hash-secret';
    const signingKey = Buffer.from('integration-native-webhook-key-32!');
    const messageId = await prepared();
    const app = createApp({
      email: {
        store,
        sessionVerifier: { verify: async () => undefined },
        contactHashSecret: () => secret,
        unsubscribeConsentVersion: '2',
        authorizeDeliveryView: async () => false,
        registry: new MachineRegistry({
          schedulers: [],
          webhooks: [
            {
              selector: 'runtime',
              provider: 'resend',
              providerAccount: 'account-a',
              workspaceId: A,
              actorId: ACTOR,
              verificationSecret: 'whsec_' + signingKey.toString('base64'),
              revoked: false,
            },
          ],
        }),
      },
    });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const body = JSON.stringify({
        type: 'email.delivered',
        created_at: new Date().toISOString(),
        workspaceId: B,
        data: {
          email_id: `resend-${messageId}`,
          to: ['customer@example.test'],
          tags: { cp_message_id: messageId },
        },
      });
      const id = crypto.randomUUID(),
        timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = createHmac('sha256', signingKey)
        .update(`${id}.${timestamp}.${body}`)
        .digest('base64');
      const response = await fetch(`${origin}/api/v1/webhooks/resend/runtime`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'svix-id': id,
          'svix-timestamp': timestamp,
          'svix-signature': `v1,${signature}`,
        },
        body,
      });
      expect(response.status).toBe(200);
      expect(
        (await store.listDelivery(A, ACTOR)).find((row) => row.messageId === messageId)?.status,
      ).toBe('delivered');
      expect((await store.listDelivery(B, ACTOR)).some((row) => row.messageId === messageId)).toBe(
        false,
      );
      const token = buildUnsubscribeToken(secret, {
        workspaceId: A,
        leadId: LEAD,
        contactHash: CONTACT,
      });
      expect((await fetch(`${origin}/api/v1/email/unsubscribe?token=${token}`)).status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it('prepares and records a Resend send with the configured account and refuses unmapped workspaces', async () => {
    const hash = hashContact('resend@example.test', 'integration-contact-hash-secret');
    await admin`insert into app.marketing_consents(workspace_id, lead_id, contact_hash, marketing_opt_in, version, captured_at) values (${A}, ${LEAD}, ${hash}, true, '2', now())`;
    const send = vi.fn<typeof fetch>(async () => Response.json({ id: 'native-provider-result' }));
    vi.stubGlobal('fetch', send);
    try {
      const handlers = createOutboxJobHandlers(
        {
          EMAIL_PROVIDER: 'resend',
          RESEND_API_KEY: 'synthetic-key',
          RESEND_ACCOUNT_ID: 'account-a',
          RESEND_FROM_EMAIL: 'sender@example.test',
          RESEND_FROM_NAME: 'Synthetic',
          NODE_ENV: 'test',
          MACHINE_REGISTRY_JSON: JSON.stringify({
            schedulers: [],
            webhooks: [
              {
                selector: 'outbox',
                provider: 'resend',
                providerAccount: 'account-a',
                workspaceId: A,
                actorId: ACTOR,
                verificationSecret:
                  'whsec_' + Buffer.from('synthetic-webhook-secret-32bytes!!').toString('base64'),
              },
            ],
          }),
        },
        store,
      );
      const messageId = crypto.randomUUID();
      const job = {
        id: crypto.randomUUID(),
        workspaceId: A,
        actorId: ACTOR,
        jobType: 'abandoned_form_marketing_email',
        messageId,
        payloadVersion: 1,
        payload: {
          leadId: LEAD,
          toAddress: 'resend@example.test',
          contactHash: hash,
          unsubscribeUrl: 'https://example.test/unsubscribe',
        },
        attempts: 1,
        leaseOwnerId: crypto.randomUUID(),
      };
      expect(await handlers.get(job.jobType)?.(job)).toMatchObject({
        status: 'completed',
        providerId: 'native-provider-result',
      });
      expect(
        (await store.listDelivery(A, ACTOR)).find((row) => row.messageId === messageId),
      ).toMatchObject({ status: 'sent', providerId: 'native-provider-result' });
      const missingMapping = createOutboxJobHandlers(
        {
          EMAIL_PROVIDER: 'resend',
          RESEND_API_KEY: 'synthetic-key',
          RESEND_FROM_EMAIL: 'sender@example.test',
          RESEND_FROM_NAME: 'Synthetic',
          NODE_ENV: 'test',
        },
        store,
      );
      await expect(
        missingMapping.get(job.jobType)?.({ ...job, messageId: crypto.randomUUID() }),
      ).rejects.toMatchObject({ code: 'email_account_not_configured' });
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('stores the template version a site-content email was rendered from, or null', async () => {
    const versioned = crypto.randomUUID();
    const plain = crypto.randomUUID();
    for (const [messageId, templateVersion] of [
      [versioned, 2],
      [plain, undefined],
    ] as const) {
      await store.prepareDelivery({
        workspaceId: A,
        actorId: ACTOR,
        messageId,
        template: 'dispatched',
        templateVersion,
        messageClass: 'transactional',
        contactHash: CONTACT,
        provider: 'resend',
        providerAccount: 'account-a',
      });
    }
    // A retry of the same logical message keeps the version it was first written with.
    await store.prepareDelivery({
      workspaceId: A,
      actorId: ACTOR,
      messageId: versioned,
      template: 'dispatched',
      templateVersion: 2,
      messageClass: 'transactional',
      contactHash: CONTACT,
      provider: 'resend',
      providerAccount: 'account-a',
    });
    const rows = await admin<{ message_id: string; template_version: number | null }[]>`
      select message_id, template_version from app.email_messages
      where workspace_id = ${A} and message_id in (${versioned}, ${plain})`;
    expect(rows.find((row) => row.message_id === versioned)?.template_version).toBe(2);
    expect(rows.find((row) => row.message_id === plain)?.template_version).toBeNull();
  });
  it('sends a queued customer mail from its own sender with no EMAIL_SENDERS_JSON entry and records its version', async () => {
    const send = vi.fn<typeof fetch>(async () => Response.json({ id: 'customer-mail-id' }));
    vi.stubGlobal('fetch', send);
    try {
      const handlers = createOutboxJobHandlers(
        {
          EMAIL_PROVIDER: 'resend',
          RESEND_API_KEY: 'synthetic-key',
          RESEND_ACCOUNT_ID: 'account-a',
          RESEND_FROM_EMAIL: 'deployment@example.test',
          RESEND_FROM_NAME: 'Deployment',
          NODE_ENV: 'test',
        },
        store,
      );
      const messageId = crypto.randomUUID();
      // Other tests suppress CONTACT; this customer is a different address.
      const customer = hashContact('customer-mail@example.test', 'integration-contact-hash-secret');
      const job = {
        id: crypto.randomUUID(),
        workspaceId: A,
        actorId: ACTOR,
        jobType: 'lead_customer_email',
        messageId,
        payloadVersion: 1,
        payload: {
          leadId: LEAD,
          template: 'order_received',
          templateVersion: 3,
          toAddress: 'customer-mail@example.test',
          contactHash: customer,
          sender: { fromName: 'Site A', fromAddress: 'orders@site-a.example.test' },
          rendered: { subject: 'We have your order', html: '<p>Thanks</p>', text: 'Thanks' },
        },
        attempts: 1,
        leaseOwnerId: crypto.randomUUID(),
      };
      expect(await handlers.get(job.jobType)?.(job)).toMatchObject({
        status: 'completed',
        providerId: 'customer-mail-id',
      });
      expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body))).toMatchObject({
        from: 'Site A <orders@site-a.example.test>',
        subject: 'We have your order',
        text: 'Thanks',
      });
      const [row] = await admin<{ template_version: number; provider_account: string }[]>`
        select template_version, provider_account from app.email_messages
        where workspace_id = ${A} and message_id = ${messageId}`;
      expect(row).toEqual({ template_version: 3, provider_account: 'account-a' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('does not create permanent suppression for temporary bounces', async () => {
    const hash = hashContact('temporary@example.test', 'integration-contact-hash-secret');
    const messageId = crypto.randomUUID();
    await store.prepareDelivery({
      workspaceId: A,
      actorId: ACTOR,
      messageId,
      template: 'order_status',
      messageClass: 'transactional',
      contactHash: hash,
      provider: 'resend',
      providerAccount: 'account-a',
    });
    expect(
      await store.applyProviderEvent(event(messageId, { hardBounce: false, contactHash: hash })),
    ).toBe('applied');
    expect(
      await store.checkTransactional({ workspaceId: A, actorId: ACTOR, contactHash: hash }),
    ).toEqual({ eligible: true });
    expect(
      (await store.listDelivery(A, ACTOR)).find((row) => row.messageId === messageId)?.status,
    ).toBe('uncertain');
    expect(
      await store.applyProviderEvent(
        event(messageId, { eventType: 'delivered', contactHash: hash }),
      ),
    ).toBe('applied');
    expect(
      (await store.listDelivery(A, ACTOR)).find((row) => row.messageId === messageId)?.status,
    ).toBe('delivered');
  });
  it('denies missing context and rolls back attempted suppression on transaction failure', async () => {
    await expect(database.db.select().from(emailSuppressions)).resolves.toEqual([]);
    const hash = crypto.randomUUID();
    await expect(
      database.withTenantTx({ workspaceId: A, actorId: ACTOR }, async (tx) => {
        await tx
          .insert(emailSuppressions)
          .values({ workspaceId: A, contactHash: hash, reason: 'manual' });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(
      await store.checkTransactional({ workspaceId: A, actorId: ACTOR, contactHash: hash }),
    ).toEqual({ eligible: true });
  });
});
