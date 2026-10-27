import { createHash } from 'node:crypto';

/**
 * Private-document storage behind the file-access interface named in
 * IMPLEMENTATION_PLAN.md §8: `createUpload`, `verifyUpload`, `issueDownload`,
 * `copyForExport`. Two implementations live in this package:
 *
 *  - `S3R2DocumentStore` (r2-s3.ts): the real Cloudflare R2 adapter. All
 *    credentials/config come from environment variables; nothing is hardcoded.
 *  - `InMemoryR2DocumentStore` (below): a deterministic fake with no network,
 *    used by every test and by non-production environments.
 *
 * The security-critical guarantee (PLATFORM_CONTEXT.md invariant 8): the
 * uploader writes only to a *staging* object; `verifyUpload` first copies that
 * staging object to a private *candidate* object the uploader can no longer
 * reach, then verifies the candidate's bytes. The exact candidate object is
 * what the caller later attaches and serves, so bytes cannot be swapped between
 * the signature check and the file becoming available.
 */

/** The only stored document media types (recorded decision: PDF/JPG/PNG). */
export type DocumentMediaType = 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp';

/** Resolve the logical key stored in the database to its private R2 object. */
export function documentObjectKey(workspaceId: string, key: string): string {
  return `workspaces/${workspaceId}/${key}`;
}

/**
 * Detects one of the three allowed document types from a file's leading bytes.
 * The declared `Content-Type` is never trusted (invariant 8); only the magic
 * bytes decide. Returns `undefined` for anything else.
 */
export function detectDocumentType(bytes: Uint8Array): DocumentMediaType | undefined {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (startsWith(bytes, png)) return 'image/png';
  // JPEG: FF D8 FF
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  // WebP: "RIFF" <size> "WEBP" (52 49 46 46 .. .. .. .. 57 45 42 50)
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    matchesAt(bytes, 8, [0x57, 0x45, 0x42, 0x50])
  ) {
    return 'image/webp';
  }
  // PDF: "%PDF-" (25 50 44 46 2D). Allow a small leading offset: some PDFs
  // carry a few bytes of whitespace/BOM before the header, which real readers
  // tolerate. Bound the scan so a huge non-PDF cannot force a long search.
  const pdfHeader = [0x25, 0x50, 0x44, 0x46, 0x2d];
  const scanLimit = Math.min(bytes.length, 1024);
  for (let offset = 0; offset + pdfHeader.length <= scanLimit; offset += 1) {
    if (matchesAt(bytes, offset, pdfHeader)) return 'application/pdf';
    // Only skip leading whitespace/control bytes; stop at the first real byte.
    if (bytes[offset] !== 0x20 && bytes[offset] !== 0x0a && bytes[offset] !== 0x0d) break;
  }
  return undefined;
}

/** A key of plain segments: no empty, `.` or `..` segment and no backslash. */
export function isPlainKey(key: string): boolean {
  return (
    !key.includes('\\') && key.split('/').every((part) => part && part !== '.' && part !== '..')
  );
}

/**
 * An object a website wrote to the shared bucket itself (Get Canada Sim's
 * `orders/<id>/passport.pdf`): plain segments, outside every workspace's
 * prefix, so an import can never read another workspace's private copy.
 */
export function isWebsiteObjectKey(key: string): boolean {
  return isPlainKey(key) && key.split('/')[0] !== 'workspaces';
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return matchesAt(bytes, 0, prefix);
}

function matchesAt(bytes: Uint8Array, offset: number, prefix: number[]): boolean {
  if (bytes.length < offset + prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[offset + i] !== prefix[i]) return false;
  }
  return true;
}

/** Lower-case hex SHA-256 of the given bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface CreateUploadInput {
  workspaceId: string;
  /** Backend-generated random staging key the uploader may write to. */
  stagingKey: string;
  /** Declared type — validated up front but never trusted for storage. */
  declaredContentType: DocumentMediaType;
  /** Exact body length bound into the upload signature, never greater than maxBytes. */
  declaredSizeBytes: number;
  /** Hard byte ceiling advertised to the client (10 MB). */
  maxBytes: number;
  expiresInSeconds: number;
}

export interface PresignedUpload {
  stagingKey: string;
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface VerifyUploadInput {
  workspaceId: string;
  stagingKey: string;
  /** Backend-generated random key the uploader cannot write to. */
  candidateKey: string;
  /** The checksum the client claims for the bytes it uploaded. */
  expectedChecksumSha256: string;
  maxBytes: number;
}

export type VerifyUploadRejection =
  'staging_missing' | 'too_large' | 'unsupported_signature' | 'checksum_mismatch';

export type VerifyUploadResult =
  | {
      status: 'verified';
      candidateKey: string;
      detectedMediaType: DocumentMediaType;
      sizeBytes: number;
      checksumSha256: string;
    }
  | { status: 'rejected'; reason: VerifyUploadRejection };

export interface ImportObjectInput {
  workspaceId: string;
  /** A website's own object in the bucket (`isWebsiteObjectKey`); only ever read. */
  sourceKey: string;
  /** Backend-generated key for the workspace's private copy. */
  candidateKey: string;
  maxBytes: number;
}

export type ImportObjectRejection = 'source_missing' | 'too_large' | 'unsupported_signature';

export type ImportObjectResult =
  | {
      status: 'verified';
      candidateKey: string;
      detectedMediaType: DocumentMediaType;
      sizeBytes: number;
      checksumSha256: string;
    }
  | { status: 'rejected'; reason: ImportObjectRejection };

export interface IssueDownloadInput {
  workspaceId: string;
  objectKey: string;
  /** Sanitized filename for the disposition. */
  fileName: string;
  contentType: DocumentMediaType;
  expiresInSeconds: number;
  /**
   * `inline` is staff viewing a verified file in a tab of its own: served as
   * its verified type, from the storage origin (never the admin's). The
   * default, `attachment`, is an opaque octet-stream download.
   */
  disposition?: 'attachment' | 'inline';
}

export interface PresignedDownload {
  url: string;
  expiresAt: Date;
}

export interface CopyForExportInput {
  workspaceId: string;
  objectKey: string;
  destinationKey: string;
}

export interface CopyToBucketInput {
  workspaceId: string;
  objectKey: string;
  destinationBucket: string;
  destinationKey: string;
}

/** An object `copyToBucket` wrote, by its exact key in that other bucket. */
export interface DeleteFromBucketInput {
  bucket: string;
  key: string;
}

/**
 * Every method is workspace-scoped so an implementation can enforce a
 * per-workspace key prefix. Verification always runs against the immutable
 * candidate copy, never the mutable staging object (invariant 8).
 */
export interface R2DocumentStore {
  /** Idempotent private deletion; the caller supplies the persisted bucket. */
  deleteObject(input: { workspaceId: string; bucket: string; objectKey: string }): Promise<void>;
  /** Presigned PUT to the staging object (short expiry). */
  createUpload(input: CreateUploadInput): Promise<PresignedUpload>;
  /**
   * Copies staging → candidate FIRST, then verifies the candidate: existence,
   * size ≤ maxBytes, PDF/JPEG/PNG signature, and checksum. The declared
   * Content-Type is ignored. On success the returned `candidateKey` is the
   * exact object the caller must attach and later serve.
   */
  verifyUpload(input: VerifyUploadInput): Promise<VerifyUploadResult>;
  /**
   * Copies a website's own object into the workspace's private candidate,
   * then verifies the candidate as `verifyUpload` does: size and signature,
   * with the copy's own SHA-256 recorded (no client claims one). The source
   * is only read.
   */
  importObject(input: ImportObjectInput): Promise<ImportObjectResult>;
  /** Presigned GET for an attached object: an attachment unless `disposition` says inline. */
  issueDownload(input: IssueDownloadInput): Promise<PresignedDownload>;
  /** Server-side copy of an attached object into an export location (Phase B boundary). */
  copyForExport(input: CopyForExportInput): Promise<void>;
  /**
   * Server-side copy of an attached object into another bucket at an exact,
   * unscoped key: the transitional copy of an ID photo into the old admin's
   * bucket (migrations 0005–0006). The source stays where it is.
   */
  copyToBucket(input: CopyToBucketInput): Promise<void>;
  /** Removes such a copy again (a best-effort undo); never touches the documents bucket. */
  deleteFromBucket(input: DeleteFromBucketInput): Promise<void>;
}

/**
 * Deterministic, network-free store for tests and non-production environments.
 * Objects are held in memory keyed by their object key. Staging and candidate
 * objects are distinct keys, so `overwriteStaging` (a simulated swap-after-check
 * attack) after `verifyUpload` has copied to the candidate has no effect on the
 * verified/served bytes — exactly the production guarantee.
 */
export class InMemoryR2DocumentStore implements R2DocumentStore {
  private readonly objects = new Map<string, Uint8Array>();

  async deleteObject(input: {
    workspaceId: string;
    bucket: string;
    objectKey: string;
  }): Promise<void> {
    this.objects.delete(input.objectKey);
  }

  /** Test seam: simulate the client's direct PUT to the staging object. */
  putStagingObject(stagingKey: string, bytes: Uint8Array): void {
    this.objects.set(stagingKey, Uint8Array.from(bytes));
  }

  /** Test seam: an object a website wrote to the bucket itself, outside the workspaces. */
  putObject(key: string, bytes: Uint8Array): void {
    this.objects.set(key, Uint8Array.from(bytes));
  }

  /** Test seam: simulate an attacker swapping the staging bytes after the check. */
  overwriteStaging(stagingKey: string, bytes: Uint8Array): void {
    this.putStagingObject(stagingKey, bytes);
  }

  /** Test seam: read the exact stored bytes for any key (what staff would receive). */
  getObject(key: string): Uint8Array | undefined {
    const stored = this.objects.get(key);
    return stored ? Uint8Array.from(stored) : undefined;
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }

  async createUpload(input: CreateUploadInput): Promise<PresignedUpload> {
    return {
      stagingKey: input.stagingKey,
      url: `memory://${input.workspaceId}/${input.stagingKey}`,
      method: 'PUT',
      headers: { 'content-type': input.declaredContentType },
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
    };
  }

  async verifyUpload(input: VerifyUploadInput): Promise<VerifyUploadResult> {
    const staging = this.objects.get(input.stagingKey);
    if (!staging) return { status: 'rejected', reason: 'staging_missing' };

    // Copy FIRST. From here on we only read the candidate; the staging object
    // may be overwritten by the uploader without affecting the outcome.
    const candidate = Uint8Array.from(staging);
    this.objects.set(input.candidateKey, candidate);

    if (candidate.byteLength > input.maxBytes) {
      return { status: 'rejected', reason: 'too_large' };
    }
    const detectedMediaType = detectDocumentType(candidate);
    if (!detectedMediaType) return { status: 'rejected', reason: 'unsupported_signature' };
    const checksumSha256 = sha256Hex(candidate);
    if (checksumSha256 !== input.expectedChecksumSha256) {
      return { status: 'rejected', reason: 'checksum_mismatch' };
    }
    return {
      status: 'verified',
      candidateKey: input.candidateKey,
      detectedMediaType,
      sizeBytes: candidate.byteLength,
      checksumSha256,
    };
  }

  async importObject(input: ImportObjectInput): Promise<ImportObjectResult> {
    if (!isWebsiteObjectKey(input.sourceKey)) throw new Error('r2_import_key_invalid');
    const source = this.objects.get(input.sourceKey);
    if (!source) return { status: 'rejected', reason: 'source_missing' };

    // Copy first, as `verifyUpload` does; only the candidate is inspected.
    const candidate = Uint8Array.from(source);
    this.objects.set(input.candidateKey, candidate);
    if (candidate.byteLength > input.maxBytes) return { status: 'rejected', reason: 'too_large' };
    const detectedMediaType = detectDocumentType(candidate);
    if (!detectedMediaType) return { status: 'rejected', reason: 'unsupported_signature' };
    return {
      status: 'verified',
      candidateKey: input.candidateKey,
      detectedMediaType,
      sizeBytes: candidate.byteLength,
      checksumSha256: sha256Hex(candidate),
    };
  }

  async issueDownload(input: IssueDownloadInput): Promise<PresignedDownload> {
    if (!this.objects.has(input.objectKey)) {
      throw new Error(`object not found: ${input.objectKey}`);
    }
    return {
      url: `memory://${input.workspaceId}/${input.objectKey}?disposition=${input.disposition ?? 'attachment'}`,
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
    };
  }

  async copyForExport(input: CopyForExportInput): Promise<void> {
    const source = this.objects.get(input.objectKey);
    if (!source) throw new Error(`object not found: ${input.objectKey}`);
    this.objects.set(input.destinationKey, Uint8Array.from(source));
  }

  /** Copies live under `<bucket>:<key>`, so a test can tell them from this store's own objects. */
  async copyToBucket(input: CopyToBucketInput): Promise<void> {
    const source = this.objects.get(input.objectKey);
    if (!source) throw new Error(`object not found: ${input.objectKey}`);
    this.objects.set(`${input.destinationBucket}:${input.destinationKey}`, Uint8Array.from(source));
  }

  async deleteFromBucket(input: DeleteFromBucketInput): Promise<void> {
    this.objects.delete(`${input.bucket}:${input.key}`);
  }

  /** Test seam: the bytes at a key, if any. */
  objectAt(key: string): Uint8Array | undefined {
    return this.objects.get(key);
  }
}
