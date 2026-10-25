import { describe, expect, it } from 'vitest';
import {
  JobHandlerError,
  OutboxRunner,
  type ClaimedJob,
  type EmailEligibilityChecker,
  type JobOutcome,
  type OutboxStore,
} from '@gt-sales/jobs';

import { createOutboxJobHandlers, loadUmamiAnalyticsSink } from '../src/jobs/providers.js';

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
