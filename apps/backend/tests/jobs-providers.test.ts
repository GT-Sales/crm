import { describe, expect, it } from 'vitest';
import {
  JobHandlerError,
  OutboxRunner,
  type ClaimedJob,
  type EmailEligibilityChecker,
  type JobOutcome,
  type OutboxStore,
} from '@gt-sales/jobs';

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

describe('the old SIM number job', () => {
  it('is gone: no handler for lead_sim_number_email', () => {
    const handlers = createOutboxJobHandlers(
      { EMAIL_PROVIDER: 'fake', NODE_ENV: 'test' },
      alwaysEligible,
    );
    expect(handlers.has('lead_sim_number_email')).toBe(false);
  });
});

describe('the Resend account a site’s mail is recorded against', () => {
  const env = { RESEND_ACCOUNT_ID: 'gt-sales-resend' };
  const noWebhook = { resendForWorkspace: () => undefined };

  it('is the registry’s account, else RESEND_ACCOUNT_ID', () => {
    expect(resendAccountForWorkspace(env, noWebhook, WORKSPACE)).toBe('gt-sales-resend');
    expect(resendAccountForWorkspace(env, undefined, WORKSPACE)).toBe('gt-sales-resend');
    const sameAccount = { resendForWorkspace: () => ({ providerAccount: 'gt-sales-resend' }) };
    expect(resendAccountForWorkspace(env, sameAccount, WORKSPACE)).toBe('gt-sales-resend');
  });

  it('is never another account, and none without RESEND_ACCOUNT_ID', () => {
    // A webhook from another account is a misconfiguration, not a fallback.
    const otherAccount = { resendForWorkspace: () => ({ providerAccount: 'someone-else' }) };
    expect(resendAccountForWorkspace(env, otherAccount, WORKSPACE)).toBeUndefined();
    expect(resendAccountForWorkspace({}, noWebhook, WORKSPACE)).toBeUndefined();
  });
});

describe('a lead’s customer mail', () => {
  const payload = {
    leadId: '33333333-3333-4333-8333-333333333333',
    template: 'order_received',
    templateVersion: 2,
    toAddress: 'customer@example.com',
    contactHash: 'hash-1',
    sender: { fromName: 'Get Canada Sim', fromAddress: 'order@getcanadasim.example' },
    rendered: { subject: 'We have your order', html: '<p>Thanks</p>', text: 'Thanks' },
  };

  it('is registered and sends the rendered message, recording its version', async () => {
    const prepared: unknown[] = [];
    const handlers = createOutboxJobHandlers(
      { EMAIL_PROVIDER: 'fake', NODE_ENV: 'test' },
      alwaysEligible,
      {
        prepare: async (input) => {
          prepared.push(input);
        },
        recordResult: async () => {},
      },
    );
    const claimed = job({ jobType: 'lead_customer_email', payload });
    expect(await handlers.get('lead_customer_email')?.(claimed)).toMatchObject({
      status: 'completed',
    });
    expect(prepared).toMatchObject([{ template: 'order_received', templateVersion: 2 }]);
    await expect(
      handlers.get('lead_customer_email')?.(
        job({ jobType: 'lead_customer_email', payload: { ...payload, extra: 1 } }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_job_payload', retryable: false });
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
