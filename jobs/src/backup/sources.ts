import { signS3Request, type S3SigningConfig } from '@gt-sales/adapters';

import { runOrThrow, type RunCommand } from '../archive/command.js';
import { APP_SCHEMAS, parseConnectionUrl, pgConnectionEnv, type PgConnection } from './pg-dump.js';

/**
 * The backup's sources besides the dump itself (pg-dump.ts): the list of
 * document objects the database references, a reader for those objects in the
 * project's Storage bucket, and the completeness guard that proves the dump
 * role can read every table before anything is exported. Production
 * implementations shell to `psql` (as `backup_reader`, connection in PG*
 * environment variables only) or sign S3 requests; the fakes let the runner
 * and its tests exercise the whole pipeline without credentials.
 */

async function psqlQuery(
  connection: PgConnection,
  run: RunCommand,
  args: readonly string[],
): Promise<string> {
  const stdout = await runOrThrow(run, 'psql', ['--tuples-only', '--no-align', ...args], {
    env: pgConnectionEnv(connection, process.env),
  });
  return new TextDecoder().decode(stdout);
}

function outputLines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim() !== '');
}

// --- Referenced-object manifest ----------------------------------------------

export interface ReferencedObject {
  workspaceId: string;
  bucket: string;
  objectKey: string;
  checksumSha256: string;
  sizeBytes: number;
}

export interface ReferencedObjectManifestSource {
  listReferencedObjects(): Promise<ReferencedObject[]>;
}

/**
 * Every object a file row or a retained revision points at. Restriction or
 * tombstoning can happen after the dump; a retained verified object still
 * belongs to that snapshot, while staging and candidate keys do not. Rows are
 * not filtered on their checksum: one whose checksum cannot be verified must
 * fail the backup, never be skipped.
 */
export const REFERENCED_OBJECTS_QUERY = `
  select workspace_id, bucket, object_key, checksum_sha256, size_bytes
  from app.files where object_key is not null
  union
  select r.workspace_id, f.bucket, r.object_key, r.checksum_sha256, r.size_bytes
  from app.file_revisions r join app.files f
    on f.workspace_id = r.workspace_id and f.id = r.file_id
`;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SIZE = /^\d+$/;

export class PsqlReferencedObjectManifestSource implements ReferencedObjectManifestSource {
  private readonly connection: PgConnection;

  constructor(
    dbUrl: string,
    private readonly run: RunCommand,
  ) {
    this.connection = parseConnectionUrl(dbUrl);
  }

  async listReferencedObjects(): Promise<ReferencedObject[]> {
    const text = await psqlQuery(this.connection, this.run, [
      '--field-separator',
      '\t',
      '--command',
      REFERENCED_OBJECTS_QUERY,
    ]);
    return outputLines(text).map((line) => {
      const fields = line.split('\t');
      const [workspaceId = '', bucket = '', objectKey = '', checksumSha256 = '', size = ''] =
        fields;
      if (
        fields.length !== 5 ||
        !workspaceId ||
        !bucket ||
        !objectKey ||
        !SHA256_HEX.test(checksumSha256) ||
        !SIZE.test(size)
      ) {
        throw new Error(`malformed_referenced_object_row:${workspaceId}/${objectKey}`);
      }
      return { workspaceId, bucket, objectKey, checksumSha256, sizeBytes: Number(size) };
    });
  }
}

export class FakeReferencedObjectManifestSource implements ReferencedObjectManifestSource {
  constructor(private readonly objects: ReferencedObject[]) {}
  async listReferencedObjects(): Promise<ReferencedObject[]> {
    return this.objects;
  }
}

// --- Storage source reader (get only; the source bucket is never the archive) --

export interface StorageSourceReader {
  getObject(bucket: string, key: string): Promise<Uint8Array | undefined>;
}

/**
 * Reads document objects from the deployment's one Storage bucket over the S3
 * protocol. `key` is the physical key (`documentObjectKey(workspaceId, key)`).
 * A row naming any other bucket fails loudly rather than being fetched from
 * the configured one.
 */
export class S3StorageSourceReader implements StorageSourceReader {
  constructor(
    private readonly config: S3SigningConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 30_000,
  ) {}

  async getObject(bucket: string, key: string): Promise<Uint8Array | undefined> {
    if (bucket !== this.config.bucket) throw new Error(`storage_source_bucket_mismatch:${bucket}`);
    const { url, headers } = signS3Request(this.config, { method: 'GET', key, headers: {} });
    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`storage_source_get_failed:${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

export class FakeStorageSourceReader implements StorageSourceReader {
  constructor(private readonly objects: Map<string, Uint8Array>) {}
  async getObject(bucket: string, key: string): Promise<Uint8Array | undefined> {
    return this.objects.get(`${bucket}/${key}`);
  }
}

// --- Source completeness guard -----------------------------------------------

export interface SourceCompletenessGuard {
  /** `schema.table` for every table the dump role would miss; empty when complete. */
  unreadableTables(): Promise<string[]>;
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;

/**
 * Every table in `schemas` that the current role cannot fully read. A table
 * is unreadable when the role has no SELECT privilege on it, or, unless the
 * role bypasses RLS, when row security is on and either
 *  - no permissive SELECT/ALL policy names the role with `USING (true)`, so
 *    no policy grants it every row (a reader policy recreated with any other
 *    `USING` would hide rows), or
 *  - any restrictive SELECT/ALL policy applies to the role, by name or through
 *    `public` (a policy without a `TO` clause). Postgres ANDs every applicable
 *    restrictive policy onto the permissive result, so one such policy (say a
 *    tenant check on `app.workspace_id`) leaves the reader with no rows even
 *    though its own policy still exists.
 * Under `--enable-row-security` such a table dumps silently empty or partial,
 * and the dump's own row counts would agree with it; the guard turns that into
 * a failure. The schema list only ever comes from code, and each name is
 * checked before it is quoted into the query.
 */
export function unreadableTablesQuery(schemas: readonly string[]): string {
  for (const schema of schemas) {
    if (!SCHEMA_NAME.test(schema)) throw new Error(`invalid_guard_schema:${schema}`);
  }
  const list = schemas.map((schema) => `'${schema}'`).join(', ');
  return `
  select t.schemaname || '.' || t.tablename
  from pg_tables t
  where t.schemaname in (${list})
    and (
      not has_table_privilege(current_user, format('%I.%I', t.schemaname, t.tablename), 'SELECT')
      or (
        t.rowsecurity
        and not (select rolbypassrls from pg_roles where rolname = current_user)
        and (
          not exists (
            select 1 from pg_policies p
            where p.schemaname = t.schemaname
              and p.tablename = t.tablename
              and p.permissive = 'PERMISSIVE'
              and current_user = any(p.roles)
              and p.cmd in ('SELECT', 'ALL')
              and p.qual = 'true'
          )
          or exists (
            select 1 from pg_policies p
            where p.schemaname = t.schemaname
              and p.tablename = t.tablename
              and p.permissive = 'RESTRICTIVE'
              and (current_user = any(p.roles) or 'public' = any(p.roles))
              and p.cmd in ('SELECT', 'ALL')
          )
        )
      )
    )
  order by 1
`;
}

export const UNREADABLE_TABLES_QUERY = unreadableTablesQuery(APP_SCHEMAS);

export class PsqlSourceCompletenessGuard implements SourceCompletenessGuard {
  private readonly connection: PgConnection;
  private readonly query: string;

  constructor(
    dbUrl: string,
    private readonly run: RunCommand,
    options: { schemas?: readonly string[] } = {},
  ) {
    this.connection = parseConnectionUrl(dbUrl);
    this.query = unreadableTablesQuery(options.schemas ?? APP_SCHEMAS);
  }

  async unreadableTables(): Promise<string[]> {
    const text = await psqlQuery(this.connection, this.run, ['--command', this.query]);
    return outputLines(text).map((line) => line.trim());
  }
}

export class FakeSourceCompletenessGuard implements SourceCompletenessGuard {
  constructor(private readonly tables: string[]) {}
  async unreadableTables(): Promise<string[]> {
    return this.tables;
  }
}
