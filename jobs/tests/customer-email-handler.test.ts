import { ResendEmailAdapter, type EmailAdapter, type EmailMessage } from '@gt-sales/adapters';
import { describe, expect, it, vi } from 'vitest';

import {
  createJobHandlerRegistry,
  OutboxRunner,
  outboxJobTypes,
  sendRenderedCustomerEmail,
  type ClaimedJob,
  type EmailDeliveryRecorder,
  type EmailEligibilityChecker,
  type JobOutcome,
  type OutboxStore,
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
  it('delivers a reviewed ad hoc AI email through the existing eligibility and delivery path', async () => {
    const context = setup();
    const draftPayload = {
      ...payload,
      template: 'tpl_5300000000004000',
      templateVersion: 0,
      rendered: {
        subject: 'Reviewed subject',
        html: '<p>Reviewed body</p>',
        text: 'Reviewed body',
      },
    };
    expect(await context.handler(job({ payload: draftPayload }))).toEqual({
      status: 'completed',
      providerId: 'provider-1',
    });
    expect(context.sent).toHaveLength(1);
    expect(context.sent[0]).toMatchObject({
      toAddress: draftPayload.toAddress,
      rendered: draftPayload.rendered,
      sender: draftPayload.sender,
    });
    expect(context.checked).toHaveLength(1);
    expect(context.prepared).toHaveLength(1);
  });

  it('is an outbox job type', () => {
    expect(outboxJobTypes).toContain('lead_customer_email');
    // The SIM number mail is a site template now; its old job type is gone.
    expect(outboxJobTypes).not.toContain('lead_sim_number_email');
    expect(outboxJobTypes).toContain('tracking_code_email');
  });

  it('has no handler for the old SIM number job', () => {
    const handlers = createJobHandlerRegistry({
      email: { send: async () => ({ status: 'delivered', providerId: 'p' }) },
      analytics: { capture: async () => ({ status: 'delivered', providerId: 'a' }) },
      eligibility: {
        checkTransactional: async () => ({ eligible: true }),
        checkMarketing: async () => ({ eligible: false }),
      },
    });
    expect(handlers.has('lead_sim_number_email')).toBe(false);
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

  it('sends through sendRenderedCustomerEmail, which another handler can call with its own payload', async () => {
    const sent: EmailMessage[] = [];
    const prepared: Parameters<EmailDeliveryRecorder['prepare']>[0][] = [];
    const claimed = job({ jobType: 'tracking_code_email' });
    const { leadId: _leadId, ...codeMail } = { ...payload, template: 'tracking_code' as const };
    expect(
      await sendRenderedCustomerEmail(
        {
          email: {
            send: async (message) => {
              sent.push(message);
              return { status: 'delivered', providerId: 'provider-2' };
            },
          },
          eligibility: {
            checkTransactional: async () => ({ eligible: true }),
            checkMarketing: async () => ({ eligible: false }),
          },
          delivery: {
            prepare: async (input) => {
              prepared.push(input);
            },
            recordResult: async () => {},
          },
        },
        claimed,
        codeMail,
      ),
    ).toEqual({ status: 'completed', providerId: 'provider-2' });
    expect(prepared).toMatchObject([{ template: 'tracking_code', templateVersion: 4 }]);
    expect(sent).toEqual([
      {
        workspaceId: WORKSPACE,
        messageId: claimed.messageId,
        template: 'tracking_code',
        toAddress: 'customer@example.test',
        sender: payload.sender,
        rendered: payload.rendered,
      },
    ]);
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

  it('asks for a retry when the provider refused the send, and the next attempt sends it with the same key', async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ name: 'rate_limit_exceeded' }, { status: 429 }))
      .mockResolvedValueOnce(Response.json({ id: 'resend-1' }));
    vi.stubGlobal('fetch', send);
    try {
      const recorded: Parameters<EmailDeliveryRecorder['recordResult']>[0][] = [];
      const handler = createJobHandlerRegistry({
        email: new ResendEmailAdapter({
          apiKey: 'synthetic-key',
          sender: { fromAddress: 'deployment@example.test', fromName: 'Deployment' },
        }),
        analytics: { capture: async () => ({ status: 'delivered', providerId: 'a' }) },
        eligibility: {
          checkTransactional: async () => ({ eligible: true }),
          checkMarketing: async () => ({ eligible: false }),
        },
        delivery: {
          prepare: async () => {},
          recordResult: async (input) => {
            recorded.push(input);
          },
        },
      }).get('lead_customer_email');
      const first = job();
      await expect(handler?.(first)).rejects.toMatchObject({
        name: 'JobHandlerError',
        code: 'resend_http_429',
        retryable: true,
      });
      expect(await handler?.({ ...first, attempts: 2 })).toEqual({
        status: 'completed',
        providerId: 'resend-1',
      });
      const keys = send.mock.calls.map(([, init]) =>
        new Headers(init?.headers).get('Idempotency-Key'),
      );
      expect(keys).toEqual([`${WORKSPACE}/${first.messageId}`, `${WORKSPACE}/${first.messageId}`]);
      expect(recorded.map((entry) => entry.result.status)).toEqual(['refused', 'delivered']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    [
      'order_status_email',
      {
        orderId: LEAD,
        reference: 'MS-1',
        toAddress: 'customer@example.test',
        contactHash: 'hash-1',
      },
    ],
    [
      'abandoned_form_marketing_email',
      {
        leadId: LEAD,
        toAddress: 'customer@example.test',
        contactHash: 'hash-1',
        unsubscribeUrl: 'https://example.test/unsubscribe',
      },
    ],
  ])('asks for a retry of a refused %s', async (jobType, jobPayload) => {
    const handlers = createJobHandlerRegistry({
      email: { send: async () => ({ status: 'refused', errorCode: 'resend_http_429' }) },
      analytics: { capture: async () => ({ status: 'delivered', providerId: 'a' }) },
      eligibility: {
        checkTransactional: async () => ({ eligible: true }),
        checkMarketing: async () => ({ eligible: true }),
      },
    });
    await expect(
      handlers.get(jobType)?.(job({ jobType, payload: jobPayload })),
    ).rejects.toMatchObject({ code: 'resend_http_429', retryable: true });
  });

  it('lets the runner retry a refused send with backoff, and fail it at the attempt limit', async () => {
    const outcomes: JobOutcome[] = [];
    const store = (attempts: number): OutboxStore => {
      let claimed = false;
      return {
        claim: async () => {
          if (claimed) return [];
          claimed = true;
          return [job({ attempts })];
        },
        recordOutcome: async ({ outcome }) => {
          outcomes.push(outcome);
          return 'recorded';
        },
      };
    };
    const handlers = createJobHandlerRegistry({
      email: { send: async () => ({ status: 'refused', errorCode: 'resend_http_429' }) },
      analytics: { capture: async () => ({ status: 'delivered', providerId: 'a' }) },
      eligibility: {
        checkTransactional: async () => ({ eligible: true }),
        checkMarketing: async () => ({ eligible: false }),
      },
    });
    const now = new Date('2026-11-17T12:00:00Z');
    for (const attempts of [1, 8]) {
      await new OutboxRunner({
        store: store(attempts),
        handlers,
        now: () => now,
        random: () => 0.5,
      }).run({ authorizedWorkspaceIds: [WORKSPACE], actorId: ACTOR });
    }
    expect(outcomes).toEqual([
      {
        status: 'retry',
        errorCode: 'resend_http_429',
        availableAt: new Date(now.getTime() + 5_000),
      },
      { status: 'failed', errorCode: 'resend_http_429' },
    ]);
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
