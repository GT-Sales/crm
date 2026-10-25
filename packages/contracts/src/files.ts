import { z } from 'zod';

import { isoDateTimeSchema, requestIdSchema } from './common';
import {
  documentChecklistKeySchema,
  documentMediaTypeSchema,
  documentParentTypeSchema,
} from './domain';

/**
 * Stored document metadata, staff review, and short-lived download links
 * (T17; REQ 22-25; IMPLEMENTATION_PLAN.md §8). Files are private and served
 * only via signed URLs after a permission check (invariant 8). The object key
 * never leaves the backend.
 */

/**
 * A file's byte-verification lifecycle (task brief). `available` is reached only
 * after the private candidate copy passes signature + checksum verification;
 * `rejected` means verification failed; `deleted` is a tombstone awaiting
 * cleanup. `uploading`/`verifying` are transient internal states.
 */
export const fileStatusSchema = z.enum([
  'uploading',
  'verifying',
  'available',
  'rejected',
  'deleted',
]);
export type FileStatus = z.infer<typeof fileStatusSchema>;

/** A staff business decision on a file, independent of byte verification. */
export const fileReviewDecisionSchema = z.enum(['approved', 'rejected']);
export type FileReviewDecision = z.infer<typeof fileReviewDecisionSchema>;

/** Non-secret metadata for one stored object. The object key itself never leaves the backend. */
export const fileSummarySchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  parentType: documentParentTypeSchema,
  parentId: z.uuid(),
  documentType: documentChecklistKeySchema,
  contentType: documentMediaTypeSchema,
  sizeBytes: z.int().nonnegative(),
  status: fileStatusSchema,
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/, 'lower-case hex SHA-256'),
  createdAt: isoDateTimeSchema,
});
export type FileSummary = z.infer<typeof fileSummarySchema>;

/** One staff review decision recorded against a file. */
export const fileReviewEventSchema = z.object({
  id: z.uuid(),
  decision: fileReviewDecisionSchema,
  note: z.string().min(1).max(2000).nullable(),
  actorId: z.uuid(),
  createdAt: isoDateTimeSchema,
});
export type FileReviewEvent = z.infer<typeof fileReviewEventSchema>;

/**
 * Staff-facing view of a file for the admin Documents panel. Verified fields
 * (`contentType`, `sizeBytes`, `checksumSha256`) are null until the file is
 * `available`; `rejectReason` is set only when byte verification failed.
 */
export const staffFileSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  parentType: documentParentTypeSchema,
  parentId: z.uuid(),
  documentType: documentChecklistKeySchema,
  status: fileStatusSchema,
  contentType: documentMediaTypeSchema.nullable(),
  sizeBytes: z.int().nonnegative().nullable(),
  checksumSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/, 'lower-case hex SHA-256')
    .nullable(),
  rejectReason: z.string().max(200).nullable(),
  revision: z.int().positive(),
  latestReview: fileReviewEventSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type StaffFile = z.infer<typeof staffFileSchema>;

export const listWorkspaceFilesResponseSchema = z.object({
  files: z.array(staffFileSchema),
  requestId: requestIdSchema,
});
export type ListWorkspaceFilesResponse = z.infer<typeof listWorkspaceFilesResponseSchema>;

/** Staff approve/reject with an optional note (admin Documents panel). */
export const reviewFileRequestSchema = z.object({
  decision: fileReviewDecisionSchema,
  note: z.string().min(1).max(2000).optional(),
});
export type ReviewFileRequest = z.infer<typeof reviewFileRequestSchema>;

export const reviewFileResponseSchema = z.object({
  file: staffFileSchema,
  requestId: requestIdSchema,
});
export type ReviewFileResponse = z.infer<typeof reviewFileResponseSchema>;

/**
 * A short-lived signed GET URL, treated as a bearer capability with a short
 * expiry (invariant 8). Served with attachment disposition and nosniff.
 */
export const createDownloadLinkResponseSchema = z.object({
  url: z.url(),
  expiresAt: isoDateTimeSchema,
  requestId: requestIdSchema,
});
export type CreateDownloadLinkResponse = z.infer<typeof createDownloadLinkResponseSchema>;
