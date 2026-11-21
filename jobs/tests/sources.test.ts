import { documentObjectKey, type S3SigningConfig } from '@gt-sales/adapters';
import { describe, expect, it } from 'vitest';

import type { RunCommand, RunCommandInput } from '../src/archive/command.js';
import {
  FakeSourceCompletenessGuard,
  FakeStorageSourceReader,
  PsqlSourceCompletenessGuard,
  referencedObjectsFromDump,
  S3StorageSourceReader,
  UNREADABLE_TABLES_QUERY,
  unreadableTablesQuery,
} from '../src/backup/sources.js';

const DB_URL =
  'postgresql://backup_reader.xykrphbgpwisqacpyeiv:s3cretPassw0rd@aws-0-us-west-2.pooler.supabase.com:5432/postgres';

const SUM_A = 'a'.repeat(64);
const SUM_B = '0123456789abcdef'.repeat(4);

interface RecordedCall {
  command: string;
  args: readonly string[];
  options?: RunCommandInput;
}

function recordingRun(stdout: string) {
  const calls: RecordedCall[] = [];
  const run: RunCommand = async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout: new TextEncoder().encode(stdout), stderr: '', exitCode: 0 };
  };
  return { run, calls };
}

function expectConnectionOnlyInEnv(call: RecordedCall | undefined) {
  expect(call?.command).toBe('psql');
  const argv = call?.args.join(' ') ?? '';
  expect(argv).not.toContain('postgresql://');
  expect(argv).not.toContain('s3cretPassw0rd');
  expect(call?.options?.env).toMatchObject({
    PGHOST: 'aws-0-us-west-2.pooler.supabase.com',
    PGPORT: '5432',
    PGUSER: 'backup_reader.xykrphbgpwisqacpyeiv',
    PGPASSWORD: 's3cretPassw0rd',
    PGDATABASE: 'postgres',
  });
}

const FILES_COPY =
  'COPY "app"."files" ("id", "workspace_id", "record_type", "bucket", "staging_key", "candidate_key", "object_key", "size_bytes", "checksum_sha256", "status") FROM stdin;';
const REVISIONS_COPY =
  'COPY "app"."file_revisions" ("id", "workspace_id", "file_id", "revision", "object_key", "size_bytes", "checksum_sha256") FROM stdin;';

function dumpWith(files: string[], revisions: string[] = []): string {
  return [
    'SET row_security = on;',
    FILES_COPY,
    ...files,
    '\\.',
    REVISIONS_COPY,
    ...revisions,
    '\\.',
    '',
  ].join('\n');
}

describe('referencedObjectsFromDump', () => {
  it('lists every object a dumped file row or revision points at, from the dump itself (#86)', () => {
    const sql = dumpWith(
      [
        `f1\tw1\tlead\tdocuments\tstaging/w1/s1\tcandidate/w1/c1\tleads/abc.pdf\t1024\t${SUM_A}\tavailable`,
        `f2\tw2\tlead\tdocuments\tstaging/w2/s2\t\\N\tleads/def.png\t2048\t${SUM_B}\tdeleted`,
        // Still uploading: no verified object yet, so nothing to copy.
        `f3\tw1\tlead\tdocuments\tstaging/w1/s3\t\\N\t\\N\t\\N\t\\N\tuploading`,
      ],
      [`r1\tw1\tf1\t1\tleads/old.pdf\t512\t${SUM_B}`],
    );
    expect(referencedObjectsFromDump(sql)).toEqual([
      {
        workspaceId: 'w1',
        bucket: 'documents',
        objectKey: 'leads/abc.pdf',
        checksumSha256: SUM_A,
        sizeBytes: 1024,
        fileDeleted: false,
      },
      {
        workspaceId: 'w2',
        bucket: 'documents',
        objectKey: 'leads/def.png',
        checksumSha256: SUM_B,
        sizeBytes: 2048,
        fileDeleted: true,
      },
      {
        workspaceId: 'w1',
        bucket: 'documents',
        objectKey: 'leads/old.pdf',
        checksumSha256: SUM_B,
        sizeBytes: 512,
        fileDeleted: false,
      },
    ]);
  });

  it('lists an object a file row and its revision share once', () => {
    const sql = dumpWith(
      [`f1\tw1\tlead\tdocuments\ts\t\\N\tleads/abc.pdf\t1024\t${SUM_A}\tavailable`],
      [`r1\tw1\tf1\t1\tleads/abc.pdf\t1024\t${SUM_A}`],
    );
    expect(referencedObjectsFromDump(sql)).toHaveLength(1);
  });

  it('decodes COPY escapes in a key', () => {
    const sql = dumpWith([
      `f1\tw1\tlead\tdocuments\ts\t\\N\tleads/a\\\\b\\tc.pdf\t1\t${SUM_A}\tavailable`,
    ]);
    expect(referencedObjectsFromDump(sql)[0]?.objectKey).toBe('leads/a\\b\tc.pdf');
  });

  it('fails on a referenced row whose checksum or size cannot be verified, never skipping it', () => {
    for (const row of [
      `f1\tw1\tlead\tdocuments\ts\t\\N\tleads/abc.pdf\t1024\t\\N\tavailable`,
      `f1\tw1\tlead\tdocuments\ts\t\\N\tleads/abc.pdf\t1024\tdeadbeef\tavailable`,
      `f1\tw1\tlead\tdocuments\ts\t\\N\tleads/abc.pdf\t\\N\t${SUM_A}\tavailable`,
      `f1\tw1\tlead\tdocuments\ts\t\\N\tleads/abc.pdf\t-1\t${SUM_A}\tavailable`,
    ]) {
      expect(() => referencedObjectsFromDump(dumpWith([row]))).toThrow(
        new Error('malformed_referenced_object_row:w1/leads/abc.pdf'),
      );
    }
  });

  it('fails on a revision whose file is not in the dump, and on a dump without the files table', () => {
    expect(() =>
      referencedObjectsFromDump(dumpWith([], [`r1\tw1\tf9\t1\tleads/x.pdf\t1\t${SUM_A}`])),
    ).toThrow(new Error('malformed_referenced_object_row:w1/leads/x.pdf'));
    expect(() => referencedObjectsFromDump('SET row_security = on;\n')).toThrow(
      new Error('backup_dump_missing_table:app.files'),
    );
  });

  it('fails on a row with the wrong number of fields', () => {
    expect(() => referencedObjectsFromDump(dumpWith([`f1\tw1\tlead`]))).toThrow(
      'copy_row_malformed:app.files',
    );
  });
});

const storageConfig: S3SigningConfig = {
  accessKeyId: 'source-key-id',
  secretAccessKey: 'source-secret',
  endpoint: 'https://project.supabase.co/storage/v1/s3',
  region: 'us-west-2',
  bucket: 'documents',
};

describe('S3StorageSourceReader', () => {
  it('S3StorageSourceReader signs a GET for workspaces/<ws>/<key>, returns undefined on 404, throws storage_source_get_failed:<status> otherwise', async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    let status = 200;
    const fakeFetch: typeof fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      return status === 200
        ? new Response(new Uint8Array([1, 2, 3]), { status })
        : new Response(null, { status });
    };
    const reader = new S3StorageSourceReader(storageConfig, fakeFetch);
    const key = documentObjectKey('ws-1', 'leads/abc.pdf');

    expect(await reader.getObject('documents', key)).toEqual(new Uint8Array([1, 2, 3]));
    expect(requests[0]?.url).toBe(
      'https://project.supabase.co/storage/v1/s3/documents/workspaces/ws-1/leads/abc.pdf',
    );
    expect(requests[0]?.init?.method ?? 'GET').toBe('GET');
    expect(requests[0]?.init?.redirect).toBe('error');
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=source-key-id\/\d{8}\/us-west-2\/s3\/aws4_request, /,
    );
    expect(headers.get('x-amz-date')).toMatch(/^\d{8}T\d{6}Z$/);

    status = 404;
    expect(await reader.getObject('documents', key)).toBeUndefined();

    status = 500;
    await expect(reader.getObject('documents', key)).rejects.toThrow(
      new Error('storage_source_get_failed:500'),
    );
    expect(requests).toHaveLength(3);
  });

  it('throws storage_source_bucket_mismatch for a bucket the reader is not configured for, without fetching', async () => {
    let fetched = false;
    const fakeFetch: typeof fetch = async () => {
      fetched = true;
      return new Response(new Uint8Array([1]));
    };
    const reader = new S3StorageSourceReader(storageConfig, fakeFetch);
    await expect(reader.getObject('mobility-ids', 'workspaces/ws-1/x.png')).rejects.toThrow(
      new Error('storage_source_bucket_mismatch:mobility-ids'),
    );
    expect(fetched).toBe(false);
  });
});

describe('FakeStorageSourceReader', () => {
  it('keys objects by bucket/key', async () => {
    const reader = new FakeStorageSourceReader(new Map([['bucket/key', new Uint8Array([9])]]));
    expect(await reader.getObject('bucket', 'key')).toEqual(new Uint8Array([9]));
    expect(await reader.getObject('bucket', 'other')).toBeUndefined();
    expect(await reader.getObject('other', 'key')).toBeUndefined();
  });
});

describe('PsqlSourceCompletenessGuard', () => {
  it('PsqlSourceCompletenessGuard returns the schema.table names psql printed', async () => {
    const { run, calls } = recordingRun('app.leads\npublic.posts_backup_pickup_fix\n');
    expect(await new PsqlSourceCompletenessGuard(DB_URL, run).unreadableTables()).toEqual([
      'app.leads',
      'public.posts_backup_pickup_fix',
    ]);
    expect(calls[0]?.args).toEqual([
      '--tuples-only',
      '--no-align',
      '--command',
      UNREADABLE_TABLES_QUERY,
    ]);
    expectConnectionOnlyInEnv(calls[0]);
  });

  it('returns [] when psql prints nothing', async () => {
    const { run } = recordingRun('\n');
    expect(await new PsqlSourceCompletenessGuard(DB_URL, run).unreadableTables()).toEqual([]);
  });

  it('checks schema USAGE, the privilege, the reader policy and bypassrls in app, public and drizzle by default', () => {
    expect(UNREADABLE_TABLES_QUERY).toBe(unreadableTablesQuery(['app', 'public', 'drizzle']));
    expect(UNREADABLE_TABLES_QUERY).toContain(
      'from pg_class c join pg_namespace n on n.oid = c.relnamespace',
    );
    expect(UNREADABLE_TABLES_QUERY).toContain("c.relkind in ('r', 'p')");
    expect(UNREADABLE_TABLES_QUERY).toContain("n.nspname in ('app', 'public', 'drizzle')");
    expect(UNREADABLE_TABLES_QUERY).toContain(
      "not has_schema_privilege(current_user, n.nspname, 'USAGE')",
    );
    expect(UNREADABLE_TABLES_QUERY).toContain(
      "not has_table_privilege(current_user, c.oid, 'SELECT')",
    );
    expect(UNREADABLE_TABLES_QUERY).toContain('c.relrowsecurity');
    expect(UNREADABLE_TABLES_QUERY).toContain('current_user = any(p.roles)');
    expect(UNREADABLE_TABLES_QUERY).toContain("p.cmd in ('SELECT', 'ALL')");
    expect(UNREADABLE_TABLES_QUERY).toContain(
      '(select rolbypassrls from pg_roles where rolname = current_user)',
    );
    // Never a name lookup, which fails outright on a schema without USAGE.
    expect(UNREADABLE_TABLES_QUERY).not.toContain('format(');
    expect(UNREADABLE_TABLES_QUERY).not.toContain('pg_tables');
    // No individually listed tables by default.
    expect(UNREADABLE_TABLES_QUERY).not.toContain('(n.nspname, c.relname) in');
  });

  it('requires the reader policy to grant every row with USING (true)', () => {
    const [, afterNotExists = ''] = UNREADABLE_TABLES_QUERY.split('not exists (');
    const [permissive = ''] = afterNotExists.split('or exists (');
    expect(permissive).toContain('p.schemaname = n.nspname');
    expect(permissive).toContain('p.tablename = c.relname');
    expect(permissive).toContain("p.permissive = 'PERMISSIVE'");
    expect(permissive).toContain('current_user = any(p.roles)');
    expect(permissive).toContain("p.cmd in ('SELECT', 'ALL')");
    expect(permissive).toContain("p.qual = 'true'");
  });

  it('flags a table when any restrictive SELECT/ALL policy applies to the reader or to public', () => {
    const [, afterOrExists = ''] = UNREADABLE_TABLES_QUERY.split('or exists (');
    const [restrictive = ''] = afterOrExists.split('union all');
    expect(restrictive).toContain("p.permissive = 'RESTRICTIVE'");
    expect(restrictive).toContain("(current_user = any(p.roles) or 'public' = any(p.roles))");
    expect(restrictive).toContain("p.cmd in ('SELECT', 'ALL')");
    expect(restrictive).not.toContain('p.qual');
  });

  it('reports every sequence in the schemas the role cannot read', () => {
    const [, sequences = ''] = UNREADABLE_TABLES_QUERY.split('union all');
    expect(sequences).toContain("c.relkind = 'S'");
    expect(sequences).toContain("n.nspname in ('app', 'public', 'drizzle')");
    expect(sequences).toContain("not has_schema_privilege(current_user, n.nspname, 'USAGE')");
    expect(sequences).toContain("not has_sequence_privilege(current_user, c.oid, 'SELECT')");
    expect(sequences.trim().endsWith('order by 1')).toBe(true);
  });

  it('the query names the schemas given', async () => {
    const { run, calls } = recordingRun('');
    await new PsqlSourceCompletenessGuard(DB_URL, run, {
      schemas: ['app', 'public'],
    }).unreadableTables();
    const query = calls[0]?.args.at(-1) ?? '';
    expect(query).toBe(unreadableTablesQuery(['app', 'public']));
    expect(query).toContain("n.nspname in ('app', 'public')");
  });

  it('checks individually listed tables with the same predicates, whatever the schemas', async () => {
    const { run, calls } = recordingRun('auth.identities\n');
    const guard = new PsqlSourceCompletenessGuard(DB_URL, run, {
      tables: ['auth.users', 'auth.identities'],
    });
    expect(await guard.unreadableTables()).toEqual(['auth.identities']);
    const query = calls[0]?.args.at(-1) ?? '';
    expect(query).toBe(
      unreadableTablesQuery(['app', 'public', 'drizzle'], ['auth.users', 'auth.identities']),
    );
    const [tablePart = '', sequencePart = ''] = query.split('union all');
    expect(tablePart).toContain(
      "(n.nspname in ('app', 'public', 'drizzle') or (n.nspname, c.relname) in (('auth', 'users'), ('auth', 'identities')))",
    );
    // A listed table's schema is not swept for other tables or sequences.
    expect(query).not.toContain("'auth')");
    expect(sequencePart).not.toContain('auth');
    expect(sequencePart).toContain("and n.nspname in ('app', 'public', 'drizzle')");
  });

  it('refuses a schema name that is not a plain lower-case identifier', () => {
    const { run } = recordingRun('');
    for (const schema of ["app'; drop table x; --", 'App', '1app', '']) {
      expect(() => new PsqlSourceCompletenessGuard(DB_URL, run, { schemas: [schema] })).toThrow(
        new Error(`invalid_guard_schema:${schema}`),
      );
    }
  });

  it('refuses a table name that is not schema.table of plain lower-case identifiers', () => {
    const { run } = recordingRun('');
    for (const table of ['users', 'auth.users.x', "auth.users'; --", 'Auth.users', 'auth.', '']) {
      expect(() => new PsqlSourceCompletenessGuard(DB_URL, run, { tables: [table] })).toThrow(
        new Error(`invalid_guard_table:${table}`),
      );
    }
  });
});

describe('FakeSourceCompletenessGuard', () => {
  it('returns the injected tables', async () => {
    expect(await new FakeSourceCompletenessGuard(['app.leads']).unreadableTables()).toEqual([
      'app.leads',
    ]);
  });
});
