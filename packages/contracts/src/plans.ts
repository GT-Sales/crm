import { z } from 'zod';

import {
  billingPeriods,
  carrierCommissionStatuses,
  orderLeadTypes,
  paymentStatuses,
  type PaymentStatus,
} from '@gt-sales/types';

import { isoDateTimeSchema, requestIdSchema } from './common';
import { documentChecklistKeySchema } from './domain';
import { propertyKeySchema } from './properties';
import { leadPropertyValueSchema } from './workspace-leads';

/**
 * Plans a site sells and the order details of a lead that orders one (spec
 * §5.3). A plan belongs to one site and one order lead type
 * (`orderLeadTypes`: `sim_order`, `internet`, `mobility`); its price is integer
 * cents in CAD. When a website submits a lead with a plan, and whenever staff
 * change the plan, the backend freezes a copy of it on the lead
 * (`planSnapshotSchema`), so later price or name changes never rewrite an
 * order already taken.
 *
 * This module imports `./leads` and the property modules, and none of them
 * imports it back, so it cannot join the `./properties` import cycle.
 */

export { leadOrderIntakeSchema, type LeadOrderIntake, type LeadOrderIntakeInput } from './leads';
/** Whether leads of this type carry order details; defined beside the order properties. */
export { isOrderLeadType } from './properties';

/** The most plans one site keeps, across its order lead types. */
export const PLAN_LIMIT = 200;

export const orderLeadTypeSchema = z.enum(orderLeadTypes);
export const billingPeriodSchema = z.enum(billingPeriods);
export const paymentStatusSchema = z.enum(paymentStatuses);
export const carrierCommissionStatusSchema = z.enum(carrierCommissionStatuses);

/** A document the plan's orders must carry, as the lead's document checklist names it. */
export const planRequiredDocumentSchema = documentChecklistKeySchema;

const planNameSchema = z.string().trim().min(1).max(120);
const planPriceMinorSchema = z.number().int().min(0).max(1e12);
const planRequiredDocumentsSchema = z.array(planRequiredDocumentSchema).max(16);
const planPositionSchema = z.number().int().min(0);
const orderQuantitySchema = z.number().int().min(1).max(99);

export const planSchema = z.object({
  id: z.uuid(),
  leadType: orderLeadTypeSchema,
  name: planNameSchema,
  priceMinor: planPriceMinorSchema,
  currency: z.literal('CAD'),
  billingPeriod: billingPeriodSchema,
  paymentRequired: z.boolean(),
  active: z.boolean(),
  requiredDocuments: planRequiredDocumentsSchema,
  /** Values of the site's custom properties on the plan, by property key. */
  customValues: z.record(propertyKeySchema, leadPropertyValueSchema),
  position: planPositionSchema,
  version: z.number().int().positive(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Plan = z.infer<typeof planSchema>;

/** `POST /workspaces/:id/plans`: active with no custom values unless given. */
export const createPlanRequestSchema = planSchema
  .pick({
    leadType: true,
    name: true,
    priceMinor: true,
    billingPeriod: true,
    paymentRequired: true,
    requiredDocuments: true,
  })
  .extend({
    active: z.boolean().default(true),
    customValues: z.record(propertyKeySchema, leadPropertyValueSchema).default({}),
  })
  .strict();
export type CreatePlanRequest = z.infer<typeof createPlanRequestSchema>;
export type CreatePlanRequestInput = z.input<typeof createPlanRequestSchema>;

/**
 * `PATCH /workspaces/:id/plans/:planId`: something to change beside the
 * version the caller read. A custom value of null clears it. The lead type
 * is fixed at creation.
 */
export const updatePlanRequestSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    name: planNameSchema.optional(),
    priceMinor: planPriceMinorSchema.optional(),
    billingPeriod: billingPeriodSchema.optional(),
    paymentRequired: z.boolean().optional(),
    active: z.boolean().optional(),
    requiredDocuments: planRequiredDocumentsSchema.optional(),
    customValues: z.record(propertyKeySchema, leadPropertyValueSchema.nullable()).optional(),
    position: planPositionSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      Object.entries(value).some(
        ([key, field]) => key !== 'expectedVersion' && field !== undefined,
      ),
    { message: 'nothing to change' },
  );
export type UpdatePlanRequest = z.infer<typeof updatePlanRequestSchema>;

export const listPlansQuerySchema = z.object({
  leadType: orderLeadTypeSchema.optional(),
  includeInactive: z.enum(['true', 'false']).default('false'),
});
export type ListPlansQuery = z.infer<typeof listPlansQuerySchema>;
export type ListPlansQueryInput = z.input<typeof listPlansQuerySchema>;

export const listPlansResponseSchema = z.object({
  plans: z.array(planSchema).max(PLAN_LIMIT),
  requestId: requestIdSchema,
});
export type ListPlansResponse = z.infer<typeof listPlansResponseSchema>;

export const planResponseSchema = z.object({
  plan: planSchema,
  requestId: requestIdSchema,
});
export type PlanResponse = z.infer<typeof planResponseSchema>;

/** The copy frozen on the lead at submission or at a staff plan change (spec §5.3). */
export const planSnapshotSchema = z
  .object({
    planId: z.uuid(),
    name: planNameSchema,
    priceMinor: planPriceMinorSchema,
    currency: z.literal('CAD'),
    billingPeriod: billingPeriodSchema,
    paymentRequired: z.boolean(),
    requiredDocuments: planRequiredDocumentsSchema,
    /** The plan's website-visible custom values, as they were when frozen. */
    properties: z.record(propertyKeySchema, leadPropertyValueSchema),
    frozenAt: isoDateTimeSchema,
  })
  .strict();
export type PlanSnapshot = z.infer<typeof planSnapshotSchema>;

/** The order details of a lead of an order type. */
export const leadOrderSchema = z
  .object({
    planId: z.uuid().nullable(),
    plan: planSnapshotSchema.nullable(),
    quantity: orderQuantitySchema,
    paymentStatus: paymentStatusSchema,
    carrierCommission: carrierCommissionStatusSchema,
  })
  .strict();
export type LeadOrder = z.infer<typeof leadOrderSchema>;

/** The order details of a lead with no plan chosen yet. */
export const DEFAULT_LEAD_ORDER: LeadOrder = {
  planId: null,
  plan: null,
  quantity: 1,
  paymentStatus: 'not_needed',
  carrierCommission: 'not_yet',
};

/** Website: only what a storefront needs; custom values limited to website-visible properties. */
export const websitePlanSchema = planSchema
  .pick({
    id: true,
    leadType: true,
    name: true,
    priceMinor: true,
    currency: true,
    billingPeriod: true,
    paymentRequired: true,
    requiredDocuments: true,
  })
  .extend({ properties: z.record(propertyKeySchema, leadPropertyValueSchema) });
export type WebsitePlan = z.infer<typeof websitePlanSchema>;

export const listWebsitePlansQuerySchema = z.object({
  leadType: orderLeadTypeSchema.optional(),
});
export type ListWebsitePlansQuery = z.infer<typeof listWebsitePlansQuerySchema>;

export const listWebsitePlansResponseSchema = z.object({
  plans: z.array(websitePlanSchema),
  requestId: requestIdSchema,
});
export type ListWebsitePlansResponse = z.infer<typeof listWebsitePlansResponseSchema>;

/** Staff edit of the order fields; `planId` re-freezes the snapshot, null clears the plan. */
export const leadOrderEditSchema = z
  .object({
    planId: z.uuid().nullable().optional(),
    quantity: orderQuantitySchema.optional(),
    paymentStatus: paymentStatusSchema.optional(),
    carrierCommission: carrierCommissionStatusSchema.optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'at least one order field',
  });
export type LeadOrderEdit = z.infer<typeof leadOrderEditSchema>;

/** Where a new order's payment starts: owed when its plan takes a payment, else not needed. */
export function initialPaymentStatus(plan: Pick<Plan, 'paymentRequired'> | null): PaymentStatus {
  return plan?.paymentRequired ? 'pending' : 'not_needed';
}

/**
 * The copy of `plan` frozen on a lead at `now`. Only the custom values whose
 * keys the site shows on its website (`websiteVisibleKeys`) are kept, so the
 * snapshot never carries what staff keep to themselves (an internal cost).
 */
export function freezePlan(
  plan: Plan,
  websiteVisibleKeys: readonly string[],
  now: Date,
): PlanSnapshot {
  const properties: Record<string, z.infer<typeof leadPropertyValueSchema>> = {};
  for (const key of websiteVisibleKeys) {
    if (Object.hasOwn(plan.customValues, key)) {
      const value = plan.customValues[key];
      if (value !== undefined) properties[key] = value;
    }
  }
  return {
    planId: plan.id,
    name: plan.name,
    priceMinor: plan.priceMinor,
    currency: plan.currency,
    billingPeriod: plan.billingPeriod,
    paymentRequired: plan.paymentRequired,
    requiredDocuments: [...plan.requiredDocuments],
    properties,
    frozenAt: now.toISOString(),
  };
}
