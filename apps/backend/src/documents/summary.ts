import type { FileSummary, StaffFile } from '@gt-sales/contracts';

import type { FileRow, StaffFileRow } from './store.js';

/**
 * Website-facing summary of an attached document. Only ever built for an
 * `available` file, whose verified provenance is guaranteed present by the DB
 * `files_available_provenance_check` constraint.
 */
export function toFileSummary(file: FileRow): FileSummary {
  if (
    file.status !== 'available' ||
    !file.detectedMime ||
    file.sizeBytes === null ||
    !file.checksumSha256
  ) {
    throw new Error('toFileSummary requires an available file with verified provenance');
  }
  return {
    id: file.id,
    workspaceId: file.workspaceId,
    parentType: file.recordType,
    parentId: file.recordId,
    documentType: file.documentType,
    contentType: file.detectedMime,
    sizeBytes: file.sizeBytes,
    status: 'available',
    checksumSha256: file.checksumSha256,
    createdAt: file.createdAt.toISOString(),
  };
}

/** Staff-facing view for the admin Documents panel; verified fields may be null. */
export function toStaffFile(file: StaffFileRow): StaffFile {
  return {
    id: file.id,
    workspaceId: file.workspaceId,
    parentType: file.recordType,
    parentId: file.recordId,
    documentType: file.documentType,
    status: file.status,
    contentType: file.detectedMime,
    sizeBytes: file.sizeBytes,
    checksumSha256: file.checksumSha256,
    rejectReason: file.rejectReason,
    revision: file.revision,
    latestReview: file.latestReview
      ? {
          id: file.latestReview.id,
          decision: file.latestReview.decision,
          note: file.latestReview.note,
          actorId: file.latestReview.actorId,
          createdAt: file.latestReview.createdAt.toISOString(),
        }
      : null,
    createdAt: file.createdAt.toISOString(),
  };
}
