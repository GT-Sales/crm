import { z } from 'zod';

import { isoDateTimeSchema, pageInfoSchema, requestIdSchema } from './common';
import { attributionSchema, leadContactSchema, leadStatusSchema } from './leads';

/**
 * Staff lead visibility — `GET /workspaces/:id/leads` (T11). Caller: staff
 * session with `workspace.read` (every role). Read-only: leads are created
 * and updated only by the website flow in `leads.ts`.
 */

export const listWorkspaceLeadsQuerySchema = z.object({
  status: leadStatusSchema.optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(200).optional(),
});
export type ListWorkspaceLeadsQuery = z.infer<typeof listWorkspaceLeadsQuerySchema>;

/**
 * One row of the admin leads list. `source` is a short human-readable label
 * derived from `attribution` (e.g. `utm:google/cpc`, `referrer:facebook.com`,
 * `partner:MAPLE10` or `direct`) so the list has a source column without every
 * consumer re-deriving it from the raw attribution fields.
 */
export const leadListItemSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  status: leadStatusSchema,
  contact: leadContactSchema,
  source: z.string().min(1).max(160),
  attribution: attributionSchema,
  selectedOfferVersionId: z.uuid().nullable(),
  consentVersion: z.string().max(64).nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type LeadListItem = z.infer<typeof leadListItemSchema>;

export const listWorkspaceLeadsResponseSchema = z.object({
  leads: z.array(leadListItemSchema),
  page: pageInfoSchema,
  requestId: requestIdSchema,
});
export type ListWorkspaceLeadsResponse = z.infer<typeof listWorkspaceLeadsResponseSchema>;
