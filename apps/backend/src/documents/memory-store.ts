import { randomUUID } from 'node:crypto';

import type { DocumentParentType, FileReviewDecision } from '@gt-sales/contracts';

import type { DocumentContextResolver } from './service.js';
import type {
  AttachInput,
  AttachResult,
  ClaimInput,
  ClaimResult,
  CreateIntentInput,
  DocumentRecordStore,
  FileRow,
  ImportFileInput,
  ImportFileResult,
  RejectInput,
  ReviewEventRow,
  StaffFileRow,
} from './store.js';

/**
 * Deterministic in-memory `DocumentRecordStore` for unit tests. It reproduces
 * the atomic semantics of the DB store: `claimForVerification` only transitions
 * `uploading → verifying` once, and `attachVerified` only attaches while the
 * row is still `verifying` with the caller's candidate key — so concurrent and
 * repeated finalize calls resolve to exactly one attached object, exactly as the
 * conditional SQL updates do in Postgres.
 */
export class InMemoryDocumentRecordStore implements DocumentRecordStore {
  private readonly rows = new Map<string, FileRow>();
  private readonly reviews = new Map<string, ReviewEventRow[]>();
  private readonly held = new Set<string>();
  readonly audits: { action: string; fileId: string; audience: string; disposition: string }[] = [];

  async recordDownloadIssued(input: {
    fileId: string;
    audience: 'staff' | 'website';
    disposition: 'attachment' | 'inline';
  }): Promise<void> {
    this.audits.push({
      action: 'file.download_issued',
      fileId: input.fileId,
      audience: input.audience,
      disposition: input.disposition,
    });
  }

  /** The file was created held for a change request (`CreateIntentInput.held`). */
  isHeld(fileId: string): boolean {
    return this.held.has(fileId);
  }

  snapshot(fileId: string): FileRow | undefined {
    const row = this.rows.get(fileId);
    return row ? { ...row } : undefined;
  }

  async createIntent(input: CreateIntentInput): Promise<FileRow> {
    const revision =
      Math.max(
        0,
        ...[...this.rows.values()]
          .filter(
            (row) =>
              row.recordType === input.recordType &&
              row.recordId === input.recordId &&
              row.documentType === input.documentType,
          )
          .map((row) => row.revision),
      ) + 1;
    const row: FileRow = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      recordType: input.recordType,
      recordId: input.recordId,
      documentType: input.documentType,
      bucket: input.bucket,
      stagingKey: input.stagingKey,
      candidateKey: null,
      objectKey: null,
      declaredContentType: input.declaredContentType,
      detectedMime: null,
      declaredSizeBytes: input.declaredSizeBytes,
      sizeBytes: null,
      checksumSha256: null,
      status: 'uploading',
      rejectReason: null,
      revision,
      uploadedBy: input.actorId,
      expiresAt: input.expiresAt,
      finalizedAt: null,
      deletedAt: null,
      createdAt: new Date(),
    };
    this.rows.set(row.id, row);
    if (input.held) this.held.add(row.id);
    return { ...row };
  }

  /** Has no leads of its own: the service's resolver check stands in for the lead's. */
  async insertImportedFile(input: ImportFileInput): Promise<ImportFileResult> {
    const existing = this.rows.get(input.fileId);
    if (existing) return { status: 'exists', file: { ...existing } };
    const slot = [...this.rows.values()].filter(
      (row) =>
        row.workspaceId === input.workspaceId &&
        row.recordType === 'lead' &&
        row.recordId === input.leadId &&
        row.documentType === input.documentType,
    );
    const row: FileRow = {
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
      rejectReason: null,
      revision: Math.max(0, ...slot.map((earlier) => earlier.revision)) + 1,
      uploadedBy: input.uploadedBy,
      expiresAt: new Date(),
      finalizedAt: new Date(),
      deletedAt: null,
      createdAt: input.uploadedAt,
    };
    this.rows.set(row.id, row);
    return { status: 'imported', file: { ...row } };
  }

  async claimForVerification(input: ClaimInput): Promise<ClaimResult> {
    const row = this.rows.get(input.fileId);
    if (!row || row.workspaceId !== input.workspaceId) return { status: 'not_found' };
    if (row.status === 'uploading') {
      if (row.expiresAt.getTime() <= input.now.getTime()) return { status: 'expired' };
      row.status = 'verifying';
      row.candidateKey = input.candidateKey;
      return { status: 'claimed', file: { ...row } };
    }
    if (row.status === 'available') return { status: 'already_available', file: { ...row } };
    if (row.status === 'rejected') return { status: 'already_rejected', file: { ...row } };
    if (row.status === 'verifying') return { status: 'in_progress' };
    return { status: 'expired' };
  }

  async attachVerified(input: AttachInput): Promise<AttachResult> {
    const row = this.rows.get(input.fileId);
    if (
      !row ||
      row.workspaceId !== input.workspaceId ||
      row.status !== 'verifying' ||
      row.candidateKey !== input.candidateKey
    ) {
      return { status: 'lost' };
    }
    row.status = 'available';
    row.objectKey = input.objectKey;
    row.detectedMime = input.detectedMime;
    row.sizeBytes = input.sizeBytes;
    row.checksumSha256 = input.checksumSha256;
    row.rejectReason = null;
    row.finalizedAt = new Date();
    return { status: 'attached', file: { ...row } };
  }

  async markRejected(input: RejectInput): Promise<void> {
    const row = this.rows.get(input.fileId);
    if (row && row.status === 'verifying' && row.candidateKey === input.candidateKey) {
      row.status = 'rejected';
      row.rejectReason = input.reason;
    }
  }

  async getFile(input: { workspaceId: string; fileId: string }): Promise<FileRow | undefined> {
    const row = this.rows.get(input.fileId);
    return row && row.workspaceId === input.workspaceId ? { ...row } : undefined;
  }

  async listFilesForRecord(input: {
    workspaceId: string;
    recordType: DocumentParentType;
    recordId: string;
  }): Promise<StaffFileRow[]> {
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.workspaceId === input.workspaceId &&
          row.recordType === input.recordType &&
          row.recordId === input.recordId,
      )
      .map((row) => ({ ...row, latestReview: this.latestReview(row.id) }));
  }

  async recordReview(input: {
    workspaceId: string;
    actorId: string;
    fileId: string;
    decision: FileReviewDecision;
    note?: string;
  }): Promise<{ status: 'recorded'; file: StaffFileRow } | { status: 'not_found' }> {
    const row = this.rows.get(input.fileId);
    if (!row || row.workspaceId !== input.workspaceId) return { status: 'not_found' };
    const event: ReviewEventRow = {
      id: randomUUID(),
      decision: input.decision,
      note: input.note ?? null,
      actorId: input.actorId,
      createdAt: new Date(),
    };
    const list = this.reviews.get(row.id) ?? [];
    list.push(event);
    this.reviews.set(row.id, list);
    return { status: 'recorded', file: { ...row, latestReview: event } };
  }

  async tombstone(input: {
    workspaceId: string;
    fileId: string;
  }): Promise<{ status: 'tombstoned'; file: FileRow } | { status: 'not_found' }> {
    const row = this.rows.get(input.fileId);
    if (!row || row.workspaceId !== input.workspaceId || row.status === 'deleted') {
      return { status: 'not_found' };
    }
    row.status = 'deleted';
    row.deletedAt = new Date();
    return { status: 'tombstoned', file: { ...row } };
  }

  async cleanupExpired(input: {
    workspaceId: string;
    now: Date;
    graceSeconds: number;
  }): Promise<{ expiredIntents: number; cleanedObjects: string[] }> {
    const cutoff = input.now.getTime() - input.graceSeconds * 1000;
    const cleanedObjects: string[] = [];
    let expiredIntents = 0;
    for (const row of this.rows.values()) {
      if (
        row.workspaceId === input.workspaceId &&
        (row.status === 'uploading' || row.status === 'verifying') &&
        row.expiresAt.getTime() < cutoff
      ) {
        row.status = 'rejected';
        row.rejectReason = 'expired';
        expiredIntents += 1;
        cleanedObjects.push(row.stagingKey);
        if (row.candidateKey) cleanedObjects.push(row.candidateKey);
      }
    }
    return { expiredIntents, cleanedObjects };
  }

  private latestReview(fileId: string): ReviewEventRow | null {
    const list = this.reviews.get(fileId);
    return list && list.length > 0 ? (list[list.length - 1] ?? null) : null;
  }
}

/** In-memory resolver: configure the allowed checklist per parent and order→lead links. */
export class InMemoryDocumentContextResolver implements DocumentContextResolver {
  private readonly checklists = new Map<string, readonly string[]>();
  private readonly orderLeads = new Map<string, string>();

  setChecklist(recordType: DocumentParentType, recordId: string, allowed: readonly string[]): void {
    this.checklists.set(`${recordType}:${recordId}`, allowed);
  }

  linkOrderLead(orderId: string, leadId: string): void {
    this.orderLeads.set(orderId, leadId);
  }

  async resolveChecklist(input: {
    recordType: DocumentParentType;
    recordId: string;
  }): Promise<{ found: false } | { found: true; allowed: readonly string[] }> {
    const allowed = this.checklists.get(`${input.recordType}:${input.recordId}`);
    return allowed ? { found: true, allowed } : { found: false };
  }

  async resolveOrderLeadId(input: { orderId: string }): Promise<string | undefined> {
    return this.orderLeads.get(input.orderId);
  }
}
