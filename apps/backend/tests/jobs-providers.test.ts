import { describe, expect, it } from 'vitest';
import {
  JobHandlerError,
  OutboxRunner,
  type ClaimedJob,
  type EmailEligibilityChecker,
  type JobOutcome,
  type OutboxStore,
} from '@gt-sales/jobs';

import { loadEmailSenders } from '../src/email/senders.js';
import {
  createOutboxJobHandlers,
  loadUmamiAnalyticsSink,
  resendAccountForWorkspace,
} from '../src/jobs/providers.js';

const WORKSPACE = '10000000-0000-4000-8000-000000000781';
const ACTOR = '20000000-0000-4000-8000-000000000781';

const alwaysEligible: EmailEligibilityChecker = {
  checkTransactional: async () => ({ eligible: true }),
  checkMarketing: async () => ({ eligible: true }),
};

function job(overrides: Partial<ClaimedJob> = {}): ClaimedJob {
  return {
    id: crypto.randomUUID(),
    workspaceId: WORKSPACE,
    jobType: 'order_acknowledgement_email',
    messageId: crypto.randomUUID(),
    payloadVersion: 1,
    payload: {
      orderId: '22222222-2222-4222-8222-222222222222',
      reference: 'GT-ABC123',
      toAddress: 'customer@example.com',
      contactHash: 'hash-1',
    },
    actorId: '20000000-0000-4000-8000-000000000781',
    attempts: 1,
    leaseOwnerId: crypto.randomUUID(),
    ...overrides,
  };
}

describe('outbox provider configuration', () => {
  it('delivers configured email independently of an absent analytics provider', async () => {
    const handlers = createOutboxJobHandlers(
      { EMAIL_PROVIDER: 'fake', NODE_ENV: 'test' },
      alwaysEligible,
    );
    expect(await handlers.get('order_acknowledgement_email')?.(job())).toMatchObject({
      status: 'completed',
    });
    await expect(
      handlers.get('analytics_order_submitted')?.(
        job({
          jobType: 'analytics_order_submitted',
          payload: { orderId: '22222222-2222-4222-8222-222222222222' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'provider_not_configured', retryable: false });
  });

  it('constructs the fake email adapter only for the explicit EMAIL_PROVIDER=fake opt-in outside production', async () => {
    const handlers = createOutboxJobHandlers(
      { EMAIL_PROVIDER: 'fake', OUTBOX_ADAPTERS: 'fake', NODE_ENV: 'test' },
      alwaysEligible,
    );
    const result = await handlers.get('order_acknowledgement_email')?.(job());
    expect(result?.status).toBe('completed');
  });

  it('refuses the fake email adapter on a production deployment even when explicitly requested', async () => {
    const handlers = createOutboxJobHandlers(
      { EMAIL_PROVIDER: 'fake', OUTBOX_ADAPTERS: 'fake', NODE_ENV: 'production' },
      alwaysEligible,
    );
    const handler = handlers.get('order_acknowledgement_email');
    expect(handler).toBeDefined();
    await expect(handler?.(job())).rejects.toMatchObject({
      name: 'JobHandlerError',
      code: 'provider_not_configured',
      retryable: false,
    } satisfies Partial<JobHandlerError>);
  });

  it('records a permanent provider_not_configured failure when EMAIL_PROVIDER is unset', async () => {
    const outcomes: JobOutcome[] = [];
    const claimed = job();
    const store: OutboxStore = {
      claim: async () => (outcomes.length === 0 ? [claimed] : []),
      recordOutcome: async ({ outcome }) => {
        outcomes.push(outcome);
        return 'recorded';
      },
    };
    const runner = new OutboxRunner({
      store,
      handlers: createOutboxJobHandlers({}, alwaysEligible),
    });
    await runner.run({ authorizedWorkspaceIds: [WORKSPACE], actorId: ACTOR });

    expect(outcomes).toEqual([{ status: 'failed', errorCode: 'provider_not_configured' }]);
  });

  it('fails closed when EMAIL_PROVIDER=resend is selected without the required sender env vars', () => {
    expect(() =>
      createOutboxJobHandlers(
        { EMAIL_PROVIDER: 'resend', OUTBOX_ADAPTERS: 'fake', NODE_ENV: 'test' },
        alwaysEligible,
      ),
    ).toThrow(/RESEND_API_KEY/);
  });
});

describe('a lead’s SIM number mail', () => {
  const simJob = (payload: unknown) =>
    job({
      jobType: 'lead_sim_number_email',
      payload,
    });
  const payload = {
    leadId: '33333333-3333-4333-8333-333333333333',
    reference: 'MS-101',
    toAddress: 'customer@example.com',
    contactHash: 'hash-1',
    variables: { simNumber: '+1 778-555-0142', firstName: 'Arjun' },
  };

  it('checks suppression for the lead, records the send and delivers it', async () => {
    const checked: unknown[] = [];
    const prepared: unknown[] = [];
    const handlers = createOutboxJobHandlers(
      { EMAIL_PROVIDER: 'fake', NODE_ENV: 'test' },
      {
        checkTransactional: async (input) => {
          checked.push(input);
          return { eligible: true };
        },
        checkMarketing: async () => ({ eligible: false }),
      },
      {
        prepare: async (input) => {
          prepared.push(input);
        },
        recordResult: async () => {},
      },
    );
    expect(await handlers.get('lead_sim_number_email')?.(simJob(payload))).toMatchObject({
      status: 'completed',
    });
    expect(checked).toEqual([
      expect.objectContaining({ leadId: payload.leadId, contactHash: 'hash-1' }),
    ]);
    expect(prepared).toEqual([
      expect.objectContaining({
        template: 'sim_number_ready',
        messageClass: 'transactional',
        leadId: payload.leadId,
      }),
    ]);
  });

  it('skips a suppressed address and refuses a malformed job', async () => {
    const handlers = createOutboxJobHandlers(
      { EMAIL_PROVIDER: 'fake', NODE_ENV: 'test' },
      {
        checkTransactional: async () => ({ eligible: false, reason: 'hard_bounce' }),
        checkMarketing: async () => ({ eligible: false }),
      },
    );
    expect(await handlers.get('lead_sim_number_email')?.(simJob(payload))).toEqual({
      status: 'completed',
      providerId: 'skipped:hard_bounce',
    });
    await expect(
      handlers.get('lead_sim_number_email')?.(simJob({ ...payload, toAddress: 'nope' })),
    ).rejects.toMatchObject({ code: 'invalid_job_payload', retryable: false });
  });

  it('records a site’s mail against the one Resend account, never another', () => {
    const GCS = '10000000-0000-4000-8000-0000000c0001';
    const senders = loadEmailSenders({
      EMAIL_SENDERS_JSON: JSON.stringify([
        { workspaceId: GCS, fromAddress: 'order@getcanadasim.example', fromName: 'Get Canada Sim' },
      ]),
    });
    const env = { RESEND_ACCOUNT_ID: 'gt-sales-resend' };
    const noWebhook = { resendForWorkspace: () => undefined };
    expect(resendAccountForWorkspace(env, noWebhook, senders, GCS)).toBe('gt-sales-resend');
    // No sender and no webhook: nothing to send from.
    expect(resendAccountForWorkspace(env, noWebhook, senders, WORKSPACE)).toBeUndefined();
    // A webhook from another account is a misconfiguration, not a fallback.
    const otherAccount = { resendForWorkspace: () => ({ providerAccount: 'someone-else' }) };
    expect(resendAccountForWorkspace(env, otherAccount, senders, GCS)).toBeUndefined();
    const sameAccount = { resendForWorkspace: () => ({ providerAccount: 'gt-sales-resend' }) };
    expect(resendAccountForWorkspace(env, sameAccount, senders, WORKSPACE)).toBe('gt-sales-resend');
    expect(resendAccountForWorkspace({}, noWebhook, senders, GCS)).toBeUndefined();
  });
});

describe('Umami analytics sink configuration', () => {
  it('is absent when unset or malformed', () => {
    expect(loadUmamiAnalyticsSink({})).toBeUndefined();
    expect(
      loadUmamiAnalyticsSink({
        UMAMI_EVENTS_URL: 'https://umami.example.test/api/send',
        UMAMI_WORKSPACE_WEBSITES: 'not-json',
      }),
    ).toBeUndefined();
    expect(
      loadUmamiAnalyticsSink({
        UMAMI_WORKSPACE_WEBSITES: `[{"workspaceId":"${WORKSPACE}","websiteId":"getcanadasim"}]`,
      }),
    ).toBeUndefined();
  });

  it('builds the sink from a valid endpoint and workspace mapping', () => {
    const sink = loadUmamiAnalyticsSink({
      UMAMI_EVENTS_URL: 'https://umami.example.test/api/send',
      UMAMI_WORKSPACE_WEBSITES: `[{"workspaceId":"${WORKSPACE}","websiteId":"getcanadasim"}]`,
    });
    expect(sink).toBeDefined();
  });
});
