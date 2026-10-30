import {
  DEFAULT_LEAD_ORDER,
  freezePlan,
  initialPaymentStatus,
  leadOrderSchema,
  type LeadOrder,
} from '@gt-sales/contracts';
import type { z } from 'zod';

import type { PlanForFreeze } from '../plans/store.js';

/**
 * The order details of a lead (`leads.order_details`) as the API reads them.
 * The 0012 migration filled every `sim_order` lead, but a newer order lead
 * may still hold `{}` or only part of an order (a draft keeps `planId` and
 * `quantity` until it is submitted), so each field that is missing or does
 * not fit its schema reads as the default (`DEFAULT_LEAD_ORDER`) rather than
 * failing the page.
 */
export function toLeadOrder(stored: unknown): LeadOrder {
  const record: Record<string, unknown> =
    typeof stored === 'object' && stored !== null && !Array.isArray(stored)
      ? Object.fromEntries(Object.entries(stored))
      : {};
  const shape = leadOrderSchema.shape;
  const field = <T>(schema: z.ZodType<T>, key: string, fallback: T): T => {
    if (!Object.hasOwn(record, key)) return fallback;
    const parsed = schema.safeParse(record[key]);
    return parsed.success ? parsed.data : fallback;
  };
  return {
    planId: field(shape.planId, 'planId', DEFAULT_LEAD_ORDER.planId),
    plan: field(shape.plan, 'plan', DEFAULT_LEAD_ORDER.plan),
    quantity: field(shape.quantity, 'quantity', DEFAULT_LEAD_ORDER.quantity),
    paymentStatus: field(shape.paymentStatus, 'paymentStatus', DEFAULT_LEAD_ORDER.paymentStatus),
    carrierCommission: field(
      shape.carrierCommission,
      'carrierCommission',
      DEFAULT_LEAD_ORDER.carrierCommission,
    ),
  };
}

/** Whether a website may order this plan, or staff may move an order to it: the site's, active and of the lead's type. */
export function isPlanAvailable(
  found: PlanForFreeze | undefined,
  leadType: string,
): found is PlanForFreeze {
  return found !== undefined && found.plan.active && found.plan.leadType === leadType;
}

/** The order a website submission stores: the plan frozen now, its payment status owed or not. */
export function submittedOrder(found: PlanForFreeze, quantity: number, now: Date): LeadOrder {
  return {
    planId: found.plan.id,
    plan: freezePlan(found.plan, found.visibleKeys, now),
    quantity,
    paymentStatus: initialPaymentStatus(found.plan),
    carrierCommission: 'not_yet',
  };
}
