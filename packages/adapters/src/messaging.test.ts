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
    'sim_number_ready',
  ] as const)('every %s email names the site that sends it', async (template) => {
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
    expect(body.text.endsWith('\n\nTest')).toBe(true);
    if (template === 'order_acknowledgement')
      expect(body.text).toContain('Nothing has been charged');
  });
});

describe('sim_number_ready', () => {
  const GCS = '33333333-3333-4333-8333-333333333333';

  async function sent(variables: Record<string, string>, workspaceId = GCS) {
    const send = vi.fn<typeof fetch>(async () => Response.json({ id: 'provider-email-id' }));
    vi.stubGlobal('fetch', send);
    const adapter = new ResendEmailAdapter({
      apiKey: 'synthetic-key',
      sender: { fromAddress: 'crm@example.test', fromName: 'GT Sales' },
      senderForWorkspace: (id) =>
        id === GCS
          ? { fromAddress: 'order@getcanadasim.example', fromName: 'Get Canada Sim' }
          : undefined,
    });
    await adapter.send({
      workspaceId,
      messageId: '22222222-2222-4222-8222-222222222222',
      template: 'sim_number_ready',
      toAddress: 'customer@example.test',
      leadId: '44444444-4444-4444-8444-444444444444',
      reference: 'MS-101',
      variables,
    });
    return z
      .object({ from: z.string(), subject: z.string(), text: z.string(), html: z.string() })
      .parse(JSON.parse(String(send.mock.calls[0]?.[1]?.body)));
  }

  it('gives the number, the order and the way to it, from the site’s own sender', async () => {
    const body = await sent({
      firstName: 'Arjun',
      simNumber: '+1 778-555-0142',
      planLabel: '75GB · $35, Fido',
      delivery: 'Instant eSIM (delivered by email)',
      arrival: 'Monday, November 2, 2026',
      trackUrl: 'https://getcanadasim.example/track',
    });
    expect(body.from).toBe('Get Canada Sim <order@getcanadasim.example>');
    expect(body.subject).toBe('Your Canadian mobile number is ready (MS-101)');
    expect(body.text).toContain('Your Canadian mobile number is ready, Arjun.');
    expect(body.text).toContain('Your Canadian number: +1 778-555-0142');
    expect(body.text).toContain('Arrival in Canada: Monday, November 2, 2026');
    expect(body.text).toContain('View your order: https://getcanadasim.example/track');
    expect(body.text.endsWith('\n\nGet Canada Sim')).toBe(true);
    expect(body.html).toContain('+1 778-555-0142');
    expect(body.html).toContain('href="https://getcanadasim.example/track"');
  });

  it('escapes what staff and customers typed, and leaves out what it does not know', async () => {
    const body = await sent({ firstName: '<b>Eve</b>', simNumber: '416 & <555>' });
    expect(body.html).not.toContain('<b>Eve</b>');
    expect(body.html).toContain('&lt;b&gt;Eve&lt;/b&gt;');
    expect(body.html).toContain('416 &amp; &lt;555&gt;');
    expect(body.text).not.toContain('View your order');
    expect(body.text).not.toContain('Plan:');
  });

  it('falls back to the deployment’s sender for a site without its own', async () => {
    const body = await sent({ simNumber: '4165550104' }, '55555555-5555-4555-8555-555555555555');
    expect(body.from).toBe('GT Sales <crm@example.test>');
    expect(body.text).toContain('Your Canadian mobile number is ready, there.');
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
