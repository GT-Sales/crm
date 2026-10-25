import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  FollowUpRunner,
  type DueFollowUp,
  type FollowUpScheduleStore,
  type LeadOrderStateReader,
} from './follow-ups.js';
import type { EmailEligibilityChecker } from '@gt-sales/jobs';

const workspaceId = '11111111-1111-4111-8111-111111111111';

function due(overrides: Partial<DueFollowUp> = {}): DueFollowUp {
  return {
    id: crypto.randomUUID(),
    workspaceId,
    leadId: '22222222-2222-4222-8222-222222222222',
    template: 'abandoned_form_marketing',
    contactHash: 'hash-1',
    toAddress: 'lead@example.com',
    ...overrides,
  };
}

function makeSchedules(): FollowUpScheduleStore & {
  sent: string[];
  skipped: string[];
  cancelled: string[];
  listDue: Mock<FollowUpScheduleStore['listDue']>;
} {
  const sent: string[] = [];
  const skipped: string[] = [];
  const cancelled: string[] = [];
  return {
    sent,
    skipped,
    cancelled,
    listDue: vi.fn<FollowUpScheduleStore['listDue']>(async () => []),
    markSent: vi.fn(async (_ws, id) => {
      sent.push(id);
    }),
    markSkipped: vi.fn(async (_ws, id) => {
      skipped.push(id);
    }),
    markCancelled: vi.fn(async (_ws, id) => {
      cancelled.push(id);
    }),
  };
}

describe('FollowUpRunner', () => {
  it('stops a follow-up sequence once the lead has already completed (converted)', async () => {
    const item = due();
    const schedules = makeSchedules();
    schedules.listDue.mockResolvedValue([item]);
    const state: LeadOrderStateReader = {
      leadState: vi.fn(async () => ({ status: 'converted' })),
      orderState: vi.fn(async () => undefined),
    };
    const eligibility: EmailEligibilityChecker = {
      checkTransactional: async () => ({ eligible: true }),
      checkMarketing: async () => ({ eligible: true }),
    };
    const enqueue = vi.fn(async () => ({ messageId: 'should-not-be-called' }));

    const runner = new FollowUpRunner(schedules, state, eligibility, enqueue);
    const tally = await runner.runDue(workspaceId, '20000000-0000-4000-8000-000000000781');

    expect(enqueue).not.toHaveBeenCalled();
    expect(schedules.cancelled).toEqual([item.id]);
    expect(tally.cancelled).toBe(1);
    expect(tally.sent).toBe(0);
  });

  it('sends when the lead is still open and consent/suppression allow it', async () => {
    const item = due();
    const schedules = makeSchedules();
    schedules.listDue.mockResolvedValue([item]);
    const state: LeadOrderStateReader = {
      leadState: vi.fn(async () => ({ status: 'new' })),
      orderState: vi.fn(async () => undefined),
    };
    const eligibility: EmailEligibilityChecker = {
      checkTransactional: async () => ({ eligible: true }),
      checkMarketing: async () => ({ eligible: true }),
    };
    const enqueue = vi.fn(async () => ({ messageId: 'msg-1' }));

    const runner = new FollowUpRunner(schedules, state, eligibility, enqueue);
    const tally = await runner.runDue(workspaceId, '20000000-0000-4000-8000-000000000781');

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(schedules.sent).toEqual([item.id]);
    expect(tally.sent).toBe(1);
  });

  it('re-checks eligibility immediately before sending and skips on a since-recorded opt-out', async () => {
    const item = due();
    const schedules = makeSchedules();
    schedules.listDue.mockResolvedValue([item]);
    const state: LeadOrderStateReader = {
      leadState: vi.fn(async () => ({ status: 'new' })),
      orderState: vi.fn(async () => undefined),
    };
    const eligibility: EmailEligibilityChecker = {
      checkTransactional: async () => ({ eligible: true }),
      checkMarketing: async () => ({ eligible: false, reason: 'opted_out' }),
    };
    const enqueue = vi.fn(async () => ({ messageId: 'msg-1' }));

    const runner = new FollowUpRunner(schedules, state, eligibility, enqueue);
    const tally = await runner.runDue(workspaceId, '20000000-0000-4000-8000-000000000781');

    expect(enqueue).not.toHaveBeenCalled();
    expect(schedules.skipped).toEqual([item.id]);
    expect(tally.skipped_ineligible).toBe(1);
  });

  it('cancels when the referenced lead no longer exists', async () => {
    const item = due();
    const schedules = makeSchedules();
    schedules.listDue.mockResolvedValue([item]);
    const state: LeadOrderStateReader = {
      leadState: vi.fn(async () => undefined),
      orderState: vi.fn(async () => undefined),
    };
    const eligibility: EmailEligibilityChecker = {
      checkTransactional: async () => ({ eligible: true }),
      checkMarketing: async () => ({ eligible: true }),
    };
    const enqueue = vi.fn(async () => ({ messageId: 'msg-1' }));

    const runner = new FollowUpRunner(schedules, state, eligibility, enqueue);
    await runner.runDue(workspaceId, '20000000-0000-4000-8000-000000000781');

    expect(enqueue).not.toHaveBeenCalled();
    expect(schedules.cancelled).toEqual([item.id]);
  });
});
