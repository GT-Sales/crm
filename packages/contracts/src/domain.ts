import { z } from 'zod';

/**
 * API-surface vocabularies for documents, shared by the upload and file
 * families. These are the values the `/api/v1` contract exposes to callers, not
 * the database's internal enums (a DB row type is not an API type).
 */

/**
 * The only stored document media types (PDF/JPG/PNG, no malware scanner yet).
 * The declared Content-Type is never trusted — the finalize step verifies the
 * file signature — but a caller must still declare an allowed type up front.
 */
export const documentMediaTypeSchema = z.enum([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]);
export type DocumentMediaType = z.infer<typeof documentMediaTypeSchema>;

/**
 * A document-checklist key (e.g. `passport`, `study_permit`). The concrete
 * taxonomy comes from the lead type, not this contract, so it is a bounded slug
 * rather than a fixed enum.
 */
export const documentChecklistKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/, 'lower_snake_case checklist key');
export type DocumentChecklistKey = z.infer<typeof documentChecklistKeySchema>;

/** Records an attachment can hang off. Widened as new parent records gain documents. */
export const documentParentTypeSchema = z.enum(['lead', 'order']);
export type DocumentParentType = z.infer<typeof documentParentTypeSchema>;

/** Maximum uploaded document size: 10 MB. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
