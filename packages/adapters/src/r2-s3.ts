import { createHash, createHmac } from 'node:crypto';

import {
  detectDocumentType,
  documentObjectKey,
  sha256Hex,
  type CopyForExportInput,
  type CreateUploadInput,
  type IssueDownloadInput,
  type PresignedDownload,
  type PresignedUpload,
  type R2DocumentStore,
  type VerifyUploadInput,
  type VerifyUploadResult,
} from './r2.js';

/**
 * Real Cloudflare R2 adapter over R2's S3-compatible API, signed with AWS
 * Signature V4 using `node:crypto` (no AWS SDK — matching the fetch-based
 * Sanity adapter in this package). Every value comes from the environment;
 * nothing is hardcoded (see `configFromEnv`).
 *
 * Store objects are written with `Content-Type: application/octet-stream` and
 * `Content-Disposition: attachment`, and downloads additionally override the
 * response disposition with a sanitized filename, so an original is never
 * inline-rendered (invariant 8 / IMPLEMENTATION_PLAN.md §8). See the README for
 * the `X-Content-Type-Options: nosniff` limitation of presigned GETs.
 */

const SERVICE = 's3';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
const ALGORITHM = 'AWS4-HMAC-SHA256';

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** S3 endpoint, e.g. https://<account>.r2.cloudflarestorage.com */
  endpoint: string;
  /** R2 ignores region but SigV4 requires one; R2 uses "auto". */
  region: string;
}

/**
 * Reads R2 configuration from the environment. The scoped R2 API token and CORS
 * are provisioned by the owner in the Cloudflare dashboard (see BLOCKERS in the
 * task report); this adapter only consumes the resulting values.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): R2Config {
  const accountId = required(env, 'R2_ACCOUNT_ID');
  const endpoint = env.R2_ENDPOINT ?? `https://${accountId}.r2.cloudflarestorage.com`;
  return {
    accountId,
    accessKeyId: required(env, 'R2_ACCESS_KEY_ID'),
    secretAccessKey: required(env, 'R2_SECRET_ACCESS_KEY'),
    bucket: required(env, 'R2_BUCKET'),
    endpoint,
    region: env.R2_REGION ?? 'auto',
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required for the R2 document store`);
  return value;
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function hashHex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/** RFC 3986 encoding used by SigV4 (encodeURIComponent plus `!*'()`). */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!*'()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Encodes an object key for the path, keeping `/` separators. */
function encodeKey(key: string): string {
  return key
    .split('/')
    .map((segment) => encodeRfc3986(segment))
    .join('/');
}

function amzTimestamp(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function signingKey(config: R2Config, dateStamp: string): Buffer {
  const kDate = hmac(`AWS4${config.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, config.region);
  const kService = hmac(kRegion, SERVICE);
  return hmac(kService, 'aws4_request');
}

interface PresignParams {
  method: 'GET' | 'PUT';
  key: string;
  expiresInSeconds: number;
  now?: Date;
  /** Extra query params (e.g. response-content-disposition) folded into the signature. */
  query?: Record<string, string>;
  /** Exact browser-generated body length; omitted for downloads. */
  contentLength?: number;
}

/**
 * Builds a SigV4 query-signed URL for a single object operation. Exported for
 * deterministic offline unit tests of the canonicalisation and signature.
 */
export function presignUrl(config: R2Config, params: PresignParams): string {
  const now = params.now ?? new Date();
  const { amzDate, dateStamp } = amzTimestamp(now);
  const url = new URL(config.endpoint);
  const host = url.host;
  const canonicalUri = `/${encodeRfc3986(config.bucket)}/${encodeKey(params.key)}`;
  const credentialScope = `${dateStamp}/${config.region}/${SERVICE}/aws4_request`;

  const signedHeaders = params.contentLength === undefined ? 'host' : 'content-length;host';
  const queryParams: Record<string, string> = {
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${config.accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(params.expiresInSeconds),
    'X-Amz-SignedHeaders': signedHeaders,
    ...(params.query ?? {}),
  };
  const canonicalQuery = Object.keys(queryParams)
    .sort()
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(queryParams[k] ?? '')}`)
    .join('&');

  const canonicalHeaders =
    (params.contentLength === undefined ? '' : `content-length:${params.contentLength}\n`) +
    `host:${host}\n`;
  const canonicalRequest = [
    params.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    UNSIGNED_PAYLOAD,
  ].join('\n');

  const stringToSign = [ALGORITHM, amzDate, credentialScope, hashHex(canonicalRequest)].join('\n');
  const signature = hmac(signingKey(config, dateStamp), stringToSign).toString('hex');
  return `${config.endpoint}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

interface SignedRequest {
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE';
  key: string;
  headers: Record<string, string>;
  body?: Uint8Array;
  now?: Date;
}

/** Header-signed (not presigned) request for server-to-server copy/head/get. */
function signRequest(
  config: R2Config,
  req: SignedRequest,
): { url: string; headers: Record<string, string> } {
  const now = req.now ?? new Date();
  const { amzDate, dateStamp } = amzTimestamp(now);
  const url = new URL(config.endpoint);
  const host = url.host;
  const canonicalUri = `/${encodeRfc3986(config.bucket)}/${encodeKey(req.key)}`;
  const payloadHash = req.body ? createHash('sha256').update(req.body).digest('hex') : hashHex('');

  const baseHeaders: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...req.headers,
  };
  const sortedHeaderNames = Object.keys(baseHeaders)
    .map((name) => name.toLowerCase())
    .sort();
  const canonicalHeaders = sortedHeaderNames
    .map((name) => `${name}:${String(baseHeaders[headerKey(baseHeaders, name)]).trim()}\n`)
    .join('');
  const signedHeaders = sortedHeaderNames.join(';');

  const canonicalRequest = [
    req.method,
    canonicalUri,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const credentialScope = `${dateStamp}/${config.region}/${SERVICE}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, credentialScope, hashHex(canonicalRequest)].join('\n');
  const signature = hmac(signingKey(config, dateStamp), stringToSign).toString('hex');

  return {
    url: `${config.endpoint}${canonicalUri}`,
    headers: {
      ...baseHeaders,
      authorization: `${ALGORITHM} Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

function headerKey(headers: Record<string, string>, lower: string): string {
  const match = Object.keys(headers).find((name) => name.toLowerCase() === lower);
  return match ?? lower;
}

export class S3R2DocumentStore implements R2DocumentStore {
  constructor(
    private readonly config: R2Config,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  async createUpload(input: CreateUploadInput): Promise<PresignedUpload> {
    if (
      !Number.isSafeInteger(input.declaredSizeBytes) ||
      input.declaredSizeBytes < 1 ||
      input.declaredSizeBytes > input.maxBytes
    ) {
      throw new Error('invalid upload size');
    }
    const url = presignUrl(this.config, {
      method: 'PUT',
      key: this.scopedKey(input.workspaceId, input.stagingKey),
      expiresInSeconds: input.expiresInSeconds,
      contentLength: input.declaredSizeBytes,
    });
    return {
      stagingKey: input.stagingKey,
      url,
      method: 'PUT',
      headers: { 'content-type': input.declaredContentType },
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
    };
  }

  async verifyUpload(input: VerifyUploadInput): Promise<VerifyUploadResult> {
    const stagingKey = this.scopedKey(input.workspaceId, input.stagingKey);
    const candidateKey = this.scopedKey(input.workspaceId, input.candidateKey);

    // Copy FIRST to the private candidate the uploader cannot write to. The
    // candidate is stored as an attachment octet-stream so a later GET never
    // inline-renders it.
    const copy = signRequest(this.config, {
      method: 'PUT',
      key: candidateKey,
      headers: {
        'x-amz-copy-source': `/${this.config.bucket}/${encodeKey(stagingKey)}`,
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment',
        'x-amz-metadata-directive': 'REPLACE',
      },
    });
    const copyResponse = await this.send(copy.url, { method: 'PUT', headers: copy.headers });
    if (copyResponse.status === 404) return { status: 'rejected', reason: 'staging_missing' };
    if (!copyResponse.ok) throw new Error(`r2 copy failed: ${copyResponse.status}`);

    // Only inspect the private candidate: staging can change during finalization.
    const head = signRequest(this.config, { method: 'HEAD', key: candidateKey, headers: {} });
    const metadata = await this.send(head.url, { method: 'HEAD', headers: head.headers });
    if (metadata.status === 404) return { status: 'rejected', reason: 'staging_missing' };
    if (!metadata.ok) throw new Error(`r2 head failed: ${metadata.status}`);
    if (Number(metadata.headers.get('content-length')) > input.maxBytes) {
      return { status: 'rejected', reason: 'too_large' };
    }

    // Bound the actual stream too: metadata is not a substitute for a byte limit.
    const get = signRequest(this.config, { method: 'GET', key: candidateKey, headers: {} });
    const candidateResponse = await this.send(get.url, { method: 'GET', headers: get.headers });
    if (candidateResponse.status === 404) return { status: 'rejected', reason: 'staging_missing' };
    if (!candidateResponse.ok) throw new Error(`r2 get failed: ${candidateResponse.status}`);
    const candidate = await readBoundedBody(candidateResponse, input.maxBytes);
    if (candidate === undefined) return { status: 'rejected', reason: 'too_large' };
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

  async issueDownload(input: IssueDownloadInput): Promise<PresignedDownload> {
    const url = presignUrl(this.config, {
      method: 'GET',
      key: this.scopedKey(input.workspaceId, input.objectKey),
      expiresInSeconds: input.expiresInSeconds,
      query: {
        'response-content-disposition': `attachment; filename="${input.fileName}"`,
        'response-content-type': 'application/octet-stream',
      },
    });
    return { url, expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000) };
  }

  async copyForExport(input: CopyForExportInput): Promise<void> {
    const copy = signRequest(this.config, {
      method: 'PUT',
      key: this.scopedKey(input.workspaceId, input.destinationKey),
      headers: {
        'x-amz-copy-source': `/${this.config.bucket}/${encodeKey(
          this.scopedKey(input.workspaceId, input.objectKey),
        )}`,
      },
    });
    const response = await this.send(copy.url, { method: 'PUT', headers: copy.headers });
    if (!response.ok) throw new Error(`r2 export copy failed: ${response.status}`);
  }

  /** Per-workspace key prefix so a bug cannot address another tenant's object. */
  async deleteObject(input: {
    workspaceId: string;
    bucket: string;
    objectKey: string;
  }): Promise<void> {
    if (input.bucket !== this.config.bucket) throw new Error('r2_cleanup_bucket_mismatch');
    if (
      input.objectKey.includes('\\') ||
      input.objectKey.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw new Error('r2_cleanup_key_invalid');
    const request = signRequest(this.config, {
      method: 'DELETE',
      key: this.scopedKey(input.workspaceId, input.objectKey),
      headers: {},
    });
    const response = await this.send(request.url, { method: 'DELETE', headers: request.headers });
    if (!response.ok && response.status !== 404) throw new Error('r2_cleanup_failed');
  }

  /** Per-workspace key prefix so a bug cannot address another tenant's object. */
  private scopedKey(workspaceId: string, key: string): string {
    return documentObjectKey(workspaceId, key);
  }

  private send(url: string, init: RequestInit): Promise<Response> {
    return this.fetchImpl(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maxBytes - size) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Constructs the real R2 store from environment configuration. */
export function createR2DocumentStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): S3R2DocumentStore {
  return new S3R2DocumentStore(configFromEnv(env));
}
