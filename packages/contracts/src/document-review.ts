import { z } from 'zod';

import { leadDocumentSchema } from './files';
import { leadExternalRefSchema, leadTypeSchema } from './leads';
import { leadStageSchema } from './workspace-leads';

/**
 * The site's review queue (read by Ask AI; there is no page for it, documents are reviewed on the lead page): every current document on an active,
 * unrestricted lead that still needs staff (`to_review`: no review yet), or a
 * new upload from the customer (`rejected`: its latest review rejected it).
 * "Current" is the lead page's own rule (`currentLeadDocuments`): attached, not
 * replaced, not held for a change request, not an ID-check photo.
 */
export const documentReviewQueueStatusSchema = z.enum(['to_review', 'rejected']);
export type DocumentReviewQueueStatus = z.infer<typeof documentReviewQueueStatusSchema>;

/** Rows per page of the queue. */
export const DOCUMENT_REVIEW_PAGE_SIZE = 50;

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
