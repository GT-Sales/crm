import { z } from 'zod';

import { leadStatuses } from '@gt-sales/types';

import { isoDateTimeSchema, requestIdSchema, versionedFormSchema } from './common';

/**
 * Lead capture and resume — `POST /api/v1/website/leads`,
 * `PATCH /api/v1/website/leads/:id` (T11). Caller: website credential
 * (`leads:write`) plus, on resume, the `X-Draft-Grant` header. Attribution is
 * always the backend's sanitized, allowlisted snapshot (REQ 35) — a caller
 * cannot make an arbitrary field or value land in storage.
 */

/**
 * Sanitized, allowlisted attribution as stored and returned (REQ 35). Every
 * field is optional and length-capped. `partnerCode` is kept verbatim
 * whenever present, whether or not it matched an active partner;
 * `partnerCodeMatched` records which happened without ever linking an
 * unrecognized code (T4P/T11 — "unknown codes stored + flagged, not linked").
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
 * anything is persisted; a caller cannot make an unknown field, an overlong
 * value or an arbitrary path land in storage; approved referrer URLs are
 * reduced to their hostname (REQ 35).
 */
export const rawAttributionSchema = z.record(z.string(), z.unknown());
export type RawAttribution = z.infer<typeof rawAttributionSchema>;

/** Customer contact fields. International — any country and phone format is accepted (§7). */
export const leadContactSchema = z.object({
  fullName: z.string().min(1).max(160).optional(),
  email: z.email().max(254).optional(),
  phone: z.string().max(32).optional(),
  countryCode: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
});
export type LeadContact = z.infer<typeof leadContactSchema>;

/**
 * The in-progress plan-specific form, versioned so a website can migrate its
 * form schema independently. The concrete `payload` shape is a per-offer Zod
 * schema defined in A2; the contract fixes only the versioning envelope.
 */
export const leadFormSchema = versionedFormSchema(z.record(z.string(), z.unknown()));
export type LeadForm = z.infer<typeof leadFormSchema>;

/**
 * `incomplete` while the customer is still filling in the form (repeated
 * saves update the same row); `submitted` once it converts to an order (T12).
 */
export const leadStatusSchema = z.enum(leadStatuses);
export type LeadStatus = z.infer<typeof leadStatusSchema>;

/** The consent/disclosure version accepted at lead save (REQ 34) — recorded, never inferred. */
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
 * A scoped grant that lets one anonymous visitor resume their own draft
 * (glossary). Opaque token plus expiry; scoped to workspace + lead server-side.
 */
export const draftGrantSchema = z.object({
  token: z.string().min(1),
  expiresAt: isoDateTimeSchema,
});
export type DraftGrant = z.infer<typeof draftGrantSchema>;

export const createLeadRequestSchema = z.object({
  attribution: rawAttributionSchema.optional(),
  contact: leadContactSchema.optional(),
  form: leadFormSchema.optional(),
  productId: z.uuid().optional(),
  consentVersion: consentVersionSchema,
});
export type CreateLeadRequest = z.infer<typeof createLeadRequestSchema>;

export const createLeadResponseSchema = z.object({
  lead: leadSummarySchema,
  draftGrant: draftGrantSchema,
  requestId: requestIdSchema,
});
export type CreateLeadResponse = z.infer<typeof createLeadResponseSchema>;

export const updateLeadRequestSchema = z.object({
  contact: leadContactSchema.optional(),
  form: leadFormSchema.optional(),
  attribution: rawAttributionSchema.optional(),
  productId: z.uuid().optional(),
  consentVersion: consentVersionSchema.optional(),
});
export type UpdateLeadRequest = z.infer<typeof updateLeadRequestSchema>;

export const updateLeadResponseSchema = z.object({
  lead: leadSummarySchema,
  requestId: requestIdSchema,
});
export type UpdateLeadResponse = z.infer<typeof updateLeadResponseSchema>;

/** Personal draft data requires both the website identity and this lead's grant. */
export const leadDraftSchema = z.object({
  leadId: z.uuid(),
  productId: z.uuid().nullable(),
  contact: leadContactSchema,
  form: leadFormSchema.nullable(),
});
export type LeadDraft = z.infer<typeof leadDraftSchema>;
export const readLeadResponseSchema = z.object({
  draft: leadDraftSchema,
  requestId: requestIdSchema,
});
export type ReadLeadResponse = z.infer<typeof readLeadResponseSchema>;
