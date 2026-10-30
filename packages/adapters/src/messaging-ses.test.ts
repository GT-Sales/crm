import { describe, expect, it, vi } from 'vitest';

const commands = vi.hoisted(() => {
  const sent: { input: unknown }[] = [];
  return sent;
});

vi.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: class {
    async send(command: { input: unknown }) {
      commands.push(command);
      return { MessageId: 'ses-message-id' };
    }
  },
  SendEmailCommand: class {
    constructor(readonly input: unknown) {}
  },
}));

import { SesEmailAdapter } from './messaging.js';

describe('a pre-rendered customer email through SES', () => {
  it('sends the rendered message exactly, from the message’s own sender', async () => {
    const adapter = new SesEmailAdapter({
      region: 'ca-central-1',
      sender: { fromAddress: 'deployment@example.test', fromName: 'Deployment' },
    });
    const result = await adapter.send({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      messageId: '22222222-2222-4222-8222-222222222222',
      template: 'order_received',
      toAddress: 'customer@example.test',
      sender: {
        fromName: 'Acme, Co',
        fromAddress: 'order@acme.example',
        replyToAddress: 'help@acme.example',
      },
      rendered: { subject: 'We have your order', html: '<p>Thanks</p>', text: 'Thanks' },
    });
    expect(result).toEqual({ status: 'delivered', providerId: 'ses-message-id' });
    expect(commands[0]?.input).toEqual({
      FromEmailAddress: '"Acme, Co" <order@acme.example>',
      ReplyToAddresses: ['help@acme.example'],
      ConfigurationSetName: undefined,
      Destination: { ToAddresses: ['customer@example.test'] },
      Content: {
        Simple: {
          Subject: { Data: 'We have your order' },
          Body: { Text: { Data: 'Thanks' }, Html: { Data: '<p>Thanks</p>' } },
        },
      },
    });
  });

  it('refuses a site-content template without its rendered message', async () => {
    const adapter = new SesEmailAdapter({
      region: 'ca-central-1',
      sender: { fromAddress: 'deployment@example.test', fromName: 'Deployment' },
    });
    expect(
      await adapter.send({
        workspaceId: '11111111-1111-4111-8111-111111111111',
        messageId: '22222222-2222-4222-8222-222222222222',
        template: 'dispatched',
        toAddress: 'customer@example.test',
      }),
    ).toEqual({ status: 'uncertain', errorCode: 'rendered_message_missing' });
  });
});
