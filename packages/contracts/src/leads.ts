import { z } from 'zod';

import { leadStatuses } from '@gt-sales/types';

import { isoDateTimeSchema, requestIdSchema, versionedFormSchema } from './common';

/**
 * Lead capture and resume — `POST /api/v1/website/leads`,
 * `PATCH /api/v1/website/leads/:id`. Caller: website credential
 * (`leads:write`) plus, on resume, the `X-Draft-Grant` header. Attribution is
 * always the backend's sanitized, allowlisted snapshot — a caller cannot make
 * an arbitrary field or value land in storage.
 */

/**
 * Sanitized, allowlisted attribution as stored and returned. Every field is
 * optional and length-capped. `partnerCode` is kept verbatim whenever present;
 * `partnerCodeMatched` records whether it resolved to a known partner once a
 * partner registry exists (unknown codes are stored and flagged, never linked).
 */
export const attributionSchema = z.object({
  utmSource: z.string().max(120).optional(),
  utmMedium: z.string().max(120).optional(),
  utmCampaign: z.string().max(120).optional(),
  utmTerm: z.string().max(120).optional(),
  utmContent: z.string().max(120).optional(),
  partnerCode: z.string().max(64).optional(),
  partnerCodeMatched: z.boolean().optional(),
  landingPath: z.string().max(512).optional(),
  referrerHost: z.string().max(253).optional(),
});
export type Attribution = z.infer<typeof attributionSchema>;

/**
 * Attribution exactly as submitted — an arbitrary object, not yet sanitized.
 * The backend allowlists, bounds and reduces it to `attributionSchema` before
 * anything is persisted.
 */
export const rawAttributionSchema = z.record(z.string(), z.unknown());
export type RawAttribution = z.infer<typeof rawAttributionSchema>;

/**
 * Customer contact fields. International — any country and phone format is
 * accepted. Intake is no stricter than the websites' own forms (an address
 * shaped `a@b.c`, a phone of up to 40 characters, as CanadaWide allows), so a
 * submission a site has accepted is never lost here; the contact merge
 * normalizes the email.
 */
export const leadContactSchema = z.object({
  fullName: z.string().min(1).max(160).optional(),
  email: z
    .string()
    .max(254)
    .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'email address')
    .optional(),
  phone: z.string().max(40).optional(),
  countryCode: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
});
export type LeadContact = z.infer<typeof leadContactSchema>;

/**
 * The in-progress form, versioned so a website can migrate its form schema
 * independently. The concrete `payload` shape belongs to the lead type's
 * registry entry in the backend; the contract fixes only the envelope.
 */
export const leadFormSchema = versionedFormSchema(z.record(z.string(), z.unknown()));
export type LeadForm = z.infer<typeof leadFormSchema>;

/**
 * Which form this lead came from — `sim_order`, `internet`, `mobility`,
 * `partner_application`, `contact_message`, … A bounded `lower_snake_case`
 * slug naming an entry in the backend's lead-type registry, which owns the
 * payload schema and working statuses. Fixed at creation.
 */
export const leadTypeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/, 'lower_snake_case lead type');
export type LeadType = z.infer<typeof leadTypeSchema>;

/**
 * The source system's own identifier for this record (an order number such as
 * `MS-123`), unique per site and lead type, so a mirrored record is created
 * once however many times the website retries.
 */
export const leadExternalRefSchema = z.string().min(1).max(128);
export type LeadExternalRef = z.infer<typeof leadExternalRefSchema>;

/**
 * `incomplete` while the customer is still filling in the form (repeated
 * saves update the same row); `submitted` once the form is complete.
 */
export const leadStatusSchema = z.enum(leadStatuses);
export type LeadStatus = z.infer<typeof leadStatusSchema>;

/** The consent/disclosure version accepted at lead save — recorded, never inferred. */
export const consentVersionSchema = z.string().min(1).max(64);
export type ConsentVersion = z.infer<typeof consentVersionSchema>;

export const leadSummarySchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  status: leadStatusSchema,
  updatedAt: isoDateTimeSchema,
});
export type LeadSummary = z.infer<typeof leadSummarySchema>;

/**
 * A scoped grant that lets one anonymous visitor resume their own draft.
 * Opaque token plus expiry; scoped to workspace + lead server-side.
 */
export const draftGrantSchema = z.object({
  token: z.string().min(1),
  expiresAt: isoDateTimeSchema,
});
export type DraftGrant = z.infer<typeof draftGrantSchema>;

/**
 * Website intake: the chosen plan and quantity; the price is never sent. The
 * backend freezes the plan as the site sells it (`freezePlan` in `./plans`,
 * which re-exports this schema). Defined here, not in `./plans`, so this
 * module keeps importing nothing but `./common` (see `./properties`).
 */
export const leadOrderIntakeSchema = z
  .object({
    planId: z.uuid(),
    quantity: z.number().int().min(1).max(99).default(1),
  })
  .strict();
export type LeadOrderIntake = z.infer<typeof leadOrderIntakeSchema>;
export type LeadOrderIntakeInput = z.input<typeof leadOrderIntakeSchema>;

export const createLeadRequestSchema = z.object({
  leadType: leadTypeSchema,
  externalRef: leadExternalRefSchema.optional(),
  attribution: rawAttributionSchema.optional(),
  contact: leadContactSchema.optional(),
  form: leadFormSchema.optional(),
  consentVersion: consentVersionSchema,
  /**
   * Create the lead already complete (`submitted`), for a one-shot form with
   * nothing to resume. No draft grant is issued. Lead types the registry
   * marks one-shot (`internet`, `mobility`) require it.
   */
  submit: z.boolean().optional(),
  /** For an order lead type (`orderLeadTypes`): the plan the customer chose. */
  order: leadOrderIntakeSchema.optional(),
});
export type CreateLeadRequest = z.infer<typeof createLeadRequestSchema>;
export type CreateLeadRequestInput = z.input<typeof createLeadRequestSchema>;

/**
 * The header a website may send on a create or an update so a retry is safe:
 * with `submit`, the same key and body within 24 hours returns the lead
 * already created, marked `replayed`.
 */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
/** 8 to 200 characters of letters, digits and `_ - . :`. */
export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(200)
  .regex(/^[A-Za-z0-9_.:-]+$/, 'letters, digits and _ . : -');

export const createLeadResponseSchema = z.object({
  lead: leadSummarySchema,
  /** `null` when the lead was created with `submit: true`: there is no draft to resume. */
  draftGrant: draftGrantSchema.nullable(),
  /** `true` when an `Idempotency-Key` retry returned the lead already created. */
  replayed: z.literal(true).optional(),
  requestId: requestIdSchema,
});
export type CreateLeadResponse = z.infer<typeof createLeadResponseSchema>;

export const updateLeadRequestSchema = z.object({
  contact: leadContactSchema.optional(),
  form: leadFormSchema.optional(),
  attribution: rawAttributionSchema.optional(),
  consentVersion: consentVersionSchema.optional(),
  /**
   * For an order lead type: the plan the customer chose, replacing the
   * draft's. A draft keeps the plan and quantity only; the plan is frozen at
   * submission.
   */
  order: leadOrderIntakeSchema.optional(),
  /**
   * Submit the draft with this save (`incomplete` → `submitted`): its plan is
   * frozen as the site sells it now, and its draft grant edits nothing more.
   */
  submit: z.boolean().optional(),
});
export type UpdateLeadRequest = z.infer<typeof updateLeadRequestSchema>;
export type UpdateLeadRequestInput = z.input<typeof updateLeadRequestSchema>;

export const updateLeadResponseSchema = z.object({
  lead: leadSummarySchema,
  /** `true` when an `Idempotency-Key` retry returned the submission already made. */
  replayed: z.literal(true).optional(),
  requestId: requestIdSchema,
});
export type UpdateLeadResponse = z.infer<typeof updateLeadResponseSchema>;

/** Personal draft data requires both the website identity and this lead's grant. */
export const leadDraftSchema = z.object({
  leadId: z.uuid(),
  leadType: leadTypeSchema,
  contact: leadContactSchema,
  form: leadFormSchema.nullable(),
  /**
   * For an order lead type whose draft holds a plan: the plan and quantity it
   * was last saved with, so a resumed checkout picks up where it was. Absent
   * when the draft names no plan; never a price (the plan is frozen at
   * submission).
   */
  order: leadOrderIntakeSchema.optional(),
});
export type LeadDraft = z.infer<typeof leadDraftSchema>;
export const readLeadResponseSchema = z.object({
  draft: leadDraftSchema,
  requestId: requestIdSchema,
});
export type ReadLeadResponse = z.infer<typeof readLeadResponseSchema>;
