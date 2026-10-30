import type { EmailAdapter, EmailMessage } from '@gt-sales/adapters';
import { describe, expect, it } from 'vitest';

import {
  createJobHandlerRegistry,
  outboxJobTypes,
  type ClaimedJob,
  type EmailDeliveryRecorder,
  type EmailEligibilityChecker,
} from '../src/index';

const WORKSPACE = '10000000-0000-4000-8000-000000000901';
const ACTOR = '20000000-0000-4000-8000-000000000901';
const LEAD = '30000000-0000-4000-8000-000000000901';

const payload = {
  leadId: LEAD,
  template: 'dispatched',
  templateVersion: 4,
  toAddress: 'customer@example.test',
  contactHash: 'hash-1',
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

function job(overrides: Partial<ClaimedJob> = {}): ClaimedJob {
  return {
    id: crypto.randomUUID(),
    workspaceId: WORKSPACE,
    jobType: 'lead_customer_email',
    messageId: crypto.randomUUID(),
    payloadVersion: 1,
    payload,
    actorId: ACTOR,
    attempts: 1,
    leaseOwnerId: crypto.randomUUID(),
    ...overrides,
  };
}

function setup(eligible: { eligible: boolean; reason?: string } = { eligible: true }) {
  const sent: EmailMessage[] = [];
  const prepared: Parameters<EmailDeliveryRecorder['prepare']>[0][] = [];
  const recorded: Parameters<EmailDeliveryRecorder['recordResult']>[0][] = [];
  const checked: Parameters<EmailEligibilityChecker['checkTransactional']>[0][] = [];
  const email: EmailAdapter = {
    send: async (message) => {
      sent.push(message);
      return { status: 'delivered', providerId: 'provider-1' };
    },
  };
  const handlers = createJobHandlerRegistry({
    email,
    analytics: { capture: async () => ({ status: 'delivered', providerId: 'a' }) },
    eligibility: {
      checkTransactional: async (input) => {
        checked.push(input);
        return eligible;
      },
      checkMarketing: async () => ({ eligible: false }),
    },
    delivery: {
      prepare: async (input) => {
        prepared.push(input);
      },
      recordResult: async (input) => {
        recorded.push(input);
      },
    },
  });
  const handler = handlers.get('lead_customer_email');
  if (!handler) throw new Error('lead_customer_email is not registered');
  return { handler, sent, prepared, recorded, checked };
}

describe('lead_customer_email', () => {
  it('is an outbox job type', () => {
    expect(outboxJobTypes).toContain('lead_customer_email');
    // Jobs queued before the pre-rendered mail existed still run.
    expect(outboxJobTypes).toContain('lead_sim_number_email');
  });

  it('sends exactly the rendered message from the payload’s sender and records its version', async () => {
    const { handler, sent, prepared, recorded, checked } = setup();
    const claimed = job();
    expect(await handler(claimed)).toEqual({ status: 'completed', providerId: 'provider-1' });

    expect(checked).toEqual([
      { workspaceId: WORKSPACE, actorId: ACTOR, contactHash: 'hash-1', leadId: LEAD },
    ]);
    expect(prepared).toEqual([
      {
        workspaceId: WORKSPACE,
        actorId: ACTOR,
        messageId: claimed.messageId,
        template: 'dispatched',
        templateVersion: 4,
        messageClass: 'transactional',
        contactHash: 'hash-1',
        leadId: LEAD,
        siteSender: true,
      },
    ]);
    expect(sent).toEqual([
      {
        workspaceId: WORKSPACE,
        messageId: claimed.messageId,
        template: 'dispatched',
        toAddress: 'customer@example.test',
        leadId: LEAD,
        sender: payload.sender,
        rendered: payload.rendered,
      },
    ]);
    expect(recorded).toMatchObject([{ messageId: claimed.messageId }]);
  });

  it('sends a test mail without a lead', async () => {
    const { handler, sent, prepared } = setup();
    const { leadId: _leadId, ...testPayload } = payload;
    const result = await handler(job({ payload: { ...testPayload, test: true } }));
    expect(result).toMatchObject({ status: 'completed' });
    expect(prepared[0]?.leadId).toBeUndefined();
    expect(sent[0]?.leadId).toBeUndefined();
  });

  it('skips a suppressed address without recording or sending', async () => {
    const { handler, sent, prepared } = setup({ eligible: false, reason: 'hard_bounce' });
    expect(await handler(job())).toEqual({
      status: 'completed',
      providerId: 'skipped:hard_bounce',
    });
    expect(prepared).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('reports a provider that could not confirm as uncertain', async () => {
    const handlers = createJobHandlerRegistry({
      email: { send: async () => ({ status: 'uncertain', errorCode: 'resend_http_500' }) },
      analytics: { capture: async () => ({ status: 'delivered', providerId: 'a' }) },
      eligibility: {
        checkTransactional: async () => ({ eligible: true }),
        checkMarketing: async () => ({ eligible: false }),
      },
    });
    expect(await handlers.get('lead_customer_email')?.(job())).toEqual({
      status: 'uncertain',
      errorCode: 'resend_http_500',
    });
  });

  it.each([
    ['an extra key', { ...payload, variables: { a: 'b' } }],
    ['an unknown template', { ...payload, template: 'order_status' }],
    ['a malformed address', { ...payload, toAddress: 'nope' }],
    ['a missing rendered text', { ...payload, rendered: { ...payload.rendered, text: '' } }],
    ['an extra sender key', { ...payload, sender: { ...payload.sender, bcc: 'x@example.test' } }],
  ])('fails permanently on %s', async (_name, bad) => {
    const { handler, sent, prepared } = setup();
    await expect(handler(job({ payload: bad }))).rejects.toMatchObject({
      code: 'invalid_job_payload',
      retryable: false,
    });
    expect(sent).toEqual([]);
    expect(prepared).toEqual([]);
  });

  it('fails permanently on payload version 2', async () => {
    const { handler, sent } = setup();
    await expect(handler(job({ payloadVersion: 2 }))).rejects.toMatchObject({
      code: 'unsupported_payload_version',
      retryable: false,
    });
    expect(sent).toEqual([]);
  });
});
