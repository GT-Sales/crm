import { z } from 'zod';

import { pageInfoSchema, requestIdSchema } from './common';
import { leadDocumentSchema } from './files';
import { leadExternalRefSchema, leadTypeSchema } from './leads';
import { leadStageSchema } from './workspace-leads';

/**
 * Documents → the site's review queue: every current document on an active,
 * unrestricted lead that still needs staff (`to_review`: no review yet), or a
 * new upload from the customer (`rejected`: its latest review rejected it).
 * "Current" is the lead page's own rule (`currentLeadDocuments`): attached, not
 * replaced, not held for a change request, not an ID-check photo.
 */
export const documentReviewQueueStatusSchema = z.enum(['to_review', 'rejected']);
export type DocumentReviewQueueStatus = z.infer<typeof documentReviewQueueStatusSchema>;

/** Rows per page of the queue. */
export const DOCUMENT_REVIEW_PAGE_SIZE = 50;

export const documentReviewQueueQuerySchema = z
  .object({
    status: documentReviewQueueStatusSchema.optional(),
    page: z.coerce.number().int().positive().max(1000).optional(),
  })
  .strict();
export type DocumentReviewQueueQuery = z.infer<typeof documentReviewQueueQuerySchema>;

export const documentReviewQueueItemSchema = z.object({
  document: leadDocumentSchema,
  lead: z.object({
    id: z.uuid(),
    leadType: leadTypeSchema,
    stage: leadStageSchema,
    externalRef: leadExternalRefSchema.nullable(),
    /** The customer's name, else their email: what staff recognise the lead by. */
    name: z.string().max(320).nullable(),
  }),
  /** The lead's frozen plan requires this document type (a stage move waits on it). */
  required: z.boolean(),
});
export type DocumentReviewQueueItem = z.infer<typeof documentReviewQueueItemSchema>;

export const documentReviewQueueResponseSchema = z.object({
  items: z.array(documentReviewQueueItemSchema).max(DOCUMENT_REVIEW_PAGE_SIZE),
  /** Both tabs' totals, whichever is shown. */
  counts: z.object({ toReview: z.int().nonnegative(), rejected: z.int().nonnegative() }),
  page: pageInfoSchema,
  /** What this member may do from the queue (the routes recheck). */
  access: z.object({ review: z.boolean(), download: z.boolean() }),
  requestId: requestIdSchema,
});
export type DocumentReviewQueueResponse = z.infer<typeof documentReviewQueueResponseSchema>;
