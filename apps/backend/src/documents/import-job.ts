import { JobHandlerError, type JobHandler } from '@gt-sales/jobs';
import { z } from 'zod';

import type { DocumentService } from './service.js';

/** The documents Get Canada Sim's admin keeps, as the CRM's document types. */
export const IMPORTED_DOCUMENT_TYPES = [
  'passport',
  'visa',
  'sim_photo',
  'billing_contract',
  'business_licence',
] as const;

/** How long an import waits, without spending an attempt, for object storage to be configured. */
export const IMPORT_STORAGE_WAIT_MS = 60 * 60_000;

const payloadSchema = z
  .object({
    leadId: z.uuid(),
    documentType: z.enum(IMPORTED_DOCUMENT_TYPES),
    sourceKey: z.string().min(1).max(512),
    uploadedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

/**
 * Only an object the website filed under this very lead: an order's
 * `orders/<id>/…` or a partner application's `partners/<id>/…` (the lead keeps
 * the website's id). One flat file name, nothing that climbs out.
 */
export function isLeadSourceKey(leadId: string, sourceKey: string): boolean {
  const match = /^(?:orders|partners)\/([0-9a-f-]{36})\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.exec(
    sourceKey,
  );
  return match?.[1] === leadId.toLowerCase();
}

/**
 * `legacy_document_import`: copies one document a website kept in its own
 * storage onto the lead it belongs to (queued by the Get Canada Sim import,
 * RUNBOOKS/legacy-import.md). The file takes the job's message id, so however
 * often the job runs it imports one file. A lead that is gone or restricted,
 * or a source no longer there, completes as skipped; bytes that are not a PDF,
 * JPEG or PNG within the size limit fail the job, so they are seen.
 */
export function createLegacyDocumentImportHandler(
  documents: Pick<DocumentService, 'importWebsiteDocument'> | undefined,
  now: () => Date = () => new Date(),
): JobHandler {
  return async (job) => {
    if (job.payloadVersion !== 1) throw new JobHandlerError('unsupported_payload_version', false);
    const parsed = payloadSchema.safeParse(job.payload);
    if (!parsed.success || !isLeadSourceKey(parsed.data.leadId, parsed.data.sourceKey)) {
      throw new JobHandlerError('invalid_job_payload', false);
    }
    const actor = z.uuid().safeParse(job.actorId);
    if (!actor.success) throw new JobHandlerError('job_actor_missing', false);
    if (!documents) {
      return {
        status: 'retry',
        errorCode: 'feature_not_ready',
        availableAt: new Date(now().getTime() + IMPORT_STORAGE_WAIT_MS),
        preserveAttempt: true,
      };
    }

    const outcome = await documents.importWebsiteDocument({
      workspaceId: job.workspaceId,
      actorId: actor.data,
      requestId: job.id,
      fileId: job.messageId,
      leadId: parsed.data.leadId,
      documentType: parsed.data.documentType,
      sourceKey: parsed.data.sourceKey,
      uploadedAt: parsed.data.uploadedAt ? new Date(parsed.data.uploadedAt) : undefined,
    });
    switch (outcome.status) {
      case 'imported':
      case 'already_imported':
        return { status: 'completed', providerId: `file:${outcome.file.id}` };
      case 'lead_not_found':
      case 'source_missing':
        return { status: 'completed', providerId: `skipped:${outcome.status}` };
      case 'rejected':
        throw new JobHandlerError(`document_${outcome.reason}`, false);
    }
  };
}
