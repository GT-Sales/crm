import { z } from 'zod';

import { isoDateTimeSchema, requestIdSchema } from './common';
import {
  MAX_DOCUMENT_BYTES,
  documentChecklistKeySchema,
  documentMediaTypeSchema,
  documentParentTypeSchema,
} from './domain';
import { fileSummarySchema } from './files';

/**
 * Direct-to-R2 upload authorisation and verification —
 * `POST /uploads/intents`, `POST /uploads/:id/finalize`. Caller: customer
 * grant, partner, or staff. The declared `contentType` is validated up front
 * but never trusted for storage — finalize verifies the file signature
 * (invariant 8). No handler here; A3 implements the R2 flow.
 */

/**
 * Requests a signed PUT URL for one document. `sizeBytes` is bounded by the
 * recorded 10 MB limit; `documentType` must be a key from the offer's
 * checklist; `contentType` must be one of the three allowed media types.
 */
export const createUploadIntentRequestSchema = z.object({
  parentType: documentParentTypeSchema,
  parentId: z.uuid(),
  documentType: documentChecklistKeySchema,
  fileName: z.string().min(1).max(255),
  contentType: documentMediaTypeSchema,
  sizeBytes: z.int().positive().max(MAX_DOCUMENT_BYTES),
});
export type CreateUploadIntentRequest = z.infer<typeof createUploadIntentRequestSchema>;

/** The signed PUT target the client uploads to directly, plus any headers R2 requires. */
export const createUploadIntentResponseSchema = z.object({
  uploadId: z.uuid(),
  url: z.url(),
  method: z.literal('PUT'),
  headers: z.record(z.string(), z.string()),
  expiresAt: isoDateTimeSchema,
  requestId: requestIdSchema,
});
export type CreateUploadIntentResponse = z.infer<typeof createUploadIntentResponseSchema>;

/**
 * Finalizes an intent after the direct upload. The backend copies to a private
 * candidate the uploader cannot overwrite, then verifies existence, size,
 * signature and this checksum before atomically attaching (invariant 8).
 */
export const finalizeUploadRequestSchema = z.object({
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/, 'lower-case hex SHA-256'),
});
export type FinalizeUploadRequest = z.infer<typeof finalizeUploadRequestSchema>;

export const finalizeUploadResponseSchema = z.object({
  file: fileSummarySchema,
  requestId: requestIdSchema,
});
export type FinalizeUploadResponse = z.infer<typeof finalizeUploadResponseSchema>;
