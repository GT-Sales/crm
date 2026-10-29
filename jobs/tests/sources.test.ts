import { documentObjectKey, type S3SigningConfig } from '@gt-sales/adapters';
import { describe, expect, it } from 'vitest';

import type { RunCommand, RunCommandInput } from '../src/archive/command.js';
import {
  FakeReferencedObjectManifestSource,
  FakeSourceCompletenessGuard,
  FakeStorageSourceReader,
  PsqlReferencedObjectManifestSource,
  PsqlSourceCompletenessGuard,
  REFERENCED_OBJECTS_QUERY,
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

describe('PsqlReferencedObjectManifestSource', () => {
  it('PsqlReferencedObjectManifestSource parses tab-separated rows and the exact query', async () => {
    const { run, calls } = recordingRun(
      `w1\tdocuments\tleads/abc.pdf\t${SUM_A}\t1024\nw2\tdocuments\tleads/def.png\t${SUM_B}\t2048\n`,
    );
    const objects = await new PsqlReferencedObjectManifestSource(
      DB_URL,
      run,
    ).listReferencedObjects();

    expect(objects).toEqual([
      {
        workspaceId: 'w1',
        bucket: 'documents',
        objectKey: 'leads/abc.pdf',
        checksumSha256: SUM_A,
        sizeBytes: 1024,
      },
      {
        workspaceId: 'w2',
        bucket: 'documents',
        objectKey: 'leads/def.png',
        checksumSha256: SUM_B,
        sizeBytes: 2048,
      },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      '--tuples-only',
      '--no-align',
      '--field-separator',
      '\t',
      '--command',
      REFERENCED_OBJECTS_QUERY,
    ]);
    expectConnectionOnlyInEnv(calls[0]);
    expect(REFERENCED_OBJECTS_QUERY).toContain('from app.files where object_key is not null');
    expect(REFERENCED_OBJECTS_QUERY).toContain('from app.file_revisions r join app.files f');
    expect(REFERENCED_OBJECTS_QUERY).not.toContain('checksum_sha256 is not null');
  });

  it('PsqlReferencedObjectManifestSource throws malformed_referenced_object_row on an empty checksum', async () => {
    const { run } = recordingRun(
      `w1\tdocuments\tleads/ok.pdf\t${SUM_A}\t1\nw1\tdocuments\tleads/abc.pdf\t\t1024\n`,
    );
    await expect(
      new PsqlReferencedObjectManifestSource(DB_URL, run).listReferencedObjects(),
    ).rejects.toThrow(new Error('malformed_referenced_object_row:w1/leads/abc.pdf'));
  });

  it('rejects a checksum that is not 64 hex characters, a bad size and a short row', async () => {
    for (const row of [
      `w1\tdocuments\tleads/abc.pdf\tdeadbeef\t1024`,
      `w1\tdocuments\tleads/abc.pdf\t${'g'.repeat(64)}\t1024`,
      `w1\tdocuments\tleads/abc.pdf\t${SUM_A}\t`,
      `w1\tdocuments\tleads/abc.pdf\t${SUM_A}\t-1`,
      `w1\tdocuments\tleads/abc.pdf`,
    ]) {
      const { run } = recordingRun(`${row}\n`);
      await expect(
        new PsqlReferencedObjectManifestSource(DB_URL, run).listReferencedObjects(),
      ).rejects.toThrow(new Error('malformed_referenced_object_row:w1/leads/abc.pdf'));
    }
  });

  it('PsqlReferencedObjectManifestSource returns [] on empty output', async () => {
    const { run } = recordingRun('');
    expect(
      await new PsqlReferencedObjectManifestSource(DB_URL, run).listReferencedObjects(),
    ).toEqual([]);
  });

  it('fails with the psql error and no password when psql exits non-zero', async () => {
    const run: RunCommand = async () => ({
      stdout: new Uint8Array(),
      stderr: `psql: error: connection to ${DB_URL} failed`,
      exitCode: 2,
    });
    const error = await new PsqlReferencedObjectManifestSource(DB_URL, run)
      .listReferencedObjects()
      .catch((caught: unknown) => caught);
    expect(String(error)).toContain('psql_failed:2:');
    expect(String(error)).not.toContain('s3cretPassw0rd');
  });
});

describe('FakeReferencedObjectManifestSource', () => {
  it('returns exactly the injected fixture', async () => {
    const objects = [
      { workspaceId: 'w1', bucket: 'b', objectKey: 'k', checksumSha256: SUM_A, sizeBytes: 1 },
    ];
    expect(await new FakeReferencedObjectManifestSource(objects).listReferencedObjects()).toBe(
      objects,
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

  it('checks the privilege, the reader policy and bypassrls in app, public and drizzle by default', () => {
    expect(UNREADABLE_TABLES_QUERY).toBe(unreadableTablesQuery(['app', 'public', 'drizzle']));
    expect(UNREADABLE_TABLES_QUERY).toContain("t.schemaname in ('app', 'public', 'drizzle')");
    expect(UNREADABLE_TABLES_QUERY).toContain('has_table_privilege(current_user,');
    expect(UNREADABLE_TABLES_QUERY).toContain("'SELECT')");
    expect(UNREADABLE_TABLES_QUERY).toContain('t.rowsecurity');
    expect(UNREADABLE_TABLES_QUERY).toContain('current_user = any(p.roles)');
    expect(UNREADABLE_TABLES_QUERY).toContain("p.cmd in ('SELECT', 'ALL')");
    expect(UNREADABLE_TABLES_QUERY).toContain(
      '(select rolbypassrls from pg_roles where rolname = current_user)',
    );
  });

  it('the query names the schemas given', async () => {
    const { run, calls } = recordingRun('');
    await new PsqlSourceCompletenessGuard(DB_URL, run, {
      schemas: ['app', 'public', 'drizzle', 'auth'],
    }).unreadableTables();
    const query = calls[0]?.args.at(-1) ?? '';
    expect(query).toBe(unreadableTablesQuery(['app', 'public', 'drizzle', 'auth']));
    expect(query).toContain("t.schemaname in ('app', 'public', 'drizzle', 'auth')");
  });

  it('refuses a schema name that is not a plain lower-case identifier', () => {
    const { run } = recordingRun('');
    for (const schema of ["app'; drop table x; --", 'App', '1app', '']) {
      expect(() => new PsqlSourceCompletenessGuard(DB_URL, run, { schemas: [schema] })).toThrow(
        new Error(`invalid_guard_schema:${schema}`),
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
