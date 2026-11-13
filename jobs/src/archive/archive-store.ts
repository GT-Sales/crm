import { presignS3Url, signS3Request, type S3SigningConfig } from '@gt-sales/adapters';
import { createHash } from 'node:crypto';

/**
 * The encrypted backup archive, a Backblaze B2 bucket reached over its S3
 * endpoint and kept apart from the systems it backs up. The nightly runner
 * must be unable to read or delete what it has already written, so a stolen
 * runner credential cannot erase or exfiltrate the history
 * (docs/superpowers/specs/2026-10-28-merge-canadian-plans-design.md §10:
 * "archive-write without archive-delete"). The writer/reader/retention-admin
 * roles are separate TypeScript interfaces on purpose: code holding only an
 * `ArchiveWriter` cannot even call a delete method. They match the three B2
 * application keys in docs/RUNBOOKS/backup.md (writer: listFiles+writeFiles;
 * monitor/recovery reader: listFiles+readFiles; retention admin: adds
 * deleteFiles).
 */

export interface ArchiveObjectMeta {
  key: string;
  sizeBytes: number;
  versionId?: string;
  /** Provider upload time; absent when the listing does not report it. */
  lastModified?: Date;
}

export interface ArchiveWriter {
  putObject(key: string, body: Uint8Array): Promise<{ versionId?: string }>;
  listObjects(prefix: string): Promise<ArchiveObjectMeta[]>;
}

export interface ArchiveReader {
  listObjects(prefix: string): Promise<ArchiveObjectMeta[]>;
  getObject(key: string): Promise<Uint8Array | undefined>;
}

export interface ArchiveRetentionAdmin extends ArchiveReader {
  deleteObject(key: string): Promise<void>;
}

/**
 * Answers worth another try: Backblaze documents 500 and 503 as "retry the
 * request", and 429/502/504 are the same kind of passing trouble. Every other
 * status is the request's own fault and fails at once.
 */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
/** Waits before attempts 2, 3 and 4 (incident 2026-11-12: one B2 500 failed the night's backup). */
export const ARCHIVE_RETRY_DELAYS_MS = [2_000, 8_000, 20_000] as const;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One S3 call, tried up to four times when B2 answers a retryable status or
 * the connection fails or times out. Each attempt is signed afresh (the
 * signature carries the time). Re-sending a PUT is safe: a backup object's
 * key is unique to its run, and a repeat only adds a version.
 */
export async function s3Send(
  config: S3SigningConfig,
  req: Parameters<typeof signS3Request>[1],
  fetchImpl: typeof fetch,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const { url, headers } = signS3Request(config, req);
    const lastAttempt = attempt >= ARCHIVE_RETRY_DELAYS_MS.length;
    try {
      const response = await fetchImpl(url, {
        method: req.method,
        headers,
        body: req.body ? Buffer.from(req.body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (lastAttempt || !RETRYABLE_STATUSES.has(response.status)) return response;
      await response.body?.cancel();
    } catch (error) {
      if (lastAttempt) throw error;
    }
    await sleep(ARCHIVE_RETRY_DELAYS_MS[attempt] ?? 0);
  }
}

function parseListObjectsV2(xml: string): ArchiveObjectMeta[] {
  const results: ArchiveObjectMeta[] = [];
  const contentsRegex = /<Contents>([\s\S]*?)<\/Contents>/g;
  for (const match of xml.matchAll(contentsRegex)) {
    const block = match[1] ?? '';
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1];
    const size = /<Size>(\d+)<\/Size>/.exec(block)?.[1];
    const modified = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(block)?.[1];
    const lastModified = modified ? new Date(modified) : undefined;
    if (key)
      results.push({
        key,
        sizeBytes: size ? Number(size) : 0,
        ...(lastModified && Number.isFinite(lastModified.getTime()) ? { lastModified } : {}),
      });
  }
  return results;
}

function xmlValue(xml: string, tag: string): string | undefined {
  const value = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(xml)?.[1];
  return value?.replace(/&(amp|lt|gt|quot|apos);/g, (_match, entity: string) => {
    const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    return entities[entity] ?? '';
  });
}

async function listArchiveObjects(
  config: S3SigningConfig,
  prefix: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<ArchiveObjectMeta[]> {
  const objects: ArchiveObjectMeta[] = [];
  const seenTokens = new Set<string>();
  let token: string | undefined;
  do {
    const response = await s3Send(
      config,
      {
        method: 'GET',
        key: '',
        headers: {},
        query: { 'list-type': '2', prefix, ...(token ? { 'continuation-token': token } : {}) },
      },
      fetchImpl,
      timeoutMs,
      sleep,
    );
    if (!response.ok) throw new Error(`archive_list_failed:${response.status}`);
    const xml = await response.text();
    objects.push(...parseListObjectsV2(xml));
    if (xmlValue(xml, 'IsTruncated') !== 'true') break;
    token = xmlValue(xml, 'NextContinuationToken');
    if (!token || seenTokens.has(token)) throw new Error('archive_list_invalid_continuation');
    seenTokens.add(token);
  } while (token);
  return objects;
}

/** Writer credential: list + put only. Real B2 key must omit readFiles/deleteFiles. */
export class S3ArchiveWriter implements ArchiveWriter {
  constructor(
    private readonly config: S3SigningConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 30_000,
    /** Waits between retries (`s3Send`); tests pass an instant one. */
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {}

  /**
   * Every PUT carries `Content-MD5`, which the signature covers: the S3 side
   * rejects a body that does not match it, and buckets with Object Lock
   * require it (docs/RUNBOOKS/backup.md §3).
   */
  async putObject(key: string, body: Uint8Array): Promise<{ versionId?: string }> {
    const contentMd5 = createHash('md5').update(body).digest('base64');
    const response = await s3Send(
      this.config,
      { method: 'PUT', key, headers: { 'content-md5': contentMd5 }, body },
      this.fetchImpl,
      this.timeoutMs,
      this.sleep,
    );
    if (!response.ok) throw new Error(`archive_put_failed:${response.status}`);
    return { versionId: response.headers.get('x-amz-version-id') ?? undefined };
  }

  async listObjects(prefix: string): Promise<ArchiveObjectMeta[]> {
    return listArchiveObjects(this.config, prefix, this.fetchImpl, this.timeoutMs, this.sleep);
  }
}

/** Recovery-reader credential: list + get only. Real B2 key must omit writeFiles/deleteFiles. */
export class S3ArchiveReader implements ArchiveReader {
  constructor(
    private readonly config: S3SigningConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 30_000,
    /** Waits between retries (`s3Send`); tests pass an instant one. */
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {}

  async listObjects(prefix: string): Promise<ArchiveObjectMeta[]> {
    return listArchiveObjects(this.config, prefix, this.fetchImpl, this.timeoutMs, this.sleep);
  }

  async getObject(key: string): Promise<Uint8Array | undefined> {
    const response = await s3Send(
      this.config,
      { method: 'GET', key, headers: {} },
      this.fetchImpl,
      this.timeoutMs,
      this.sleep,
    );
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`archive_get_failed:${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

/** Retention-administrator credential: adds delete. Separate from the daily writer/reader. */
export class S3ArchiveRetentionAdmin implements ArchiveRetentionAdmin {
  private readonly reader: S3ArchiveReader;
  constructor(
    private readonly config: S3SigningConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 30_000,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {
    this.reader = new S3ArchiveReader(config, fetchImpl, timeoutMs, sleep);
  }

  listObjects(prefix: string): Promise<ArchiveObjectMeta[]> {
    return this.reader.listObjects(prefix);
  }

  getObject(key: string): Promise<Uint8Array | undefined> {
    return this.reader.getObject(key);
  }

  async deleteObject(key: string): Promise<void> {
    const response = await s3Send(
      this.config,
      { method: 'DELETE', key, headers: {} },
      this.fetchImpl,
      this.timeoutMs,
      this.sleep,
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(`archive_delete_failed:${response.status}`);
    }
  }
}

export function presignArchiveGet(
  config: S3SigningConfig,
  key: string,
  expiresInSeconds: number,
): string {
  return presignS3Url(config, { method: 'GET', key, expiresInSeconds });
}

// --- In-memory backend for tests and local rehearsals -----------------------

type Capability = 'put' | 'list' | 'get' | 'delete';

export class ArchiveCredentialDeniedError extends Error {
  constructor(capability: Capability) {
    super(`credential_denied:${capability}`);
    this.name = 'ArchiveCredentialDeniedError';
  }
}

interface StoredObject {
  body: Uint8Array;
  versionId: string;
  lastModified: Date;
}

/**
 * A single shared in-memory backend with three independently scoped facades,
 * mirroring the real B2 application-key split. Calling a method the facade's
 * role does not hold throws `ArchiveCredentialDeniedError`, as B2 refuses a
 * key that lacks the capability, so tests prove each role fails closed
 * instead of trusting the TypeScript types alone.
 */
export class InMemoryArchiveBackend {
  private readonly objects = new Map<string, StoredObject>();
  private versionCounter = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  private scoped(capabilities: readonly Capability[]): ArchiveWriter & ArchiveRetentionAdmin {
    const allowed = new Set(capabilities);
    const require = (capability: Capability): void => {
      if (!allowed.has(capability)) throw new ArchiveCredentialDeniedError(capability);
    };
    return {
      putObject: async (key, body) => {
        require('put');
        const versionId = `v${++this.versionCounter}`;
        this.objects.set(key, { body: structuredClone(body), versionId, lastModified: this.now() });
        return { versionId };
      },
      listObjects: async (prefix) => {
        require('list');
        return [...this.objects.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => ({
            key,
            sizeBytes: value.body.byteLength,
            versionId: value.versionId,
            lastModified: value.lastModified,
          }));
      },
      getObject: async (key) => {
        require('get');
        return this.objects.get(key)?.body;
      },
      deleteObject: async (key) => {
        require('delete');
        this.objects.delete(key);
      },
    };
  }

  asWriter(): ArchiveWriter {
    return this.scoped(['put', 'list']);
  }

  asReader(): ArchiveReader {
    return this.scoped(['list', 'get']);
  }

  asRetentionAdmin(): ArchiveRetentionAdmin {
    return this.scoped(['list', 'get', 'delete']);
  }

  /** Test/inspection helper only — never exposed through a role facade. */
  size(): number {
    return this.objects.size;
  }
}
