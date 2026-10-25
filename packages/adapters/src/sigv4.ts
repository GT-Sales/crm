import { createHash, createHmac } from 'node:crypto';

/**
 * Generic AWS SigV4 request/query signer for S3-compatible object storage
 * (fetch-based, no AWS SDK — the same approach already used for R2 in
 * `r2-s3.ts`). Generalized so the independent Backblaze B2 backup archive and
 * deletion-ledger clients (`jobs/src/backup`) can reuse one tested signer
 * instead of re-deriving SigV4 canonicalisation.
 */

const SERVICE_DEFAULT = 's3';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
const ALGORITHM = 'AWS4-HMAC-SHA256';

export interface S3SigningConfig {
  accessKeyId: string;
  secretAccessKey: string;
  /** S3-compatible endpoint, e.g. https://s3.us-west-002.backblazeb2.com */
  endpoint: string;
  region: string;
  bucket: string;
  service?: string;
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

function signingKey(config: S3SigningConfig, dateStamp: string): Buffer {
  const kDate = hmac(`AWS4${config.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, config.region);
  const kService = hmac(kRegion, config.service ?? SERVICE_DEFAULT);
  return hmac(kService, 'aws4_request');
}

export interface PresignS3Params {
  method: 'GET' | 'PUT' | 'DELETE';
  key: string;
  expiresInSeconds: number;
  now?: Date;
  query?: Record<string, string>;
}

export function presignS3Url(config: S3SigningConfig, params: PresignS3Params): string {
  const now = params.now ?? new Date();
  const { amzDate, dateStamp } = amzTimestamp(now);
  const url = new URL(config.endpoint);
  const host = url.host;
  const canonicalUri = `/${encodeRfc3986(config.bucket)}/${encodeKey(params.key)}`;
  const credentialScope = `${dateStamp}/${config.region}/${config.service ?? SERVICE_DEFAULT}/aws4_request`;

  const queryParams: Record<string, string> = {
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${config.accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(params.expiresInSeconds),
    'X-Amz-SignedHeaders': 'host',
    ...(params.query ?? {}),
  };
  const canonicalQuery = Object.keys(queryParams)
    .sort()
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(queryParams[k] ?? '')}`)
    .join('&');

  const canonicalHeaders = `host:${host}\n`;
  const canonicalRequest = [
    params.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    'host',
    UNSIGNED_PAYLOAD,
  ].join('\n');

  const stringToSign = [ALGORITHM, amzDate, credentialScope, hashHex(canonicalRequest)].join('\n');
  const signature = hmac(signingKey(config, dateStamp), stringToSign).toString('hex');
  return `${config.endpoint}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export interface SignS3RequestInput {
  method: 'GET' | 'PUT' | 'DELETE' | 'HEAD';
  /** Object key, or '' for bucket-level operations (e.g. ListObjectsV2). */
  key: string;
  headers: Record<string, string>;
  body?: Uint8Array;
  query?: Record<string, string>;
  now?: Date;
}

function headerKey(headers: Record<string, string>, lower: string): string {
  const match = Object.keys(headers).find((name) => name.toLowerCase() === lower);
  return match ?? lower;
}

/** Header-signed (not presigned) request for server-to-server object/bucket operations. */
export function signS3Request(
  config: S3SigningConfig,
  req: SignS3RequestInput,
): { url: string; headers: Record<string, string> } {
  const now = req.now ?? new Date();
  const { amzDate, dateStamp } = amzTimestamp(now);
  const url = new URL(config.endpoint);
  const host = url.host;
  const canonicalUri = `/${encodeRfc3986(config.bucket)}${req.key ? `/${encodeKey(req.key)}` : ''}`;
  const payloadHash = req.body ? createHash('sha256').update(req.body).digest('hex') : hashHex('');

  const query = req.query ?? {};
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(query[k] ?? '')}`)
    .join('&');

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
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const credentialScope = `${dateStamp}/${config.region}/${config.service ?? SERVICE_DEFAULT}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, credentialScope, hashHex(canonicalRequest)].join('\n');
  const signature = hmac(signingKey(config, dateStamp), stringToSign).toString('hex');

  return {
    url: `${config.endpoint}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ''}`,
    headers: {
      ...baseHeaders,
      authorization: `${ALGORITHM} Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}
