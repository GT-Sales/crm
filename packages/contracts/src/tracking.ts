import { z } from 'zod';

import { orderLeadTypes, type OrderLeadType } from '@gt-sales/types';

import { isoDateTimeSchema } from './common';
import { documentChecklistKeySchema } from './domain';
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
 * This module holds the vocabulary: the limits (spec ruling 7), the fields a
 * customer may change (ruling 4), the customer's words for each stage and the
 * shape of one tracked order. The endpoints come with the API shapes.
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
