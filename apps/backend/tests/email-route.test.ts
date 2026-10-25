import type { Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/app.js';
import { MachineRegistry } from '../src/machines/registry.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildUnsubscribeToken, type EmailRouteDependencies } from '../src/routes/email.js';
import { hashContact } from '../src/email/hash.js';
import type {
  ApplyProviderEventOutcome,
  DeliveryStatusRow,
  DeliverySummary,
  EmailStore,
  ProviderEventInput,
  QueueEmailMessageInput,
} from '../src/email/store.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const LEAD = '22222222-2222-4222-8222-222222222222';
const SECRET = 'a-sufficiently-long-contact-hash-secret';
const WEBHOOK_SECRET =
  'whsec_' + Buffer.from('native-resend-test-secret-32bytes!').toString('base64');
const ACTOR = '33333333-3333-4333-8333-333333333333';
const MESSAGE = '44444444-4444-4444-8444-444444444444';
function signed(body: string, id = 'evt-1', timestamp = Math.floor(Date.now() / 1000).toString()) {
  const signature = createHmac('sha256', Buffer.from(WEBHOOK_SECRET.slice(6), 'base64'))
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64');
  return {
    'content-type': 'application/json',
    'svix-id': id,
    'svix-timestamp': timestamp,
    'svix-signature': `v1,${signature}`,
  };
}
function event(type = 'email.bounced') {
  return {
    type,
    created_at: new Date().toISOString(),
    data: {
      email_id: 'resend-id-1',
      to: ['bounced@example.com'],
      tags: { cp_message_id: MESSAGE },
      bounce: { type: 'Permanent' },
    },
  };
}

class FakeEmailStore implements EmailStore {
  unsubscribed: Array<{ contactHash: string; leadId?: string }> = [];
  events: ProviderEventInput[] = [];
  private readonly seenEventIds = new Set<string>();

  async checkTransactional() {
    return { eligible: true };
  }
  async checkMarketing() {
    return { eligible: true };
  }
  async queueMessage(_input: QueueEmailMessageInput): Promise<void> {}
  async applyProviderEvent(input: ProviderEventInput): Promise<ApplyProviderEventOutcome> {
    if (this.seenEventIds.has(input.providerEventId)) return 'duplicate';
    this.seenEventIds.add(input.providerEventId);
    this.events.push(input);
    return 'applied';
  }
  async listDelivery(): Promise<DeliveryStatusRow[]> {
    return [];
  }
  async deliverySummary(): Promise<DeliverySummary> {
    return { sent: 0, delivered: 0, failed: 0, uncertain: 0 };
  }
  async recordUnsubscribe(input: { contactHash: string; leadId?: string }): Promise<void> {
    this.unsubscribed.push({ contactHash: input.contactHash, leadId: input.leadId });
  }
}

describe('email routes', () => {
  let server: Server;
  let baseUrl: string;
  let store: FakeEmailStore;

  beforeEach(async () => {
    store = new FakeEmailStore();
    const dependencies: EmailRouteDependencies = {
      store,
      sessionVerifier: { verify: async () => undefined },
      contactHashSecret: () => SECRET,
      unsubscribeConsentVersion: 'test-1',
      registry: new MachineRegistry({
        webhooks: [
          {
            selector: 'launch',
            provider: 'resend',
            providerAccount: 'account-a',
            workspaceId: WORKSPACE,
            actorId: ACTOR,
            verificationSecret: WEBHOOK_SECRET,
            revoked: false,
          },
          {
            selector: 'revoked',
            provider: 'resend',
            providerAccount: 'account-a',
            workspaceId: WORKSPACE,
            actorId: ACTOR,
            verificationSecret: 'retired-resend-secret',
            revoked: true,
          },
          {
            selector: 'other',
            provider: 'sanity',
            providerAccount: 'other',
            workspaceId: WORKSPACE,
            actorId: ACTOR,
            verificationSecret: 'other-provider-secret',
            revoked: false,
          },
        ],
        schedulers: [],
      }),
      authorizeDeliveryView: async () => true,
    };
    const app = createApp({ email: dependencies });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected TCP server');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('unsubscribes without any login given a valid signed token', async () => {
    const contactHash = hashContact('lead@example.com', SECRET);
    const token = buildUnsubscribeToken(SECRET, {
      workspaceId: WORKSPACE,
      contactHash,
      leadId: LEAD,
    });

    const response = await fetch(
      `${baseUrl}/api/v1/email/unsubscribe?token=${encodeURIComponent(token)}`,
    );

    expect(response.status).toBe(200);
    expect(store.unsubscribed).toEqual([{ contactHash, leadId: LEAD }]);
  });

  it('rejects a tampered unsubscribe token', async () => {
    const contactHash = hashContact('lead@example.com', SECRET);
    const token = buildUnsubscribeToken(SECRET, {
      workspaceId: WORKSPACE,
      contactHash,
      leadId: LEAD,
    });
    const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');

    const response = await fetch(
      `${baseUrl}/api/v1/email/unsubscribe?token=${encodeURIComponent(tampered)}`,
    );

    expect(response.status).toBe(400);
    expect(store.unsubscribed).toHaveLength(0);
  });

  it('verifies native raw bytes and attributes events only to the registry tenant/account', async () => {
    const body = JSON.stringify({ ...event(), workspaceId: LEAD, actorId: LEAD });
    const response = await fetch(`${baseUrl}/api/v1/webhooks/resend/launch`, {
      method: 'POST',
      headers: signed(body),
      body,
    });
    expect(response.status).toBe(200);
    expect(store.events).toEqual([
      expect.objectContaining({
        workspaceId: WORKSPACE,
        actorId: ACTOR,
        provider: 'resend',
        providerAccount: 'account-a',
        providerMessageId: 'resend-id-1',
        messageId: MESSAGE,
        hardBounce: true,
        contactHash: hashContact('bounced@example.com', SECRET),
      }),
    ]);
  });

  it.each(['missing', 'altered', 'stale', 'future', 'wrong-key', 'malformed-timestamp'])(
    'rejects invalid native authentication (%s)',
    async (mode) => {
      const body = JSON.stringify(event());
      const headers = signed(body);
      if (mode === 'missing') headers['svix-signature'] = '';
      if (mode === 'wrong-key') headers['svix-signature'] = 'v1,d3Jvbmc=';
      if (mode === 'stale' || mode === 'future')
        Object.assign(
          headers,
          signed(
            body,
            'evt-1',
            String(Math.floor(Date.now() / 1000) + (mode === 'stale' ? -301 : 301)),
          ),
        );
      if (mode === 'malformed-timestamp') headers['svix-timestamp'] += 'garbage';
      const response = await fetch(`${baseUrl}/api/v1/webhooks/resend/launch`, {
        method: 'POST',
        headers,
        body: mode === 'altered' ? body + ' ' : body,
      });
      expect(response.status).toBe(401);
      expect(store.events).toEqual([]);
    },
  );
  it.each(['unknown', 'revoked', 'other'])('rejects a %s selector', async (selector) => {
    const body = JSON.stringify(event());
    const response = await fetch(`${baseUrl}/api/v1/webhooks/resend/${selector}`, {
      method: 'POST',
      headers: signed(body),
      body,
    });
    expect(response.status).toBe(401);
    expect(store.events).toEqual([]);
  });
  it('accepts a valid signature among rotated signatures, including Unicode and whitespace', async () => {
    const body = JSON.stringify({ ...event(), subject: 'Montréal 🇨🇦' }, null, 2);
    const headers = signed(body);
    headers['svix-signature'] = `v2,ignored v1,wrong ${headers['svix-signature']}`;
    const response = await fetch(`${baseUrl}/api/v1/webhooks/resend/launch`, {
      method: 'POST',
      headers,
      body,
    });
    expect(response.status).toBe(200);
  });
  it('deduplicates provider redelivery by the signed event id', async () => {
    const body = JSON.stringify(event());
    const send = () =>
      fetch(`${baseUrl}/api/v1/webhooks/resend/launch`, {
        method: 'POST',
        headers: signed(body),
        body,
      });
    expect(await (await send()).json()).toEqual({ status: 'applied' });
    expect(await (await send()).json()).toEqual({ status: 'duplicate' });
    expect(store.events).toHaveLength(1);
  });
  it('does not suppress temporary bounces', async () => {
    const payload = event();
    payload.data.bounce.type = 'Transient';
    const body = JSON.stringify(payload);
    expect(
      (
        await fetch(`${baseUrl}/api/v1/webhooks/resend/launch`, {
          method: 'POST',
          headers: signed(body),
          body,
        })
      ).status,
    ).toBe(200);
    expect(store.events[0]?.hardBounce).toBe(false);
  });
  it.each(['email.opened', 'contact.created'])(
    'acknowledges unused native events (%s)',
    async (type) => {
      const body = JSON.stringify(event(type));
      const response = await fetch(`${baseUrl}/api/v1/webhooks/resend/launch`, {
        method: 'POST',
        headers: signed(body),
        body,
      });
      expect(await response.json()).toEqual({ status: 'ignored' });
      expect(store.events).toEqual([]);
    },
  );
  it('retires the body-selected normalized shared-secret protocol', async () => {
    const response = await fetch(`${baseUrl}/api/v1/email/webhook/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-email-webhook-secret': WEBHOOK_SECRET },
      body: JSON.stringify({ eventType: 'bounce', workspaceId: WORKSPACE }),
    });
    expect(response.status).toBe(404);
    expect(store.events).toEqual([]);
  });
  it.each(['invalid-json', 'non-json', 'oversized', 'invalid-message-tag', 'multiple-recipients'])(
    'rejects invalid native content (%s)',
    async (mode) => {
      const payload = event();
      if (mode === 'invalid-message-tag') payload.data.tags.cp_message_id = 'not-uuid';
      if (mode === 'multiple-recipients') payload.data.to.push('other@example.com');
      let body = mode === 'invalid-json' ? '{' : JSON.stringify(payload);
      if (mode === 'oversized') body += ' '.repeat(65536);
      const headers = signed(body);
      if (mode === 'non-json') headers['content-type'] = 'text/plain';
      const response = await fetch(`${baseUrl}/api/v1/webhooks/resend/launch`, {
        method: 'POST',
        headers,
        body,
      });
      expect(response.status).toBe(400);
      expect(store.events).toEqual([]);
    },
  );
});
