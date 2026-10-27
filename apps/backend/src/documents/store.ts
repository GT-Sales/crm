import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import {
  auditEvents,
  fileRevisions,
  fileReviewEvents,
  files,
  leads,
  withTenantTx,
  type TenantTransaction,
} from '@gt-sales/db';
import type { DocumentMediaType } from '@gt-sales/adapters';
import {
  documentMediaTypeSchema,
  documentParentTypeSchema,
  fileReviewDecisionSchema,
  fileStatusSchema,
  type DocumentParentType,
  type FileReviewDecision,
  type FileStatus,
} from '@gt-sales/contracts';

/**
 * Persistence for T17 documents. The interface is store-agnostic so the
 * security logic in `service.ts` can be exercised against an in-memory
 * implementation (memory-store.ts) as well as Postgres. The DB implementation
 * relies on conditional `UPDATE ... WHERE status = ...` statements — never a row
 * lock held across the external R2 call (invariant 7) — to make concurrent and
 * repeated finalize calls resolve to exactly one attached object.
 */

export interface FileRow {
  id: string;
  workspaceId: string;
  recordType: DocumentParentType;
  recordId: string;
  documentType: string;
  bucket: string;
  stagingKey: string;
  candidateKey: string | null;
  objectKey: string | null;
  declaredContentType: DocumentMediaType;
  detectedMime: DocumentMediaType | null;
  declaredSizeBytes: number;
  sizeBytes: number | null;
  checksumSha256: string | null;
  status: FileStatus;
  rejectReason: string | null;
  revision: number;
  uploadedBy: string;
  expiresAt: Date;
  finalizedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
}

export interface ReviewEventRow {
  id: string;
  decision: FileReviewDecision;
  note: string | null;
  actorId: string;
  createdAt: Date;
}

export interface StaffFileRow extends FileRow {
  latestReview: ReviewEventRow | null;
}

export interface CreateIntentInput {
  workspaceId: string;
  actorId: string;
  requestId: string;
  recordType: DocumentParentType;
  recordId: string;
  documentType: string;
  bucket: string;
  stagingKey: string;
  declaredContentType: DocumentMediaType;
  declaredSizeBytes: number;
  expiresAt: Date;
}

export type ClaimResult =
  | { status: 'claimed'; file: FileRow }
  | { status: 'already_available'; file: FileRow }
  | { status: 'already_rejected'; file: FileRow }
  | { status: 'in_progress' }
  | { status: 'expired' }
  | { status: 'not_found' };

export interface ClaimInput {
  workspaceId: string;
  actorId: string;
  fileId: string;
  candidateKey: string;
  now: Date;
}

export interface AttachInput {
  workspaceId: string;
  actorId: string;
  requestId: string;
  fileId: string;
  candidateKey: string;
  objectKey: string;
  detectedMime: DocumentMediaType;
  sizeBytes: number;
  checksumSha256: string;
}

export type AttachResult = { status: 'attached'; file: FileRow } | { status: 'lost' };

export interface RejectInput {
  workspaceId: string;
  actorId: string;
  requestId: string;
  fileId: string;
  candidateKey: string;
  reason: string;
}

/** A document copied from a website's own storage, verified, onto one of its leads. */
export interface ImportFileInput {
  workspaceId: string;
  /** Who runs the import (the scheduler), as audited. */
  actorId: string;
  requestId: string;
  fileId: string;
  leadId: string;
  documentType: string;
  bucket: string;
  objectKey: string;
  detectedMime: DocumentMediaType;
  sizeBytes: number;
  checksumSha256: string;
  /** Who the file is shown as from: the old admin. */
  uploadedBy: string;
  /** When the customer gave it, as the website's storage recorded it. */
  uploadedAt: Date;
}

export type ImportFileResult =
  | { status: 'imported'; file: FileRow }
  | { status: 'exists'; file: FileRow }
  | { status: 'lead_not_found' };

export interface DocumentRecordStore {
  createIntent(input: CreateIntentInput): Promise<FileRow>;
  /**
   * Records an imported document as available on a live, unrestricted lead,
   * as the current file of its type (superseding the one before it). Once per
   * file id: a second call returns the file already there.
   */
  insertImportedFile(input: ImportFileInput): Promise<ImportFileResult>;
  claimForVerification(input: ClaimInput): Promise<ClaimResult>;
  attachVerified(input: AttachInput): Promise<AttachResult>;
  markRejected(input: RejectInput): Promise<void>;
  getFile(input: {
    workspaceId: string;
    actorId: string;
    fileId: string;
  }): Promise<FileRow | undefined>;
  listFilesForRecord(input: {
    workspaceId: string;
    actorId: string;
    recordType: DocumentParentType;
    recordId: string;
  }): Promise<StaffFileRow[]>;
  recordReview(input: {
    workspaceId: string;
    actorId: string;
    requestId: string;
    fileId: string;
    decision: FileReviewDecision;
    note?: string;
  }): Promise<{ status: 'recorded'; file: StaffFileRow } | { status: 'not_found' }>;
  tombstone(input: {
    workspaceId: string;
    actorId: string;
    requestId: string;
    fileId: string;
  }): Promise<{ status: 'tombstoned'; file: FileRow } | { status: 'not_found' }>;
  cleanupExpired(input: {
    workspaceId: string;
    actorId: string;
    now: Date;
    graceSeconds: number;
  }): Promise<{ expiredIntents: number; cleanedObjects: string[] }>;
  /** Audit a signed download link (invariant 11); never records customer data. */
  recordDownloadIssued(input: {
    workspaceId: string;
    actorId: string;
    requestId: string;
    fileId: string;
    audience: 'staff' | 'website';
    disposition: 'attachment' | 'inline';
  }): Promise<void>;
}

interface FileDbRow {
  id: string;
  workspaceId: string;
  recordType: string;
  recordId: string;
  documentType: string;
  bucket: string;
  stagingKey: string;
  candidateKey: string | null;
  objectKey: string | null;
  declaredContentType: string;
  detectedMime: string | null;
  declaredSizeBytes: number;
  sizeBytes: number | null;
  checksumSha256: string | null;
  status: string;
  rejectReason: string | null;
  revision: number;
  uploadedBy: string;
  expiresAt: Date;
  finalizedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
}

function asMediaType(value: string | null): DocumentMediaType | null {
  const parsed = documentMediaTypeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function toFileRow(row: FileDbRow): FileRow {
  const declared = asMediaType(row.declaredContentType);
  if (!declared) throw new Error('file row has an unsupported declared content type');
  const status = fileStatusSchema.parse(row.status);
  const recordType = documentParentTypeSchema.parse(row.recordType);
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    recordType,
    recordId: row.recordId,
    documentType: row.documentType,
    bucket: row.bucket,
    stagingKey: row.stagingKey,
    candidateKey: row.candidateKey,
    objectKey: row.objectKey,
    declaredContentType: declared,
    detectedMime: asMediaType(row.detectedMime),
    declaredSizeBytes: row.declaredSizeBytes,
    sizeBytes: row.sizeBytes,
    checksumSha256: row.checksumSha256,
    status,
    rejectReason: row.rejectReason,
    revision: row.revision,
    uploadedBy: row.uploadedBy,
    expiresAt: row.expiresAt,
    finalizedAt: row.finalizedAt,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
  };
}

const fileColumns = {
  id: files.id,
  workspaceId: files.workspaceId,
  recordType: files.recordType,
  recordId: files.recordId,
  documentType: files.documentType,
  bucket: files.bucket,
  stagingKey: files.stagingKey,
  candidateKey: files.candidateKey,
  objectKey: files.objectKey,
  declaredContentType: files.declaredContentType,
  detectedMime: files.detectedMime,
  declaredSizeBytes: files.declaredSizeBytes,
  sizeBytes: files.sizeBytes,
  checksumSha256: files.checksumSha256,
  status: files.status,
  rejectReason: files.rejectReason,
  revision: files.revision,
  uploadedBy: files.uploadedBy,
  expiresAt: files.expiresAt,
  finalizedAt: files.finalizedAt,
  deletedAt: files.deletedAt,
  createdAt: files.createdAt,
};

type DocumentDatabase = Pick<import('@gt-sales/db').DatabaseClient, 'withTenantTx'>;

const defaultDatabase: DocumentDatabase = { withTenantTx };

export class DatabaseDocumentStore implements DocumentRecordStore {
  constructor(private readonly database: DocumentDatabase = defaultDatabase) {}

  async createIntent(input: CreateIntentInput): Promise<FileRow> {
    return this.database.withTenantTx(
      { workspaceId: input.workspaceId, actorId: input.actorId },
      async (tx) => {
        const revision = await nextRevision(
          tx,
          input.workspaceId,
          input.recordType,
          input.recordId,
          input.documentType,
        );
        const [row] = await tx
          .insert(files)
          .values({
            workspaceId: input.workspaceId,
            recordType: input.recordType,
            recordId: input.recordId,
            documentType: input.documentType,
            bucket: input.bucket,
            stagingKey: input.stagingKey,
            declaredContentType: input.declaredContentType,
            declaredSizeBytes: input.declaredSizeBytes,
            status: 'uploading',
            revision,
            uploadedBy: input.actorId,
            expiresAt: input.expiresAt,
          })
          .returning(fileColumns);
        if (!row) throw new Error('file intent insert did not return a row');
        await writeAudit(tx, {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          requestId: input.requestId,
          action: 'file.intent_created',
          fileId: row.id,
          after: { recordType: input.recordType, documentType: input.documentType, revision },
        });
        return toFileRow(row);
      },
    );
  }

  async insertImportedFile(input: ImportFileInput): Promise<ImportFileResult> {
    return this.database.withTenantTx(
      { workspaceId: input.workspaceId, actorId: input.actorId },
      async (tx) => {
        const existing = await selectFile(tx, input.workspaceId, input.fileId);
        if (existing) return { status: 'exists', file: existing };
        const [lead] = await tx
          .select({ id: leads.id })
          .from(leads)
          .where(
            and(
              eq(leads.workspaceId, input.workspaceId),
              eq(leads.id, input.leadId),
              isNull(leads.customerDataRestrictedAt),
            ),
          )
          .limit(1);
        if (!lead) return { status: 'lead_not_found' };

        const revision = await nextRevision(
          tx,
          input.workspaceId,
          'lead',
          input.leadId,
          input.documentType,
        );
        const now = new Date();
        // Never uploaded here, so no staging object: its keys are all the
        // verified copy, which the import alone wrote.
        const [row] = await tx
          .insert(files)
          .values({
            id: input.fileId,
            workspaceId: input.workspaceId,
            recordType: 'lead',
            recordId: input.leadId,
            documentType: input.documentType,
            bucket: input.bucket,
            stagingKey: input.objectKey,
            candidateKey: input.objectKey,
            objectKey: input.objectKey,
            declaredContentType: input.detectedMime,
            detectedMime: input.detectedMime,
            declaredSizeBytes: input.sizeBytes,
            sizeBytes: input.sizeBytes,
            checksumSha256: input.checksumSha256,
            status: 'available',
            revision,
            uploadedBy: input.uploadedBy,
            expiresAt: now,
            finalizedAt: now,
            createdAt: input.uploadedAt,
            updatedAt: now,
          })
          .onConflictDoNothing({ target: files.id })
          .returning(fileColumns);
        if (!row) {
          const raced = await selectFile(tx, input.workspaceId, input.fileId);
          if (!raced) throw new Error('imported file conflicted but cannot be read');
          return { status: 'exists', file: raced };
        }
        const file = toFileRow(row);

        await tx.insert(fileRevisions).values({
          workspaceId: input.workspaceId,
          fileId: file.id,
          revision,
          objectKey: input.objectKey,
          detectedMime: input.detectedMime,
          sizeBytes: input.sizeBytes,
          checksumSha256: input.checksumSha256,
          createdBy: input.uploadedBy,
        });
        await supersedeEarlier(tx, file);
        await writeAudit(tx, {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          requestId: input.requestId,
          action: 'file.imported',
          fileId: file.id,
          after: {
            documentType: input.documentType,
            revision,
            checksumSha256: input.checksumSha256,
          },
        });
        return { status: 'imported', file };
      },
    );
  }

  async claimForVerification(input: ClaimInput): Promise<ClaimResult> {
    return this.database.withTenantTx(
      { workspaceId: input.workspaceId, actorId: input.actorId },
      async (tx) => {
        const [claimed] = await tx
          .update(files)
          .set({ status: 'verifying', candidateKey: input.candidateKey, updatedAt: new Date() })
          .where(
            and(
              eq(files.workspaceId, input.workspaceId),
              eq(files.id, input.fileId),
              eq(files.status, 'uploading'),
              gt(files.expiresAt, input.now),
            ),
          )
          .returning(fileColumns);
        if (claimed) return { status: 'claimed', file: toFileRow(claimed) };

        const [current] = await tx
          .select(fileColumns)
          .from(files)
          .where(and(eq(files.workspaceId, input.workspaceId), eq(files.id, input.fileId)))
          .limit(1);
        if (!current) return { status: 'not_found' };
        const row = toFileRow(current);
        if (row.status === 'available') return { status: 'already_available', file: row };
        if (row.status === 'rejected') return { status: 'already_rejected', file: row };
        if (row.status === 'verifying') return { status: 'in_progress' };
        return { status: 'expired' };
      },
    );
  }

  async attachVerified(input: AttachInput): Promise<AttachResult> {
    return this.database.withTenantTx(
      { workspaceId: input.workspaceId, actorId: input.actorId },
      async (tx) => {
        const [attached] = await tx
          .update(files)
          .set({
            status: 'available',
            objectKey: input.objectKey,
            detectedMime: input.detectedMime,
            sizeBytes: input.sizeBytes,
            checksumSha256: input.checksumSha256,
            rejectReason: null,
            finalizedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(files.workspaceId, input.workspaceId),
              eq(files.id, input.fileId),
              eq(files.status, 'verifying'),
              eq(files.candidateKey, input.candidateKey),
            ),
          )
          .returning(fileColumns);
        if (!attached) return { status: 'lost' };
        const row = toFileRow(attached);

        await tx.insert(fileRevisions).values({
          workspaceId: input.workspaceId,
          fileId: row.id,
          revision: row.revision,
          objectKey: input.objectKey,
          detectedMime: input.detectedMime,
          sizeBytes: input.sizeBytes,
          checksumSha256: input.checksumSha256,
          createdBy: input.actorId,
        });

        await supersedeEarlier(tx, row);

        await writeAudit(tx, {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          requestId: input.requestId,
          action: 'file.attached',
          fileId: row.id,
          after: { revision: row.revision, checksumSha256: input.checksumSha256 },
        });
        return { status: 'attached', file: row };
      },
    );
  }

  async markRejected(input: RejectInput): Promise<void> {
    await this.database.withTenantTx(
      { workspaceId: input.workspaceId, actorId: input.actorId },
      async (tx) => {
        const [row] = await tx
          .update(files)
          .set({ status: 'rejected', rejectReason: input.reason, updatedAt: new Date() })
          .where(
            and(
              eq(files.workspaceId, input.workspaceId),
              eq(files.id, input.fileId),
              eq(files.status, 'verifying'),
              eq(files.candidateKey, input.candidateKey),
            ),
          )
          .returning({ id: files.id });
        if (row) {
          await writeAudit(tx, {
            workspaceId: input.workspaceId,
            actorId: input.actorId,
            requestId: input.requestId,
            action: 'file.rejected',
            fileId: input.fileId,
            after: { reason: input.reason },
          });
        }
      },
    );
  }

  async getFile(input: {
    workspaceId: string;
    actorId: string;
    fileId: string;
  }): Promise<FileRow | undefined> {
    return this.database.withTenantTx(
      { workspaceId: input.workspaceId, actorId: input.actorId },
      (tx) => selectFile(tx, input.workspaceId, input.fileId),
    );
  }

  async listFilesForRecord(input: {
    workspaceId: string;
    actorId: string;
    recordType: DocumentParentType;
    recordId: string;
  }): Promise<StaffFileRow[]> {
    return this.database.withTenantTx(
      { workspaceId: input.workspaceId, actorId: input.actorId },
      async (tx) => {
        const rows = await tx
          .select(fileColumns)
          .from(files)
          .where(
            and(
              eq(files.workspaceId, input.workspaceId),
              eq(files.recordType, input.recordType),
              eq(files.recordId, input.recordId),
            ),
          )
          .orderBy(files.createdAt);
        const result: StaffFileRow[] = [];
        for (const row of rows) {
          const file = toFileRow(row);
          const [review] = await tx
            .select({
              id: fileReviewEvents.id,
              decision: fileReviewEvents.decision,
              note: fileReviewEvents.note,
              actorId: fileReviewEvents.actorId,
              createdAt: fileReviewEvents.createdAt,
            })
            .from(fileReviewEvents)
            .where(
              and(
                eq(fileReviewEvents.workspaceId, input.workspaceId),
                eq(fileReviewEvents.fileId, file.id),
              ),
            )
            .orderBy(sql`${fileReviewEvents.createdAt} desc`)
            .limit(1);
          result.push({
            ...file,
            latestReview: review
              ? {
                  id: review.id,
                  decision: fileReviewDecisionSchema.parse(review.decision),
                  note: review.note,
                  actorId: review.actorId,
                  createdAt: review.createdAt,
                }
              : null,
          });
        }
        return result;
      },
    );
  }

  async recordReview(input: {
    workspaceId: string;
    actorId: string;
    requestId: string;
    fileId: string;
    decision: FileReviewDecision;
    note?: string;
  }): Promise<{ status: 'recorded'; file: StaffFileRow } | { status: 'not_found' }> {
    return this.database.withTenantTx(
      { workspaceId: input.workspaceId, actorId: input.actorId },
      async (tx) => {
        const [file] = await tx
          .select(fileColumns)
          .from(files)
          .where(and(eq(files.workspaceId, input.workspaceId), eq(files.id, input.fileId)))
          .limit(1);
        if (!file) return { status: 'not_found' };
        const [review] = await tx
          .insert(fileReviewEvents)
          .values({
            workspaceId: input.workspaceId,
            fileId: input.fileId,
            actorId: input.actorId,
            decision: input.decision,
            note: input.note ?? null,
          })
          .returning({
            id: fileReviewEvents.id,
            decision: fileReviewEvents.decision,
            note: fileReviewEvents.note,
            actorId: fileReviewEvents.actorId,
            createdAt: fileReviewEvents.createdAt,
          });
        if (!review) throw new Error('review insert did not return a row');
        await writeAudit(tx, {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          requestId: input.requestId,
          action: 'file.reviewed',
          fileId: input.fileId,
          after: { decision: input.decision },
        });
        return {
          status: 'recorded',
          file: {
            ...toFileRow(file),
            latestReview: {
              id: review.id,
              decision: fileReviewDecisionSchema.parse(review.decision),
              note: review.note,
              actorId: review.actorId,
              createdAt: review.createdAt,
            },
          },
        };
      },
    );
  }

  async recordDownloadIssued(input: {
    workspaceId: string;
    actorId: string;
    requestId: string;
    fileId: string;
    audience: 'staff' | 'website';
    disposition: 'attachment' | 'inline';
  }): Promise<void> {
    await this.database.withTenantTx(
      { workspaceId: input.workspaceId, actorId: input.actorId },
      async (tx) => {
        await writeAudit(tx, {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          requestId: input.requestId,
          action: 'file.download_issued',
          fileId: input.fileId,
          after: { audience: input.audience, disposition: input.disposition },
        });
      },
    );
  }

  async tombstone(input: {
    workspaceId: string;
    actorId: string;
    requestId: string;
    fileId: string;
  }): Promise<{ status: 'tombstoned'; file: FileRow } | { status: 'not_found' }> {
    return this.database.withTenantTx(
      { workspaceId: input.workspaceId, actorId: input.actorId },
      async (tx) => {
        const [row] = await tx
          .update(files)
          .set({ status: 'deleted', deletedAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(files.workspaceId, input.workspaceId),
              eq(files.id, input.fileId),
              sql`${files.status} <> 'deleted'`,
            ),
          )
          .returning(fileColumns);
        if (!row) return { status: 'not_found' };
        await writeAudit(tx, {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          requestId: input.requestId,
          action: 'file.deleted',
          fileId: input.fileId,
          after: { status: 'deleted' },
        });
        return { status: 'tombstoned', file: toFileRow(row) };
      },
    );
  }

  async cleanupExpired(input: {
    workspaceId: string;
    actorId: string;
    now: Date;
    graceSeconds: number;
  }): Promise<{ expiredIntents: number; cleanedObjects: string[] }> {
    return this.database.withTenantTx(
      { workspaceId: input.workspaceId, actorId: input.actorId },
      async (tx) => {
        const cutoff = new Date(input.now.getTime() - input.graceSeconds * 1000);
        // Abandoned intents (never finalized) past their expiry-plus-grace, and
        // verifying rows stuck past grace, are rejected so their staging/candidate
        // objects can be swept. Rejected objects past grace become tombstones.
        const expired = await tx
          .update(files)
          .set({ status: 'rejected', rejectReason: 'expired', updatedAt: new Date() })
          .where(
            and(
              eq(files.workspaceId, input.workspaceId),
              sql`${files.status} in ('uploading', 'verifying')`,
              lt(files.expiresAt, cutoff),
            ),
          )
          .returning({ stagingKey: files.stagingKey, candidateKey: files.candidateKey });
        const cleanedObjects = expired.flatMap((row) =>
          [row.stagingKey, row.candidateKey].filter((key): key is string => key !== null),
        );
        return { expiredIntents: expired.length, cleanedObjects };
      },
    );
  }
}

async function selectFile(
  tx: TenantTransaction,
  workspaceId: string,
  fileId: string,
): Promise<FileRow | undefined> {
  const [row] = await tx
    .select(fileColumns)
    .from(files)
    .where(and(eq(files.workspaceId, workspaceId), eq(files.id, fileId)))
    .limit(1);
  return row ? toFileRow(row) : undefined;
}

/**
 * Marks any earlier available object for the same logical slot superseded by
 * `file`, so exactly one current object exists per (record, documentType).
 */
async function supersedeEarlier(tx: TenantTransaction, file: FileRow): Promise<void> {
  await tx
    .update(files)
    .set({ supersededByFileId: file.id, updatedAt: new Date() })
    .where(
      and(
        eq(files.workspaceId, file.workspaceId),
        eq(files.recordType, file.recordType),
        eq(files.recordId, file.recordId),
        eq(files.documentType, file.documentType),
        eq(files.status, 'available'),
        sql`${files.id} <> ${file.id}`,
        sql`${files.supersededByFileId} is null`,
      ),
    );
}

async function nextRevision(
  tx: TenantTransaction,
  workspaceId: string,
  recordType: string,
  recordId: string,
  documentType: string,
): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number>`coalesce(max(${files.revision}), 0)::int` })
    .from(files)
    .where(
      and(
        eq(files.workspaceId, workspaceId),
        eq(files.recordType, recordType),
        eq(files.recordId, recordId),
        eq(files.documentType, documentType),
      ),
    );
  return (row?.max ?? 0) + 1;
}

async function writeAudit(
  tx: TenantTransaction,
  input: {
    workspaceId: string;
    actorId: string;
    requestId: string;
    action: string;
    fileId: string;
    after: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(auditEvents).values({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    actorLabel: 'documents',
    action: input.action,
    entity: 'file',
    entityId: input.fileId,
    requestId: input.requestId,
    after: input.after,
  });
}
