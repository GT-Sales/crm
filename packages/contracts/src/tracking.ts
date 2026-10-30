import { z } from 'zod';

import { orderLeadTypes, type OrderLeadType } from '@gt-sales/types';

import { isoDateTimeSchema, requestIdSchema } from './common';
import { MAX_DOCUMENT_BYTES, documentChecklistKeySchema, documentMediaTypeSchema } from './domain';
import { isCalendarDate } from './lead-fields';
import { SIM_ORDER_DELIVERIES, SIM_ORDER_PERMIT_TYPES } from './lead-types';
import { billingPeriodSchema, orderDateSchema, orderLeadTypeSchema } from './plans';
import { leadStageSchema } from './workspace-leads';

/**
 * Customer order tracking (merge phase 5, step B; ported from Canadian Plans'
 * email-only tracking and adapted to leads). A customer proves an email with a
 * six-digit code and then sees that email's submitted orders on the site the
 * website's key belongs to, never another site's, and may ask for changes to a
 * SIM order that staff approve or reject on the lead page.
 *
 * This module holds the vocabulary (the limits of spec ruling 7, the fields a
 * customer may change under ruling 4, the customer's words for each stage),
 * the shape of one tracked order and the website API's requests and answers.
 *
 * Paths, all under `/api/v1/website/tracking`:
 * - `POST /code`, `POST /verify`: email only; the code request answers the
 *   same `code_sent` whether or not the email has orders on this site.
 * - `GET /orders`: the verified email's orders, newest first.
 * - `POST /orders/:reference/changes`: a pending change request staff decide.
 * - `POST /orders/:reference/uploads/intents` and
 *   `POST /orders/:reference/uploads/:uploadId/finalize`: a passport or visa
 *   for the pending change request, through the signed upload pipeline.
 *
 * Every call after the code carries the 30-minute grant (`X-Customer-Grant`),
 * bound to the site and the normalized email; the backend re-resolves each
 * order by reference **and** email, so one email never reaches another's.
 */

/** A code lives 10 minutes. */
export const TRACKING_CODE_TTL_MS = 600_000;
/** Wrong guesses allowed per code before it is spent. */
export const TRACKING_MAX_ATTEMPTS = 5;
/** The window of the per-email limits below. */
export const TRACKING_EMAIL_WINDOW_SECONDS = 600;
export const TRACKING_CODE_REQUESTS_PER_EMAIL = 5;
export const TRACKING_VERIFICATIONS_PER_EMAIL = 10;
export const TRACKING_WRITES_PER_EMAIL = 30;
/** The code request answers no sooner than this, whether or not the email has orders. */
export const TRACKING_MIN_LATENCY_MS = 500;
/** A grant lasts 30 minutes. */
export const TRACKING_GRANT_TTL_MS = 1_800_000;
/** The most orders one tracked email lists, newest first. */
export const MAX_TRACKED_ORDERS = 50;
/** The header that carries the customer's grant on every call after the code. */
export const TRACKING_GRANT_HEADER = 'X-Customer-Grant';

/** The `sim_order` stages at which a customer may ask for a change (owner decision 4). */
export const CHANGE_REQUEST_STAGES = ['pending', 'verified', 'on_hold'] as const;
/** The documents a customer may send with a change request. */
export const CHANGE_REQUEST_DOCUMENTS = ['passport', 'visa'] as const;
/**
 * The fields a customer may ask to change: the contact's name and phone, the
 * order's CRM plan and the SIM order form's own keys. Never the email, which
 * is what proves the customer.
 */
export const CHANGEABLE_FIELD_KEYS = [
  'fullName',
  'phone',
  'planId',
  'delivery',
  'arrivalDate',
  'permitType',
  'canadaAddress',
  'shippingAddress',
  'flightBooked',
] as const;
export type ChangeableFieldKey = (typeof CHANGEABLE_FIELD_KEYS)[number];

const MIN_PHONE_DIGITS = 7;
const hasPhoneDigits = (phone: string) => (phone.match(/\d/g)?.length ?? 0) >= MIN_PHONE_DIGITS;

/**
 * What a customer asks to change, each key optional. `planId` is a CRM plan
 * id (the backend checks it as a staff `PATCH` does); an address set to null
 * asks for it to be cleared.
 */
export const changeRequestFieldsSchema = z
  .object({
    fullName: z.string().trim().min(2).max(160).optional(),
    phone: z
      .string()
      .trim()
      .min(7)
      .max(40)
      .refine(hasPhoneDigits, 'a phone number, at least seven digits')
      .optional(),
    planId: z.uuid().optional(),
    delivery: z.enum(SIM_ORDER_DELIVERIES).optional(),
    arrivalDate: z.string().refine(isCalendarDate, 'a calendar date, YYYY-MM-DD').optional(),
    permitType: z.enum(SIM_ORDER_PERMIT_TYPES).optional(),
    canadaAddress: z.string().trim().min(1).max(300).nullable().optional(),
    shippingAddress: z.string().trim().min(5).max(400).nullable().optional(),
    flightBooked: z.boolean().optional(),
  })
  .strict();
export type ChangeRequestFields = z.infer<typeof changeRequestFieldsSchema>;

/**
 * How `/track` names each stage to the customer, per order lead type: plain
 * words, not staff's working labels. A stage not listed (one a type no longer
 * has) reads "In progress"; `sim_order` `incomplete` is never listed.
 */
export const TRACKING_STAGE_WORDS: Readonly<
  Record<OrderLeadType, Readonly<Record<string, string>>>
> = {
  sim_order: {
    pending: 'Received',
    verified: 'Confirmed',
    on_hold: 'Waiting on you',
    delivered: 'On its way',
    activated: 'Active',
    completed: 'Completed',
    cancelled: 'Cancelled',
  },
  internet: {
    new: 'Received',
    contacted: 'In progress',
    qualified: 'In progress',
    existing_shaw: 'In progress',
    old_due: 'In progress',
    non_serviceable_address: 'Closed',
    lost: 'Closed',
    installed: 'Installed',
    won: 'Completed',
  },
  mobility: {
    new: 'Received',
    contacted: 'In progress',
    qualified: 'In progress',
    activated: 'Active',
    won: 'Completed',
    lost: 'Closed',
  },
};

const isOrderType = (leadType: string): leadType is OrderLeadType =>
  orderLeadTypes.some((type) => type === leadType);

/** The customer's word for `stage` of `leadType`; "In progress" when it has none. */
export function trackingStageWord(leadType: string, stage: string): string {
  if (!isOrderType(leadType)) return 'In progress';
  return TRACKING_STAGE_WORDS[leadType][stage] ?? 'In progress';
}

/**
 * Where one of the order's documents stands for the customer: `missing` (the
 * plan needs it and none was sent), `received` (sent, not yet reviewed),
 * `approved`, or `needs_replacement` (staff rejected it). Never a link to the
 * file and never the reviewer's note.
 */
export const trackingDocumentStateSchema = z.enum([
  'missing',
  'received',
  'approved',
  'needs_replacement',
]);
export type TrackingDocumentState = z.infer<typeof trackingDocumentStateSchema>;

/** An order's reference as the customer reads it and sends it back (`MS-153`, or the lead id). */
export const trackingReferenceSchema = z.string().trim().min(1).max(128);

/** The customer's own pending change request on an order: what they asked for, by request number. */
export const trackingPendingChangeSchema = z
  .object({
    requestNo: z.int().positive(),
    fields: changeRequestFieldsSchema,
    documents: z.array(z.enum(CHANGE_REQUEST_DOCUMENTS)),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();
export type TrackingPendingChange = z.infer<typeof trackingPendingChangeSchema>;

/**
 * One order in the verified email's list. `details` are the customer's own
 * answers as they stand (the values a change request would replace), each
 * null when not given. No payment status, carrier commission, notes, tasks,
 * assignee or custom values: the schema is strict so none can slip in.
 */
export const trackingOrderSchema = z
  .object({
    reference: trackingReferenceSchema,
    leadType: orderLeadTypeSchema,
    stage: leadStageSchema,
    stageLabel: z.string(),
    submittedAt: isoDateTimeSchema,
    plan: z
      .object({
        id: z.uuid().nullable(),
        name: z.string(),
        priceMinor: z.int().min(0),
        billingPeriod: billingPeriodSchema,
      })
      .strict()
      .nullable(),
    quantity: z.int().min(1).max(99),
    delivery: z.enum(SIM_ORDER_DELIVERIES).nullable(),
    courier: z.string().nullable(),
    trackingNumber: z.string().nullable(),
    dispatchedAt: orderDateSchema.nullable(),
    simNumber: z.string().nullable(),
    details: z
      .object({
        fullName: z.string().nullable(),
        phone: z.string().nullable(),
        arrivalDate: orderDateSchema.nullable(),
        permitType: z.enum(SIM_ORDER_PERMIT_TYPES).nullable(),
        canadaAddress: z.string().nullable(),
        shippingAddress: z.string().nullable(),
        flightBooked: z.boolean().nullable(),
      })
      .strict(),
    documents: z.array(
      z
        .object({ documentType: documentChecklistKeySchema, state: trackingDocumentStateSchema })
        .strict(),
    ),
    canRequestChange: z.boolean(),
    pendingChange: trackingPendingChangeSchema.nullable(),
  })
  .strict();
export type TrackingOrder = z.infer<typeof trackingOrderSchema>;

/** As `leadContactSchema.email`, trimmed: the address the customer types on `/track`. */
const trackingEmailSchema = z
  .string()
  .trim()
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'email address');

/** `POST /website/tracking/code`. */
export const trackingCodeRequestSchema = z.object({ email: trackingEmailSchema }).strict();
export type TrackingCodeRequest = z.infer<typeof trackingCodeRequestSchema>;

/** The neutral answer, the same whether or not the email has orders. */
export const trackingCodeResponseSchema = z.object({
  status: z.literal('code_sent'),
  requestId: requestIdSchema,
});
export type TrackingCodeResponse = z.infer<typeof trackingCodeResponseSchema>;

/** `POST /website/tracking/verify`: the email and the six digits it was sent. */
export const trackingVerifyRequestSchema = z
  .object({ email: trackingEmailSchema, code: z.string().regex(/^\d{6}$/, 'six-digit code') })
  .strict();
export type TrackingVerifyRequest = z.infer<typeof trackingVerifyRequestSchema>;

/** A signed 30-minute grant, bound to the site and the normalized email. */
export const trackingGrantSchema = z.object({
  token: z.string().min(1).max(2048),
  expiresAt: isoDateTimeSchema,
});
export type TrackingGrant = z.infer<typeof trackingGrantSchema>;

export const trackingVerifyResponseSchema = z.object({
  grant: trackingGrantSchema,
  requestId: requestIdSchema,
});
export type TrackingVerifyResponse = z.infer<typeof trackingVerifyResponseSchema>;

/** `GET /website/tracking/orders`. */
export const trackingOrdersResponseSchema = z.object({
  orders: z.array(trackingOrderSchema).max(MAX_TRACKED_ORDERS),
  requestId: requestIdSchema,
});
export type TrackingOrdersResponse = z.infer<typeof trackingOrdersResponseSchema>;

/** `POST /website/tracking/orders/:reference/changes`: at least one field. */
export const createTrackedChangeRequestSchema = z
  .object({
    fields: changeRequestFieldsSchema.refine(
      (fields) => Object.keys(fields).length > 0,
      'at least one field',
    ),
  })
  .strict();
export type CreateTrackedChangeRequest = z.infer<typeof createTrackedChangeRequestSchema>;

/** The customer's pending change request after a change or a finalized upload. */
export const trackedChangeResponseSchema = z.object({
  changeRequest: trackingPendingChangeSchema,
  requestId: requestIdSchema,
});
export type TrackedChangeResponse = z.infer<typeof trackedChangeResponseSchema>;

/**
 * `POST /website/tracking/orders/:reference/uploads/intents`: a passport or
 * visa for the order's pending change request. The parent is the order the
 * reference resolves to, never a value the website sends.
 */
export const trackingUploadIntentRequestSchema = z
  .object({
    documentType: z.enum(CHANGE_REQUEST_DOCUMENTS),
    contentType: documentMediaTypeSchema,
    sizeBytes: z.int().positive().max(MAX_DOCUMENT_BYTES),
  })
  .strict();
export type TrackingUploadIntentRequest = z.infer<typeof trackingUploadIntentRequestSchema>;
