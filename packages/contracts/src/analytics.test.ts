import { describe, expect, it } from 'vitest';

import {
  ANALYTICS_MAX_RANGE_DAYS,
  analyticsDelta,
  analyticsExcludedFromNew,
  analyticsFunnel,
  analyticsQuerySchema,
  analyticsRangeDays,
  analyticsResponseSchema,
} from './analytics';
import { commissionMinorOf, planCommissionSchema, planSchema } from './plans';

describe('analytics query', () => {
  it('defaults compare to the previous period and group to days', () => {
    expect(analyticsQuerySchema.parse({ from: '2026-11-01', to: '2026-11-07' })).toEqual({
      from: '2026-11-01',
      to: '2026-11-07',
      compare: 'previous',
      group: 'day',
    });
  });

  it('takes every filter', () => {
    const query = analyticsQuerySchema.parse({
      from: '2026-11-01',
      to: '2026-11-01',
      compare: 'last_year',
      group: 'month',
      leadType: 'sim_order',
      source: 'google',
      partner: 'PT-7',
      assignee: 'none',
      paymentStatus: 'paid',
      planId: '70000000-0000-4000-8000-000000000001',
      delivery: 'pickup',
    });
    expect(query.delivery).toBe('pickup');
  });

  it('refuses from after to, more than two years, unknown values and unknown keys', () => {
    const bad = [
      { from: '2026-11-08', to: '2026-11-07' },
      { from: '2024-11-01', to: '2026-11-07' },
      { from: '2026-11-01', to: '2026-13-01' },
      { from: '2026-11-01', to: '2026-11-07', group: 'year' },
      { from: '2026-11-01', to: '2026-11-07', compare: 'all' },
      { from: '2026-11-01', to: '2026-11-07', other: '1' },
      { to: '2026-11-07' },
    ];
    for (const query of bad)
      expect(analyticsQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false);
    expect(analyticsRangeDays('2024-11-07', '2026-11-07')).toBe(ANALYTICS_MAX_RANGE_DAYS);
    expect(analyticsQuerySchema.safeParse({ from: '2024-11-07', to: '2026-11-07' }).success).toBe(
      true,
    );
  });
});

describe('analytics response', () => {
  const base = {
    range: { from: '2026-11-01', to: '2026-11-07', days: 7 },
    comparison: null,
    group: 'day',
    leadType: null,
    kpis: {
      newLeads: { current: 1, previous: null },
      won: { current: 0, previous: null },
      paid: { current: 0, previous: null },
      followUps: { due: 0, overdue: 0 },
      documentsToReview: 0,
    },
    trend: [],
    stages: [],
    sources: [],
    partners: [],
    mix: { plans: [], delivery: [], leadTypes: [] },
    statuses: { payment: [], commission: [] },
    team: [],
    requestId: '00000000-0000-4000-8000-000000000001',
  };

  it('allows a response without any money key (a non-owner)', () => {
    expect(analyticsResponseSchema.parse(base).commission).toBeUndefined();
  });

  it('carries the owner commission figures', () => {
    const parsed = analyticsResponseSchema.parse({
      ...base,
      commission: {
        earnedMinor: { current: 100, previous: null },
        expectedMinor: 50,
        wonWithoutCommission: 0,
        anyPlanHasCommission: true,
        wonDateBasis: 'status_change_else_created',
      },
      commissionTrend: [{ bucket: '2026-11-01', earnedMinor: 100 }],
    });
    expect(parsed.commission?.expectedMinor).toBe(50);
  });
});

describe('analytics helpers', () => {
  it('leaves a SIM order’s cancellations out of New, nothing for the other types', () => {
    expect(analyticsExcludedFromNew('sim_order')).toEqual(['cancelled']);
    expect(analyticsExcludedFromNew('internet')).toEqual([]);
  });

  it('builds the funnel along the path, side and lost stages aside', () => {
    const steps = analyticsFunnel('sim_order', [
      { stage: 'pending', total: 4 },
      { stage: 'verified', total: 2 },
      { stage: 'activated', total: 1 },
      { stage: 'completed', total: 1 },
      { stage: 'cancelled', total: 2 },
      { stage: 'on_hold', total: 1 },
    ]);
    expect(steps.map((step) => [step.stage, step.reached])).toEqual([
      ['incomplete', 11],
      ['pending', 8],
      ['verified', 4],
      ['delivered', 2],
      ['activated', 2],
      ['completed', 1],
    ]);
    expect(steps[0]?.conversion).toBeNull();
    expect(steps[2]?.conversion).toBe(0.5);
    expect(analyticsFunnel('internet', []).every((step) => step.reached === 0)).toBe(true);
    expect(analyticsFunnel('pizza', [])).toEqual([]);
  });

  it('works out a change as a fraction, none without a base', () => {
    expect(analyticsDelta(15, 10)).toBe(0.5);
    expect(analyticsDelta(5, 10)).toBe(-0.5);
    expect(analyticsDelta(5, 0)).toBeNull();
    expect(analyticsDelta(5, null)).toBeNull();
  });
});

describe('plan commission', () => {
  it('is none, a percent of 0–100 % or a fixed amount, nothing else', () => {
    expect(planCommissionSchema.safeParse({ type: 'none' }).success).toBe(true);
    expect(planCommissionSchema.safeParse({ type: 'percent', rateBps: 10_000 }).success).toBe(true);
    expect(planCommissionSchema.safeParse({ type: 'percent', rateBps: 10_001 }).success).toBe(
      false,
    );
    expect(planCommissionSchema.safeParse({ type: 'fixed', amountMinor: -1 }).success).toBe(false);
    expect(
      planCommissionSchema.safeParse({ type: 'fixed', amountMinor: 1, rateBps: 1 }).success,
    ).toBe(false);
    expect(planCommissionSchema.safeParse({ type: 'percent' }).success).toBe(false);
  });

  it('works out the commission of a quantity, half up for a percent', () => {
    expect(commissionMinorOf({ type: 'none' }, 5000, 2)).toBeNull();
    expect(commissionMinorOf({ type: 'fixed', amountMinor: 2500 }, 5000, 3)).toBe(7500);
    expect(commissionMinorOf({ type: 'percent', rateBps: 1000 }, 5000, 2)).toBe(1000);
    expect(commissionMinorOf({ type: 'percent', rateBps: 1250 }, 999, 1)).toBe(125);
  });

  it('is optional on a plan response (left out for a non-owner)', () => {
    const plan = {
      id: '70000000-0000-4000-8000-000000000001',
      leadType: 'sim_order',
      name: 'Unlimited',
      priceMinor: 5000,
      currency: 'CAD',
      billingPeriod: 'month',
      paymentRequired: true,
      active: true,
      requiredDocuments: [],
      customValues: {},
      position: 0,
      version: 1,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    };
    expect(planSchema.parse(plan).commission).toBeUndefined();
  });
});
