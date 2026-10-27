import type { DocumentMediaType, R2DocumentStore, VerifyUploadRejection } from '@gt-sales/adapters';
import {
  LEGACY_IMPORT_ACTOR_ID,
  type DocumentParentType,
  type FileReviewDecision,
} from '@gt-sales/contracts';

import {
  CLEANUP_GRACE_SECONDS,
  DOWNLOAD_LINK_TTL_SECONDS,
  MAX_DOCUMENT_UPLOAD_BYTES,
  UPLOAD_INTENT_TTL_SECONDS,
  documentBucket,
} from './config.js';
import { candidateKey, importedObjectKey, sanitizedDownloadFilename, stagingKey } from './keys.js';
import type { DocumentRecordStore, FileRow, StaffFileRow } from './store.js';

/**
 * Resolves the commercial context a document needs: the allowed checklist types
 * for a parent record (so an off-checklist upload is refused — REQ 23) and,
 * for the admin panel, the lead a submitted order came from. `found: false`
 * means the parent is not in this workspace, which is how a foreign or unknown
 * attachment id is rejected without leaking its existence.
 */
export interface DocumentContextResolver {
  resolveChecklist(input: {
    workspaceId: string;
    actorId: string;
    recordType: DocumentParentType;
    recordId: string;
  }): Promise<{ found: false } | { found: true; allowed: readonly string[] }>;
  resolveOrderLeadId(input: {
    workspaceId: string;
    actorId: string;
    orderId: string;
  }): Promise<string | undefined>;
}

export interface CreateIntentInput {
  workspaceId: string;
  actorId: string;
  requestId: string;
  recordType: DocumentParentType;
  recordId: string;
  documentType: string;
  declaredContentType: DocumentMediaType;
  declaredSizeBytes: number;
}

export type CreateIntentOutcome =
  | {
      status: 'created';
      uploadId: string;
      url: string;
      headers: Record<string, string>;
      expiresAt: Date;
    }
  | { status: 'parent_not_found' }
  | { status: 'checklist_mismatch' }
  | { status: 'too_large' };

export interface FinalizeInput {
  workspaceId: string;
  actorId: string;
  requestId: string;
  fileId: string;
  checksumSha256: string;
  /** When set (website caller), the file must be a lead document owned by this lead. */
  ownedLeadId?: string;
}

export type FinalizeOutcome =
  | { status: 'available'; file: FileRow }
  | { status: 'rejected'; file: FileRow | null; reason: VerifyUploadRejection }
  | { status: 'in_progress' }
  | { status: 'expired' }
  | { status: 'not_found' };

export type DownloadOutcome =
  | { status: 'issued'; url: string; expiresAt: Date }
  | { status: 'not_found' }
  | { status: 'not_available' };

export interface ImportWebsiteDocumentInput {
  workspaceId: string;
  actorId: string;
  requestId: string;
  /** The import job's message id: one job, one file, however often it runs. */
  fileId: string;
  leadId: string;
  documentType: string;
  /** The website's own object (`orders/<lead id>/passport.pdf`), only ever read. */
  sourceKey: string;
  /** When the customer gave it, as the website's storage recorded it. */
  uploadedAt?: Date;
}

export type ImportWebsiteDocumentOutcome =
  | { status: 'imported' | 'already_imported'; file: FileRow }
  | { status: 'lead_not_found' }
  | { status: 'source_missing' }
  | { status: 'rejected'; reason: 'too_large' | 'unsupported_signature' };

/**
 * Consulted by `runCleanup` so expired-upload sweeps cannot physically delete
 * an R2 object while the independent backup runner's referenced-object
 * manifest or copy step is in flight (IMPLEMENTATION_PLAN §13: "Prevent object
 * cleanup racing the archive with a snapshot reference set and lease."). The
 * default no-op keeps every existing caller and test behaviour unchanged.
 */
export interface BackupLeaseGate {
  isActive(): Promise<boolean>;
}

export interface DocumentServiceOptions {
  maxBytes?: number;
  intentTtlSeconds?: number;
  downloadTtlSeconds?: number;
  cleanupGraceSeconds?: number;
  bucket?: string;
  now?: () => Date;
  backupLease?: BackupLeaseGate;
}

/**
 * Orchestrates the secure upload/verify/attach/download lifecycle. All external
 * R2 work happens outside any DB transaction/row lock (invariant 7); the store's
 * conditional updates provide the concurrency and idempotency guarantees.
 */
export class DocumentService {
  private readonly maxBytes: number;
  private readonly intentTtlSeconds: number;
  private readonly downloadTtlSeconds: number;
  private readonly cleanupGraceSeconds: number;
  private readonly bucket: string;
  private readonly now: () => Date;
  private readonly backupLease: BackupLeaseGate;

  constructor(
    private readonly store: DocumentRecordStore,
    private readonly r2: R2DocumentStore,
    private readonly resolver: DocumentContextResolver,
    options: DocumentServiceOptions = {},
  ) {
    this.maxBytes = options.maxBytes ?? MAX_DOCUMENT_UPLOAD_BYTES;
    this.intentTtlSeconds = options.intentTtlSeconds ?? UPLOAD_INTENT_TTL_SECONDS;
    this.downloadTtlSeconds = options.downloadTtlSeconds ?? DOWNLOAD_LINK_TTL_SECONDS;
    this.cleanupGraceSeconds = options.cleanupGraceSeconds ?? CLEANUP_GRACE_SECONDS;
    this.bucket = options.bucket ?? documentBucket();
    this.now = options.now ?? (() => new Date());
    this.backupLease = options.backupLease ?? { isActive: async () => false };
  }

  async createIntent(input: CreateIntentInput): Promise<CreateIntentOutcome> {
    if (input.declaredSizeBytes > this.maxBytes) return { status: 'too_large' };

    const checklist = await this.resolver.resolveChecklist({
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      recordType: input.recordType,
      recordId: input.recordId,
    });
    if (!checklist.found) return { status: 'parent_not_found' };
    if (!checklist.allowed.includes(input.documentType)) return { status: 'checklist_mismatch' };

    const key = stagingKey(input.workspaceId);
    const presigned = await this.r2.createUpload({
      workspaceId: input.workspaceId,
      stagingKey: key,
      declaredContentType: input.declaredContentType,
      declaredSizeBytes: input.declaredSizeBytes,
      maxBytes: this.maxBytes,
      expiresInSeconds: this.intentTtlSeconds,
    });
    const file = await this.store.createIntent({
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      requestId: input.requestId,
      recordType: input.recordType,
      recordId: input.recordId,
      documentType: input.documentType,
      bucket: this.bucket,
      stagingKey: key,
      declaredContentType: input.declaredContentType,
      declaredSizeBytes: input.declaredSizeBytes,
      expiresAt: new Date(this.now().getTime() + this.intentTtlSeconds * 1000),
    });
    return {
      status: 'created',
      uploadId: file.id,
      url: presigned.url,
      headers: presigned.headers,
      expiresAt: presigned.expiresAt,
    };
  }

  async finalize(input: FinalizeInput): Promise<FinalizeOutcome> {
    // Website callers may only finalize their own lead's document. The record id
    // is immutable, so this pre-check is safe before the atomic claim and stops
    // one draft touching another draft's file within the same workspace.
    if (input.ownedLeadId !== undefined) {
      const owned = await this.store.getFile({
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        fileId: input.fileId,
      });
      if (!owned || owned.recordType !== 'lead' || owned.recordId !== input.ownedLeadId) {
        return { status: 'not_found' };
      }
    }
    const candidate = candidateKey(input.workspaceId);
    const claim = await this.store.claimForVerification({
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      fileId: input.fileId,
      candidateKey: candidate,
      now: this.now(),
    });
    if (claim.status === 'not_found') return { status: 'not_found' };
    if (claim.status === 'expired') return { status: 'expired' };
    if (claim.status === 'in_progress') return { status: 'in_progress' };
    if (claim.status === 'already_available') return { status: 'available', file: claim.file };
    if (claim.status === 'already_rejected') {
      return {
        status: 'rejected',
        file: claim.file,
        reason: rejectionFromReason(claim.file.rejectReason),
      };
    }

    // Claimed: copy staging → candidate and verify the CANDIDATE only.
    const verified = await this.r2.verifyUpload({
      workspaceId: input.workspaceId,
      stagingKey: claim.file.stagingKey,
      candidateKey: candidate,
      expectedChecksumSha256: input.checksumSha256,
      maxBytes: this.maxBytes,
    });

    if (verified.status === 'rejected') {
      await this.store.markRejected({
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        requestId: input.requestId,
        fileId: input.fileId,
        candidateKey: candidate,
        reason: verified.reason,
      });
      return { status: 'rejected', file: null, reason: verified.reason };
    }

    // Attach the exact verified candidate object (never the mutable staging one).
    const attached = await this.store.attachVerified({
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      requestId: input.requestId,
      fileId: input.fileId,
      candidateKey: candidate,
      objectKey: verified.candidateKey,
      detectedMime: verified.detectedMediaType,
      sizeBytes: verified.sizeBytes,
      checksumSha256: verified.checksumSha256,
    });
    if (attached.status === 'lost') {
      // Another finalize won the race; return that consistent outcome.
      const current = await this.store.getFile({
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        fileId: input.fileId,
      });
      if (current?.status === 'available') return { status: 'available', file: current };
      if (current?.status === 'rejected') {
        return {
          status: 'rejected',
          file: current,
          reason: rejectionFromReason(current.rejectReason),
        };
      }
      return { status: 'in_progress' };
    }
    return { status: 'available', file: attached.file };
  }

  /**
   * Copies a document a website kept in its own storage (Get Canada Sim's
   * passports, approval letters, SIM photos…) onto the lead it belongs to:
   * verified like an upload (size, signature, its own checksum), then current
   * for its type, shown as from the old admin. Storage work runs outside any
   * transaction (invariant 7); a copy nothing records is removed again.
   */
  async importWebsiteDocument(
    input: ImportWebsiteDocumentInput,
  ): Promise<ImportWebsiteDocumentOutcome> {
    const scope = { workspaceId: input.workspaceId, actorId: input.actorId };
    const existing = await this.store.getFile({ ...scope, fileId: input.fileId });
    if (existing) return { status: 'already_imported', file: existing };
    // A lead that is gone or restricted takes no documents.
    const lead = await this.resolver.resolveChecklist({
      ...scope,
      recordType: 'lead',
      recordId: input.leadId,
    });
    if (!lead.found) return { status: 'lead_not_found' };

    const objectKey = importedObjectKey(input.workspaceId, input.fileId);
    const copied = await this.r2.importObject({
      workspaceId: input.workspaceId,
      sourceKey: input.sourceKey,
      candidateKey: objectKey,
      maxBytes: this.maxBytes,
    });
    if (copied.status === 'rejected') {
      if (copied.reason === 'source_missing') return { status: 'source_missing' };
      await this.discardCopy(input.workspaceId, objectKey);
      return { status: 'rejected', reason: copied.reason };
    }
    // Files hold PDF, JPEG and PNG only (the recorded decision), never WebP.
    if (copied.detectedMediaType === 'image/webp') {
      await this.discardCopy(input.workspaceId, objectKey);
      return { status: 'rejected', reason: 'unsupported_signature' };
    }

    const stored = await this.store.insertImportedFile({
      ...scope,
      requestId: input.requestId,
      fileId: input.fileId,
      leadId: input.leadId,
      documentType: input.documentType,
      bucket: this.bucket,
      objectKey: copied.candidateKey,
      detectedMime: copied.detectedMediaType,
      sizeBytes: copied.sizeBytes,
      checksumSha256: copied.checksumSha256,
      uploadedBy: LEGACY_IMPORT_ACTOR_ID,
      uploadedAt: input.uploadedAt ?? this.now(),
    });
    if (stored.status === 'lead_not_found') {
      await this.discardCopy(input.workspaceId, objectKey);
      return { status: 'lead_not_found' };
    }
    return {
      status: stored.status === 'exists' ? 'already_imported' : 'imported',
      file: stored.file,
    };
  }

  /** Best-effort: an orphaned private copy is the smaller problem next to a failed import. */
  private async discardCopy(workspaceId: string, objectKey: string): Promise<void> {
    try {
      await this.r2.deleteObject({ workspaceId, bucket: this.bucket, objectKey });
    } catch {
      // Left for an operator; it is never served, as no file row points at it.
    }
  }

  /**
   * Copies an available file's verified object into another bucket at an exact
   * key: the transitional copy of an ID photo into the old admin's bucket
   * (migrations 0005–0006). Storage work, so never inside a transaction
   * (invariant 7).
   */
  async copyAvailableToBucket(input: {
    workspaceId: string;
    file: FileRow;
    destinationBucket: string;
    destinationKey: string;
  }): Promise<void> {
    if (input.file.status !== 'available' || !input.file.objectKey) {
      throw new Error('file_not_available');
    }
    await this.r2.copyToBucket({
      workspaceId: input.workspaceId,
      objectKey: input.file.objectKey,
      destinationBucket: input.destinationBucket,
      destinationKey: input.destinationKey,
    });
  }

  /** Best-effort undo of `copyAvailableToBucket`, for a copy nothing ended up linking to. */
  async removeBucketCopy(input: { bucket: string; key: string }): Promise<void> {
    await this.r2.deleteFromBucket(input);
  }

  async issueDownload(input: {
    workspaceId: string;
    actorId: string;
    fileId: string;
    requestId: string;
    /** When set (website caller), the file must be a lead document owned by this lead. */
    ownedLeadId?: string;
    /** `inline` is staff viewing the file in a tab of its own; a website always downloads. */
    disposition?: 'attachment' | 'inline';
  }): Promise<DownloadOutcome> {
    const file = await this.store.getFile(input);
    if (!file) return { status: 'not_found' };
    if (input.ownedLeadId !== undefined) {
      if (file.recordType !== 'lead' || file.recordId !== input.ownedLeadId) {
        return { status: 'not_found' };
      }
    }
    if (file.status !== 'available' || !file.objectKey || !file.detectedMime) {
      return { status: 'not_available' };
    }
    const audience = input.ownedLeadId === undefined ? 'staff' : 'website';
    const disposition = audience === 'staff' ? (input.disposition ?? 'attachment') : 'attachment';
    const link = await this.r2.issueDownload({
      workspaceId: input.workspaceId,
      objectKey: file.objectKey,
      fileName: sanitizedDownloadFilename(file.documentType, file.id, file.detectedMime),
      contentType: file.detectedMime,
      expiresInSeconds: this.downloadTtlSeconds,
      disposition,
    });
    // Audited after the presign, in its own short transaction: no external
    // call ever runs inside a tenant transaction (invariant 7).
    await this.store.recordDownloadIssued({
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      requestId: input.requestId,
      fileId: file.id,
      audience,
      disposition,
    });
    return { status: 'issued', url: link.url, expiresAt: link.expiresAt };
  }

  async listForOrder(input: {
    workspaceId: string;
    actorId: string;
    orderId: string;
  }): Promise<{ status: 'found'; files: StaffFileRow[] } | { status: 'not_found' }> {
    const leadId = await this.resolver.resolveOrderLeadId(input);
    if (!leadId) return { status: 'not_found' };
    const [orderFiles, leadFiles] = await Promise.all([
      this.store.listFilesForRecord({
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        recordType: 'order',
        recordId: input.orderId,
      }),
      this.store.listFilesForRecord({
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        recordType: 'lead',
        recordId: leadId,
      }),
    ]);
    return { status: 'found', files: [...leadFiles, ...orderFiles] };
  }

  async review(input: {
    workspaceId: string;
    actorId: string;
    requestId: string;
    fileId: string;
    decision: FileReviewDecision;
    note?: string;
  }): Promise<{ status: 'recorded'; file: StaffFileRow } | { status: 'not_found' }> {
    return this.store.recordReview(input);
  }

  async remove(input: {
    workspaceId: string;
    actorId: string;
    requestId: string;
    fileId: string;
  }): Promise<{ status: 'tombstoned'; file: FileRow } | { status: 'not_found' }> {
    return this.store.tombstone(input);
  }

  async runCleanup(input: {
    workspaceId: string;
    actorId: string;
  }): Promise<{ expiredIntents: number; cleanedObjects: string[] }> {
    // REL-18: check the lease before touching any row. Marking rows rejected
    // and then withholding their keys would lose those keys for good: a later
    // pass only finds rows still uploading/verifying. Skipping the whole pass
    // leaves them for the next one, after the backup.
    if (await this.backupLease.isActive()) return { expiredIntents: 0, cleanedObjects: [] };
    return this.store.cleanupExpired({
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      now: this.now(),
      graceSeconds: this.cleanupGraceSeconds,
    });
  }

  /**
   * The scheduled sweep: expires abandoned upload intents, then deletes their
   * staging/candidate objects from R2. Deletes are best-effort, so one R2 error
   * never aborts the sweep; a failed object is counted, never retried blindly.
   */
  async sweepExpired(input: {
    workspaceId: string;
    actorId: string;
  }): Promise<{ expiredIntents: number; deletedObjects: number; failedDeletes: number }> {
    const result = await this.runCleanup(input);
    let deletedObjects = 0;
    let failedDeletes = 0;
    for (const objectKey of result.cleanedObjects) {
      try {
        await this.r2.deleteObject({
          workspaceId: input.workspaceId,
          bucket: this.bucket,
          objectKey,
        });
        deletedObjects += 1;
      } catch {
        failedDeletes += 1;
      }
    }
    return { expiredIntents: result.expiredIntents, deletedObjects, failedDeletes };
  }
}

function rejectionFromReason(reason: string | null): VerifyUploadRejection {
  switch (reason) {
    case 'too_large':
    case 'unsupported_signature':
    case 'checksum_mismatch':
    case 'staging_missing':
      return reason;
    default:
      return 'unsupported_signature';
  }
}
