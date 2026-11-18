import { randomBytes, randomUUID } from 'node:crypto';

import type { R2DocumentStore } from '@gt-sales/adapters';
import {
  AI_ATTACHMENT_MEDIA_TYPES,
  AI_CHAT_LIMITS,
  aiAttachmentKindOf,
  aiAttachmentMaxBytes,
  type AiAttachmentKind,
  type AiAttachmentMediaType,
  type AiAttachmentRejectReason,
  type AiAttachmentSummary,
} from '@gt-sales/contracts';

import {
  AI_ATTACHMENT_SWEEP_BATCH,
  AI_ATTACHMENT_UNSENT_TTL_MS,
  type AiAttachmentRecord,
  type AiAttachmentStore,
  type StoredObject,
} from './attachment-store.js';
import type { AiTurnAttachment } from './conversation-store.js';

/**
 * Ask AI attachments, end to end, on the documents feature's storage pattern:
 * the browser PUTs straight to a signed staging object (the backend never
 * receives the bytes over its JSON API); finalize copies it where the browser
 * cannot write and checks that copy's size, checksum and bytes; only then is
 * the file `ready` to be sent with a message. The real type is decided by the
 * bytes (magic numbers for images and PDFs; a strict UTF-8 decode with no NUL
 * for text), never by the name or the browser's claim.
 *
 * Objects live in the documents bucket under their own prefix,
 * `ai-attachments/<random>/`, inside the adapter's per-site prefix
 * (`workspaces/<site>/`), so they are never confused with a lead's documents
 * and never appear in `app.files`. Nothing here logs a name, a byte or a
 * line of text.
 */

/** The signed PUT's lifetime (the documents feature's). */
export const AI_ATTACHMENT_UPLOAD_TTL_SECONDS = 5 * 60;
/** A signed GET's lifetime (the documents feature's download link). */
export const AI_ATTACHMENT_LINK_TTL_SECONDS = 2 * 60;

const OBJECT_PREFIX = 'ai-attachments';

/** A file's served object and the staging object its upload goes to, side by side. */
export function aiAttachmentObjectKeys(objectKey: string): { file: string; staging: string } {
  if (!objectKey.startsWith(`${OBJECT_PREFIX}/`) || !objectKey.endsWith('/file')) {
    throw new Error('ai_attachment_key_invalid');
  }
  return { file: objectKey, staging: `${objectKey.slice(0, -'/file'.length)}/upload` };
}

function newObjectKey(): string {
  return `${OBJECT_PREFIX}/${randomUUID()}-${randomBytes(8).toString('hex')}/file`;
}

/**
 * The name a file is shown under: one line of at most `maxFileNameChars`
 * characters, without control, format or separator characters and without
 * a path (`/` or `\`). It is only ever displayed; storage keys and download
 * names never derive from it.
 */
export function sanitizeAttachmentFileName(name: string): string {
  const cleaned = name
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}/\\]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const clipped = Array.from(cleaned).slice(0, AI_CHAT_LIMITS.maxFileNameChars).join('').trim();
  return clipped.length > 0 ? clipped : 'file';
}

const EXTENSIONS: Record<AiAttachmentMediaType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/markdown': 'md',
};

/** The download's file name: from the id and the verified type, as the documents download does. */
export function aiAttachmentDownloadName(id: string, mediaType: AiAttachmentMediaType): string {
  return `attachment-${id.replace(/[^a-z0-9]/gi, '').slice(0, 12)}.${EXTENSIONS[mediaType]}`;
}

/** The file picker's `accept` list for the enabled kinds: media types and extensions. */
export function aiAttachmentAccept(kinds: readonly AiAttachmentKind[]): string[] {
  const extensions: Record<AiAttachmentKind, readonly string[]> = {
    image: ['.png', '.jpg', '.jpeg', '.webp'],
    pdf: ['.pdf'],
    text: ['.txt', '.csv', '.md'],
  };
  return kinds.flatMap((kind) => [...AI_ATTACHMENT_MEDIA_TYPES[kind], ...extensions[kind]]);
}

/**
 * A text file's text, or why not: strict UTF-8 (a byte-order mark is
 * dropped), no NUL, something besides white space, clipped to
 * `maxExtractedTextChars` characters.
 */
export function extractAttachmentText(
  bytes: Uint8Array,
): { status: 'ok'; text: string } | { status: 'rejected'; reason: 'unreadable' | 'empty' } {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { status: 'rejected', reason: 'unreadable' };
  }
  if (text.includes('\u0000')) return { status: 'rejected', reason: 'unreadable' };
  if (text.trim().length === 0) return { status: 'rejected', reason: 'empty' };
  const characters = Array.from(text);
  return {
    status: 'ok',
    text:
      characters.length <= AI_CHAT_LIMITS.maxExtractedTextChars
        ? text
        : characters.slice(0, AI_CHAT_LIMITS.maxExtractedTextChars).join(''),
  };
}

export function attachmentSummary(record: AiAttachmentRecord): AiAttachmentSummary {
  return {
    id: record.id,
    kind: record.kind,
    mediaType: record.mediaType,
    fileName: record.fileName,
    byteSize: record.byteSize,
  };
}

interface Scope {
  readonly workspaceId: string;
  readonly actorId: string;
}

export type CreateAttachmentIntentOutcome =
  | {
      status: 'created';
      uploadId: string;
      url: string;
      headers: Record<string, string>;
      expiresAt: Date;
    }
  | { status: 'rejected'; reason: AiAttachmentRejectReason };

export type FinalizeAttachmentOutcome =
  | { status: 'ready'; attachment: AiAttachmentSummary }
  | { status: 'rejected'; reason: AiAttachmentRejectReason }
  | { status: 'not_found' };

export interface AiAttachmentServiceOptions {
  /** The documents bucket; every attachment row records it. */
  readonly bucket: string;
  /** The kinds the deployment accepts (`AI_ATTACHMENT_KINDS`). */
  readonly kinds: readonly AiAttachmentKind[];
  readonly now?: () => Date;
}

export class AiAttachmentService {
  readonly kinds: readonly AiAttachmentKind[];
  private readonly now: () => Date;

  constructor(
    private readonly store: AiAttachmentStore,
    private readonly objects: R2DocumentStore,
    private readonly options: AiAttachmentServiceOptions,
  ) {
    this.kinds = options.kinds;
    this.now = options.now ?? (() => new Date());
  }

  /** Validates the browser's claim, creates the pending row and signs the upload. */
  async createIntent(
    scope: Scope,
    input: { fileName: string; mediaType: AiAttachmentMediaType; byteSize: number },
  ): Promise<CreateAttachmentIntentOutcome> {
    const kind = aiAttachmentKindOf(input.mediaType);
    if (!this.kinds.includes(kind)) return { status: 'rejected', reason: 'type' };
    if (input.byteSize > aiAttachmentMaxBytes(kind)) return { status: 'rejected', reason: 'size' };
    const id = randomUUID();
    const objectKey = newObjectKey();
    const keys = aiAttachmentObjectKeys(objectKey);
    const upload = await this.objects.createUpload({
      workspaceId: scope.workspaceId,
      stagingKey: keys.staging,
      declaredContentType: input.mediaType,
      declaredSizeBytes: input.byteSize,
      maxBytes: aiAttachmentMaxBytes(kind),
      expiresInSeconds: AI_ATTACHMENT_UPLOAD_TTL_SECONDS,
    });
    await this.store.createPending(scope, {
      id,
      kind,
      mediaType: input.mediaType,
      fileName: sanitizeAttachmentFileName(input.fileName),
      byteSize: input.byteSize,
      bucket: this.options.bucket,
      objectKey,
    });
    return {
      status: 'created',
      uploadId: id,
      url: upload.url,
      headers: upload.headers,
      expiresAt: upload.expiresAt,
    };
  }

  /**
   * Verifies the upload by its bytes and makes it ready. Any mismatch removes
   * the row and both objects and says why, as a safe reason.
   */
  async finalize(
    scope: Scope,
    attachmentId: string,
    checksumSha256: string,
  ): Promise<FinalizeAttachmentOutcome> {
    const row = await this.store.get(scope, attachmentId);
    if (!row) return { status: 'not_found' };
    if (row.status === 'ready') return { status: 'ready', attachment: attachmentSummary(row) };
    const reject = async (reason: AiAttachmentRejectReason): Promise<FinalizeAttachmentOutcome> => {
      await this.discard(scope, row.id);
      return { status: 'rejected', reason };
    };
    if (!this.kinds.includes(row.kind)) return reject('type');

    const keys = aiAttachmentObjectKeys(row.objectKey);
    const verified = await this.objects.verifyAttachmentUpload({
      workspaceId: scope.workspaceId,
      stagingKey: keys.staging,
      candidateKey: keys.file,
      expectedChecksumSha256: checksumSha256,
      maxBytes: aiAttachmentMaxBytes(row.kind),
    });
    if (verified.status === 'rejected') {
      return reject(verified.reason === 'too_large' ? 'size' : 'unreadable');
    }
    if (verified.sizeBytes === 0) return reject('empty');
    if (verified.sizeBytes !== row.byteSize) return reject('size');

    // The bytes decide the type; a claim of another kind is refused, and
    // within a kind the detected type is the one kept.
    let mediaType: AiAttachmentMediaType = row.mediaType;
    let extractedText: string | null = null;
    const detected = verified.detectedMediaType;
    if (row.kind === 'text') {
      if (detected !== undefined) return reject('type');
      const read = await this.objects.readObject({
        workspaceId: scope.workspaceId,
        objectKey: keys.file,
        maxBytes: AI_CHAT_LIMITS.maxTextFileBytes,
      });
      if (read.status !== 'read')
        return reject(read.status === 'too_large' ? 'size' : 'unreadable');
      const text = extractAttachmentText(read.bytes);
      if (text.status === 'rejected') return reject(text.reason);
      extractedText = text.text;
    } else {
      if (detected === undefined || aiAttachmentKindOf(detected) !== row.kind) {
        return reject('type');
      }
      mediaType = detected;
    }

    const ready = await this.store.markReady(scope, row.id, {
      mediaType,
      byteSize: verified.sizeBytes,
      sha256: verified.checksumSha256,
      extractedText,
    });
    // The browser can no longer change the upload; its staging object goes.
    await this.deleteQuietly(scope, keys.staging, row.bucket);
    if (ready) return { status: 'ready', attachment: attachmentSummary(ready) };
    // A concurrent finalize got there first (or the file was removed meanwhile).
    const current = await this.store.get(scope, row.id);
    return current?.status === 'ready'
      ? { status: 'ready', attachment: attachmentSummary(current) }
      : { status: 'not_found' };
  }

  /** Removes an unsent file, row and objects. */
  async remove(scope: Scope, attachmentId: string): Promise<'removed' | 'sent' | 'not_found'> {
    const row = await this.store.get(scope, attachmentId);
    if (!row) return 'not_found';
    if (row.messageId !== null) return 'sent';
    return (await this.discard(scope, row.id)) ? 'removed' : 'not_found';
  }

  /**
   * A short-lived signed link to the member's own ready file. An image is
   * served inline as its own verified type (so a thumbnail renders), a PDF
   * inline as `application/pdf`, as the staff document viewer does; a text
   * file downloads as an opaque attachment. Never `text/html`.
   */
  async link(
    scope: Scope,
    attachmentId: string,
  ): Promise<{ status: 'issued'; url: string; expiresAt: Date } | { status: 'not_found' }> {
    const row = await this.store.get(scope, attachmentId);
    if (!row || row.status !== 'ready') return { status: 'not_found' };
    const link = await this.objects.issueDownload({
      workspaceId: scope.workspaceId,
      objectKey: aiAttachmentObjectKeys(row.objectKey).file,
      fileName: aiAttachmentDownloadName(row.id, row.mediaType),
      contentType: row.mediaType,
      expiresInSeconds: AI_ATTACHMENT_LINK_TTL_SECONDS,
      disposition: row.kind === 'text' ? 'attachment' : 'inline',
    });
    return { status: 'issued', url: link.url, expiresAt: link.expiresAt };
  }

  /**
   * An image's or a PDF's bytes for this turn's model call, bounded by the
   * size its row records. Never logged, never kept.
   */
  async readForModel(scope: Scope, attachment: AiTurnAttachment): Promise<Uint8Array> {
    const read = await this.objects.readObject({
      workspaceId: scope.workspaceId,
      objectKey: aiAttachmentObjectKeys(attachment.objectKey).file,
      maxBytes: attachment.byteSize,
    });
    if (read.status !== 'read') throw new Error(`ai_attachment_${read.status}`);
    return read.bytes;
  }

  /**
   * Deletes stored objects after their rows are gone (a deleted conversation,
   * the sweep). Best effort: a failure is counted, never retried blindly; an
   * object no row points at is never served.
   */
  async deleteObjects(
    scope: Scope,
    objects: readonly StoredObject[],
  ): Promise<{ deleted: number; failed: number }> {
    let deleted = 0;
    let failed = 0;
    for (const object of objects) {
      let keys: { file: string; staging: string };
      try {
        keys = aiAttachmentObjectKeys(object.objectKey);
      } catch {
        failed += 1;
        continue;
      }
      try {
        for (const key of [keys.file, keys.staging]) {
          await this.objects.deleteObject({
            workspaceId: scope.workspaceId,
            bucket: object.bucket,
            objectKey: key,
          });
        }
        deleted += 1;
      } catch {
        failed += 1;
      }
    }
    return { deleted, failed };
  }

  /**
   * The scheduled sweep for one site, as its machine actor: unsent files more
   * than a day old, in batches, rows first (through the 0036 function) and
   * then their objects.
   */
  async sweepUnsent(
    scope: Scope,
    options: { maxBatches?: number } = {},
  ): Promise<{ removed: number; deletedObjects: number; failedDeletes: number }> {
    const before = new Date(this.now().getTime() - AI_ATTACHMENT_UNSENT_TTL_MS);
    const totals = { removed: 0, deletedObjects: 0, failedDeletes: 0 };
    for (let batch = 0; batch < (options.maxBatches ?? 5); batch += 1) {
      const objects = await this.store.sweepUnsent(scope, {
        before,
        limit: AI_ATTACHMENT_SWEEP_BATCH,
      });
      totals.removed += objects.length;
      const deleted = await this.deleteObjects(scope, objects);
      totals.deletedObjects += deleted.deleted;
      totals.failedDeletes += deleted.failed;
      if (objects.length < AI_ATTACHMENT_SWEEP_BATCH) break;
    }
    return totals;
  }

  private async discard(scope: Scope, attachmentId: string): Promise<boolean> {
    const removed = await this.store.removeUnsent(scope, attachmentId);
    if (!removed) return false;
    await this.deleteObjects(scope, [removed]);
    return true;
  }

  private async deleteQuietly(scope: Scope, objectKey: string, bucket: string): Promise<void> {
    try {
      await this.objects.deleteObject({ workspaceId: scope.workspaceId, bucket, objectKey });
    } catch {
      // Left for the conversation's delete or the sweep, which remove both keys.
    }
  }
}
