import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResendEmailAdapter } from './messaging.js';
import { z } from 'zod';

afterEach(() => vi.unstubAllGlobals());
describe('Resend send correlation', () => {
  it('uses the stable logical id for retry idempotency and native event correlation', async () => {
    const send = vi.fn<typeof fetch>(async () => Response.json({ id: 'provider-email-id' }));
    vi.stubGlobal('fetch', send);
    const adapter = new ResendEmailAdapter({
      apiKey: 'synthetic-key',
      sender: { fromAddress: 'sender@example.test', fromName: 'Test' },
    });
    const message = {
      workspaceId: '11111111-1111-4111-8111-111111111111',
      messageId: '22222222-2222-4222-8222-222222222222',
      template: 'order_status' as const,
      toAddress: 'customer@example.test',
      reference: 'CP-TEST',
    };
    expect(await adapter.send(message)).toEqual({
      status: 'delivered',
      providerId: 'provider-email-id',
    });
    await adapter.send(message);
    const options = send.mock.calls.map((call) => call[1]!);
    expect(options.map((entry) => new Headers(entry.headers).get('Idempotency-Key'))).toEqual([
      `${message.workspaceId}/${message.messageId}`,
      `${message.workspaceId}/${message.messageId}`,
    ]);
    expect(JSON.parse(String(options[0]!.body))).toMatchObject({
      tags: [{ name: 'cp_message_id', value: message.messageId }],
    });
    // Bounded and never redirected: a hung provider becomes an "uncertain" outcome.
    expect(options[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(options[0]!.redirect).toBe('error');
  });
});

describe('sender identification', () => {
  it.each([
    'order_acknowledgement',
    'order_status',
    'order_awaiting_customer',
    'order_dispatch',
    'order_activation',
    'tracking_otp',
    'abandoned_form_marketing',
  ] as const)('every %s email names the sender and its mailing address', async (template) => {
    const send = vi.fn<typeof fetch>(async () => Response.json({ id: 'provider-email-id' }));
    vi.stubGlobal('fetch', send);
    const adapter = new ResendEmailAdapter({
      apiKey: 'synthetic-key',
      sender: { fromAddress: 'sender@example.test', fromName: 'Test' },
    });
    await adapter.send({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      messageId: '22222222-2222-4222-8222-222222222222',
      template,
      toAddress: 'customer@example.test',
      reference: 'CP-TEST',
      unsubscribeUrl: 'https://canadianplans.com/unsubscribe/token',
    });
    const body = z
      .object({ text: z.string() })
      .parse(JSON.parse(String(send.mock.calls[0]?.[1]?.body)));
    expect(body.text).toContain('GT Sales');
    if (template === 'order_acknowledgement')
      expect(body.text).toContain('Nothing has been charged');
  });
});

describe('order_dispatch copy', () => {
  async function sentBody(variables?: Record<string, string>) {
    const send = vi.fn<typeof fetch>(async () => Response.json({ id: 'provider-email-id' }));
    vi.stubGlobal('fetch', send);
    const adapter = new ResendEmailAdapter({
      apiKey: 'synthetic-key',
      sender: { fromAddress: 'sender@example.test', fromName: 'Test' },
    });
    await adapter.send({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      messageId: '22222222-2222-4222-8222-222222222222',
      template: 'order_dispatch',
      toAddress: 'customer@example.test',
      reference: 'CP-TEST',
      ...(variables ? { variables } : {}),
    });
    return z
      .object({ subject: z.string(), text: z.string() })
      .parse(JSON.parse(String(send.mock.calls[0]?.[1]?.body)));
  }

  it('describes a provider handoff, never a shipment, and omits an absent reference', async () => {
    const body = await sentBody({ courier: 'Provider handoff (no shipment)' });
    expect(body.subject).not.toMatch(/shipped/i);
    expect(body.subject).toContain('handed to your provider');
    expect(body.text).not.toContain('n/a');
    expect(body.text).not.toContain('Reference from the provider');
  });

  it("includes the provider's confirmation number when staff recorded one", async () => {
    const body = await sentBody({ trackingReference: 'ROG-12345' });
    expect(body.text).toContain('Reference from the provider: ROG-12345.');
  });
});
