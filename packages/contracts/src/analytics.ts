import { z } from 'zod';

import { requestIdSchema } from './common';
import { leadTypeSchema } from './leads';
import { leadTypeEntry } from './lead-types';
import { paymentStatusSchema } from './plans';
import { leadAssigneeFilterSchema, leadStageSchema } from './workspace-leads';

/**
 * The analytics dashboard (`GET /workspaces/:id/analytics`): one site's leads
 * over a date range, compared with another range, with optional filters.
 * Counts are for everyone who reads the site (`workspace.read`); every money
 * figure (`commission`, `commissionTrend`) is sent only to a caller with
 * `revenue.view` (the owner) and is left out, not nulled, for everyone else.
 *
 * Days are UTC calendar days, as the older stats endpoint's; `from` and `to`
 * are both inclusive.
 */

/** The longest range one request may cover: two years of days. */
export const ANALYTICS_MAX_RANGE_DAYS = 731;
/** How many sources, partners and plans each list shows. */
export const ANALYTICS_TOP_LIMIT = 10;

export const ANALYTICS_COMPARE_MODES = ['previous', 'last_year', 'none'] as const;
export const analyticsCompareSchema = z.enum(ANALYTICS_COMPARE_MODES);
export type AnalyticsCompare = z.infer<typeof analyticsCompareSchema>;

export const ANALYTICS_GROUPS = ['day', 'week', 'month'] as const;
export const analyticsGroupSchema = z.enum(ANALYTICS_GROUPS);
export type AnalyticsGroup = z.infer<typeof analyticsGroupSchema>;

export const ANALYTICS_DELIVERIES = ['esim', 'pickup'] as const;
export const analyticsDeliverySchema = z.enum(ANALYTICS_DELIVERIES);

/**
 * The stages a lead is won at, per type: a SIM order once activated or
 * completed, an internet or mobility lead once won, a partner application
 * once approved. A type not named here has no won stage.
 */
export const ANALYTICS_WON_STAGES: Readonly<Record<string, readonly string[]>> = {
  sim_order: ['activated', 'completed'],
  internet: ['won'],
  mobility: ['won'],
  partner_application: ['approved'],
};

/**
 * The stages a lead is lost at, per type (the closing stages of
 * `isClosingStage`, less a contact message's Closed, which is not a loss).
 */
export const ANALYTICS_LOST_STAGES: Readonly<Record<string, readonly string[]>> = {
  sim_order: ['cancelled'],
  internet: ['lost', 'non_serviceable_address'],
  mobility: ['lost'],
  partner_application: ['declined'],
};

/**
 * The stages left out of New, as the older stats leave them out of the
 * volume: the type's dashboard `outcomes.lost` stages (a SIM order's
 * Cancelled), none for a type without outcome groups.
 */
export function analyticsExcludedFromNew(leadType: string): readonly string[] {
  return leadTypeEntry(leadType)?.outcomes?.lost.stages ?? [];
}

const isoDay = z.iso.date();

function dayNumber(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`) / 86_400_000;
}

/** Days from `from` to `to`, both counted. */
export function analyticsRangeDays(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from) + 1;
}

export const analyticsQuerySchema = z
  .object({
    from: isoDay,
    to: isoDay,
    compare: analyticsCompareSchema.default('previous'),
    group: analyticsGroupSchema.default('day'),
    /** One lead type; absent, every type of the site. */
    leadType: leadTypeSchema.optional(),
    /** The attribution's `utmSource`, exactly. */
    source: z.string().trim().min(1).max(200).optional(),
    /** The attribution's `partnerCode`, exactly. */
    partner: z.string().trim().min(1).max(64).optional(),
    assignee: leadAssigneeFilterSchema.optional(),
    /**
     * A SIM order's `order_details.paymentStatus`; for internet and mobility
     * the custom property `custom_payment_status`, compared case-insensitively.
     */
    paymentStatus: paymentStatusSchema.optional(),
    /** The resolved plan (frozen, linked or matched by website slug). */
    planId: z.uuid().optional(),
    /** A SIM order's form `delivery`; `pickup` is the physical SIM. */
    delivery: analyticsDeliverySchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const days = analyticsRangeDays(value.from, value.to);
    if (!Number.isFinite(days) || days < 1) {
      ctx.addIssue({ code: 'custom', message: 'from must be on or before to', path: ['from'] });
    } else if (days > ANALYTICS_MAX_RANGE_DAYS) {
      ctx.addIssue({ code: 'custom', message: 'the range is at most two years', path: ['to'] });
    }
  });
export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;
export type AnalyticsQueryInput = z.input<typeof analyticsQuerySchema>;

const count = z.int().nonnegative();
const minor = z.int();

/** A number this range and in the comparison range (null with `compare=none`). */
const comparedCount = z.object({ current: count, previous: count.nullable() });
const comparedMinor = z.object({ current: minor, previous: minor.nullable() });
export type AnalyticsCompared = z.infer<typeof comparedCount>;

const rangeSchema = z.object({ from: isoDay, to: isoDay });

const labelledCount = z.object({ key: z.string().min(1).max(200), total: count });

export const analyticsResponseSchema = z.object({
  range: rangeSchema.extend({ days: z.int().positive() }),
  comparison: rangeSchema.nullable(),
  group: analyticsGroupSchema,
  leadType: leadTypeSchema.nullable(),
  kpis: z.object({
    /** Created in the range, not archived, the type's `analyticsExcludedFromNew` stages aside. */
    newLeads: comparedCount,
    /** At a won stage now, with the won date (see `wonDateBasis`) in the range. */
    won: comparedCount,
    /** Paid (a SIM order's payment status, or `custom_payment_status`), created in the range. */
    paid: comparedCount,
    /** Open tasks on the filtered leads due today or earlier, and those before today (UTC). */
    followUps: z.object({ due: count, overdue: count }),
    /** Current documents never reviewed on the site's active leads (the review queue's count). */
    documentsToReview: count,
  }),
  /** New leads per bucket; `previous` is the comparison range's bucket at the same offset. */
  trend: z.array(z.object({ bucket: isoDay, current: count, previous: count.nullable() })),
  /** Created in the range, by the stage they stand at now. */
  stages: z.array(z.object({ leadType: leadTypeSchema, stage: leadStageSchema, total: count })),
  sources: z.array(labelledCount).max(ANALYTICS_TOP_LIMIT),
  partners: z
    .array(
      z.object({
        code: z.string().min(1).max(64),
        name: z.string().min(1).max(200).nullable(),
        total: count,
      }),
    )
    .max(ANALYTICS_TOP_LIMIT),
  mix: z.object({
    /** By resolved plan; a null `planId` is "no plan matched". */
    plans: z
      .array(z.object({ planId: z.uuid().nullable(), name: z.string().max(200), total: count }))
      .max(ANALYTICS_TOP_LIMIT + 1),
    /** SIM orders by form `delivery` (`esim`, `pickup`, or `unknown`). */
    delivery: z.array(labelledCount),
    leadTypes: z.array(z.object({ leadType: leadTypeSchema, total: count })),
  }),
  /** Created in the range, by payment status and by carrier commission status (raw values). */
  statuses: z.object({ payment: z.array(labelledCount), commission: z.array(labelledCount) }),
  /** Per assignee (null = nobody) of leads created in the range. */
  team: z.array(
    z.object({ actorId: z.uuid().nullable(), assigned: count, won: count, overdue: count }),
  ),
  /** Owner only (`revenue.view`); absent for everyone else. Cents, CAD. */
  commission: z
    .object({
      earnedMinor: comparedMinor,
      /** On open leads (neither won nor lost) created in the range. */
      expectedMinor: minor,
      /** Won in the range, with no commission resolved (no plan, or a plan with none). */
      wonWithoutCommission: count,
      /** Whether any plan of the selected type (or the site) has a commission set. */
      anyPlanHasCommission: z.boolean(),
      /** The won date: the first move into a won stage, else the creation date. */
      wonDateBasis: z.literal('status_change_else_created'),
    })
    .optional(),
  /** Owner only: commission earned per bucket. */
  commissionTrend: z.array(z.object({ bucket: isoDay, earnedMinor: minor })).optional(),
  requestId: requestIdSchema,
});
export type AnalyticsResponse = z.infer<typeof analyticsResponseSchema>;

/** One step of the funnel: leads that reached the stage, and the share of the step before. */
export interface FunnelStep {
  stage: string;
  reached: number;
  /** reached / the previous step's reached, 0–1; null for the first step or after a zero. */
  conversion: number | null;
}

/**
 * The funnel of one type from its stage counts: the type's stages in order,
 * lost stages and side stages (a SIM order's On hold) aside, each counting the
 * leads standing at it or at any later step. A lead at a lost or side stage is
 * counted only at the first step.
 */
export function analyticsFunnel(
  leadType: string,
  stages: readonly { stage: string; total: number }[],
): FunnelStep[] {
  const entry = leadTypeEntry(leadType);
  if (!entry) return [];
  const lost = new Set(ANALYTICS_LOST_STAGES[leadType] ?? []);
  const side = new Set(leadType === 'sim_order' ? ['on_hold'] : []);
  const path = entry.stages
    .map((stage) => stage.key)
    .filter((key) => !lost.has(key) && !side.has(key));
  const at = new Map(stages.map((entry) => [entry.stage, entry.total]));
  const all = stages.reduce((sum, entry) => sum + entry.total, 0);
  const steps: FunnelStep[] = [];
  for (let index = 0; index < path.length; index++) {
    const reached =
      index === 0 ? all : path.slice(index).reduce((sum, key) => sum + (at.get(key) ?? 0), 0);
    const before = steps[index - 1]?.reached;
    steps.push({
      stage: path[index] ?? '',
      reached,
      conversion: before === undefined || before === 0 ? null : reached / before,
    });
  }
  return steps;
}

/** The change from `previous` to `current` as a fraction (0.25 = +25 %); null when there is no base. */
export function analyticsDelta(current: number, previous: number | null): number | null {
  if (previous === null || previous === 0) return null;
  return (current - previous) / previous;
}
