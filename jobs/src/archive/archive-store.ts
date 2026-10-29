import { presignS3Url, signS3Request, type S3SigningConfig } from '@gt-sales/adapters';

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

async function s3Send(
  config: S3SigningConfig,
  req: Parameters<typeof signS3Request>[1],
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<Response> {
  const { url, headers } = signS3Request(config, req);
  return fetchImpl(url, {
    method: req.method,
    headers,
    body: req.body ? Buffer.from(req.body) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
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
  ) {}

  async putObject(key: string, body: Uint8Array): Promise<{ versionId?: string }> {
    const response = await s3Send(
      this.config,
      { method: 'PUT', key, headers: {}, body },
      this.fetchImpl,
      this.timeoutMs,
    );
    if (!response.ok) throw new Error(`archive_put_failed:${response.status}`);
    return { versionId: response.headers.get('x-amz-version-id') ?? undefined };
  }

  async listObjects(prefix: string): Promise<ArchiveObjectMeta[]> {
    return listArchiveObjects(this.config, prefix, this.fetchImpl, this.timeoutMs);
  }
}

/** Recovery-reader credential: list + get only. Real B2 key must omit writeFiles/deleteFiles. */
export class S3ArchiveReader implements ArchiveReader {
  constructor(
    private readonly config: S3SigningConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 30_000,
  ) {}

  async listObjects(prefix: string): Promise<ArchiveObjectMeta[]> {
    return listArchiveObjects(this.config, prefix, this.fetchImpl, this.timeoutMs);
  }

  async getObject(key: string): Promise<Uint8Array | undefined> {
    const response = await s3Send(
      this.config,
      { method: 'GET', key, headers: {} },
      this.fetchImpl,
      this.timeoutMs,
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
  ) {
    this.reader = new S3ArchiveReader(config, fetchImpl, timeoutMs);
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

  scoped(capabilities: readonly Capability[]): ArchiveWriter & ArchiveRetentionAdmin {
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
