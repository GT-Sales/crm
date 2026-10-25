import { z } from 'zod';

import { isoDateTimeSchema, requestIdSchema } from './common';

/**
 * Controlled data extraction — `POST /workspaces/:id/exports` (Phase B).
 * Caller: Owner or export permission. Phase A builds only this seam: a clean
 * serialization boundary (PLATFORM_CONTEXT.md §6). No handler here.
 */

export const exportKindSchema = z.enum(['orders', 'partners', 'commissions', 'audit']);
export type ExportKind = z.infer<typeof exportKindSchema>;

export const exportJobStatusSchema = z.enum(['queued', 'running', 'completed', 'failed']);
export type ExportJobStatus = z.infer<typeof exportJobStatusSchema>;

export const createExportRequestSchema = z.object({
  kind: exportKindSchema,
  periodStart: z.iso.date().optional(),
  periodEnd: z.iso.date().optional(),
});
export type CreateExportRequest = z.infer<typeof createExportRequestSchema>;

export const exportJobSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  kind: exportKindSchema,
  status: exportJobStatusSchema,
  createdAt: isoDateTimeSchema,
});
export type ExportJob = z.infer<typeof exportJobSchema>;

export const createExportResponseSchema = z.object({
  job: exportJobSchema,
  requestId: requestIdSchema,
});
export type CreateExportResponse = z.infer<typeof createExportResponseSchema>;
