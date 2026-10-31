import { afterEach, describe, expect, it, vi } from 'vitest';
import { emailTemplates, formatFrom, ResendEmailAdapter } from './messaging.js';
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

describe('the template list', () => {
  it('no longer knows the old tracking_otp copy; the code mail is the site’s tracking_code', () => {
    expect(emailTemplates).not.toContain('tracking_otp');
    expect(emailTemplates).toContain('tracking_code');
  });
});

describe('sender identification', () => {
  it.each([
    'order_acknowledgement',
    'order_status',
    'order_awaiting_customer',
    'order_dispatch',
    'order_activation',
    'abandoned_form_marketing',
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

describe('a pre-rendered customer email', () => {
  const message = {
    workspaceId: '11111111-1111-4111-8111-111111111111',
    messageId: '22222222-2222-4222-8222-222222222222',
    toAddress: 'customer@example.test',
    sender: {
      fromName: 'Get Canada Sim',
      fromAddress: 'order@getcanadasim.example',
      replyToAddress: 'help@getcanadasim.example',
    },
    rendered: {
      subject: 'Your SIM is on its way',
      html: '<p>Hello Arjun</p>',
      text: 'Hello Arjun',
    },
  };

  function adapterWithStub() {
    const send = vi.fn<typeof fetch>(async () => Response.json({ id: 'provider-email-id' }));
    vi.stubGlobal('fetch', send);
    const adapter = new ResendEmailAdapter({
      apiKey: 'synthetic-key',
      sender: { fromAddress: 'deployment@example.test', fromName: 'Deployment' },
    });
    return { adapter, send };
  }

  const bodySchema = z.object({
    from: z.string(),
    reply_to: z.string().optional(),
    to: z.array(z.string()),
    subject: z.string(),
    text: z.string(),
    html: z.string(),
  });

  it.each([
    'tracking_code',
    'order_received',
    'information_needed',
    'dispatched',
    'activated',
    'cancelled',
    'sim_number_ready',
    'change_approved',
    'change_rejected',
  ] as const)('sends the %s message exactly as rendered, from its own sender', async (template) => {
    const { adapter, send } = adapterWithStub();
    expect(await adapter.send({ ...message, template })).toEqual({
      status: 'delivered',
      providerId: 'provider-email-id',
    });
    const options = send.mock.calls[0]![1]!;
    expect(bodySchema.parse(JSON.parse(String(options.body)))).toEqual({
      from: 'Get Canada Sim <order@getcanadasim.example>',
      reply_to: 'help@getcanadasim.example',
      to: ['customer@example.test'],
      subject: 'Your SIM is on its way',
      // Nothing is appended to the rendered text, unlike the built-in copy.
      text: 'Hello Arjun',
      html: '<p>Hello Arjun</p>',
    });
    expect(new Headers(options.headers).get('Idempotency-Key')).toBe(
      `${message.workspaceId}/${message.messageId}`,
    );
  });

  it.each(['dispatched', 'sim_number_ready', 'change_approved', 'change_rejected'] as const)(
    'refuses the site-content template %s when it arrives without its rendered message',
    async (template) => {
      const { adapter, send } = adapterWithStub();
      const { rendered: _rendered, ...unrendered } = message;
      expect(await adapter.send({ ...unrendered, template })).toEqual({
        status: 'uncertain',
        errorCode: 'rendered_message_missing',
      });
      expect(send).not.toHaveBeenCalled();
    },
  );

  it('uses the deployment’s sender for a message without one', async () => {
    const { adapter, send } = adapterWithStub();
    const { sender: _sender, ...withoutSender } = message;
    await adapter.send({ ...withoutSender, template: 'dispatched' });
    expect(bodySchema.parse(JSON.parse(String(send.mock.calls[0]![1]!.body))).from).toBe(
      'Deployment <deployment@example.test>',
    );
  });

  it('sends no reply_to when the sender has none', async () => {
    const { adapter, send } = adapterWithStub();
    await adapter.send({
      ...message,
      template: 'dispatched',
      sender: { fromName: 'Get Canada Sim', fromAddress: 'order@getcanadasim.example' },
    });
    const body = bodySchema.parse(JSON.parse(String(send.mock.calls[0]![1]!.body)));
    expect(body.from).toBe('Get Canada Sim <order@getcanadasim.example>');
    expect(body).not.toHaveProperty('reply_to');
  });

  it('quotes a display name with specials so the header stays one address', async () => {
    const { adapter, send } = adapterWithStub();
    await adapter.send({
      ...message,
      template: 'dispatched',
      sender: { fromName: 'Acme, "Co" <x>', fromAddress: 'order@acme.example' },
    });
    expect(bodySchema.parse(JSON.parse(String(send.mock.calls[0]![1]!.body))).from).toBe(
      '"Acme, \\"Co\\" <x>" <order@acme.example>',
    );
  });
});

describe('formatFrom', () => {
  const address = 'order@site.example';

  it('leaves a plain name unquoted', () => {
    expect(formatFrom({ fromName: 'Get Canada Sim', fromAddress: address })).toBe(
      `Get Canada Sim <${address}>`,
    );
  });

  it.each([
    ['Acme, "Co" <x>', '"Acme, \\"Co\\" <x>"'],
    ['Smith, Jones & Co', '"Smith, Jones & Co"'],
    ['Joe "Best" SIMs', '"Joe \\"Best\\" SIMs"'],
    ['Acme Inc.', '"Acme Inc."'],
    ['back\\slash', '"back\\\\slash"'],
    ['Café Mobile', '"Café Mobile"'],
  ])('quotes %s', (fromName, quoted) => {
    expect(formatFrom({ fromName, fromAddress: address })).toBe(`${quoted} <${address}>`);
  });

  it('drops control characters, so a name cannot add a header line', () => {
    expect(formatFrom({ fromName: 'Site\r\nBcc: x@evil.example', fromAddress: address })).toBe(
      `"SiteBcc: x@evil.example" <${address}>`,
    );
  });
});
