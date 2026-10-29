import { describe, expect, it } from 'vitest';

import { S3ArchiveWriter } from '../src/archive/archive-store.js';
import type { RunCommand, RunCommandInput } from '../src/archive/command.js';
import { AgeCliEncryptor } from '../src/archive/encryptor.js';
import { buildBackupDependencies } from '../src/backup/cli.js';
import { PgDumpDatabaseExporter } from '../src/backup/pg-dump.js';
import {
  PsqlReferencedObjectManifestSource,
  PsqlSourceCompletenessGuard,
  S3StorageSourceReader,
} from '../src/backup/sources.js';

const NOW = new Date('2026-10-29T06:17:00.000Z');

const REQUIRED: Record<string, string> = {
  BACKUP_DEPLOYMENT: 'gt-sales',
  SOURCE_DATABASE_URL:
    'postgresql://backup_reader.projref:p%40ssw0rd@aws-1-ap-south-1.pooler.supabase.com:5432/postgres',
  SOURCE_STORAGE_ENDPOINT: 'https://projref.storage.supabase.co/storage/v1/s3',
  SOURCE_STORAGE_REGION: 'ap-south-1',
  SOURCE_STORAGE_BUCKET: 'documents',
  SOURCE_STORAGE_ACCESS_KEY_ID: 'storage-key-id',
  SOURCE_STORAGE_SECRET_ACCESS_KEY: 'storage-secret',
  SUPABASE_PROJECT_REF: 'projref',
  RECOVERY_AGE_RECIPIENT: 'age1recipientexample',
  B2_ARCHIVE_ENDPOINT: 'https://s3.eu-central-003.backblazeb2.com',
  B2_ARCHIVE_REGION: 'eu-central-003',
  B2_ARCHIVE_BUCKET: 'gt-sales-backups',
  B2_ARCHIVE_WRITER_KEY_ID: 'b2-writer-key-id',
  B2_ARCHIVE_WRITER_APPLICATION_KEY: 'b2-writer-secret',
};

interface RecordedCall {
  command: string;
  args: readonly string[];
  options?: RunCommandInput;
}

function recordingIo() {
  const calls: RecordedCall[] = [];
  const run: RunCommand = async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout: new Uint8Array(), stderr: '', exitCode: 0 };
  };
  const requests: { url: string; headers: Headers }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers) });
    return new Response(new Uint8Array([1]), { status: 200 });
  };
  return { io: { run, fetchImpl }, calls, requests };
}

function hasSchemaFlag(args: readonly string[], schema: string): boolean {
  return args.some((arg, index) => arg === '--schema' && args[index + 1] === schema);
}

describe('buildBackupDependencies', () => {
  it('builds dependencies from the environment with the documented defaults', async () => {
    const { io, calls, requests } = recordingIo();
    const deps = buildBackupDependencies({ ...REQUIRED }, NOW, io);

    expect(deps.deployment).toBe('gt-sales');
    expect(deps.runId).toMatch(
      /^run-2026-10-29T06-17-00-000Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(deps.exclusions).toEqual([]);
    expect(deps.maxSnapshotBytes).toBeUndefined();
    expect(deps.sourceIds).toEqual({ supabaseProjectRef: 'projref' });
    expect(deps.toolVersions).toEqual({ age: 'unknown', pgDump: 'unknown' });
    expect(deps.encryptor).toBeInstanceOf(AgeCliEncryptor);
    expect(deps.archiveWriter).toBeInstanceOf(S3ArchiveWriter);
    expect(deps.database).toBeInstanceOf(PgDumpDatabaseExporter);
    expect(deps.referencedObjects).toBeInstanceOf(PsqlReferencedObjectManifestSource);
    expect(deps.storageSource).toBeInstanceOf(S3StorageSourceReader);
    expect(deps.guard).toBeInstanceOf(PsqlSourceCompletenessGuard);

    // PgDumpOptions include/include: auth data in the data dump, and both history dumps.
    await deps.database.exportAll();
    expect(calls.map((call) => call.command)).toEqual([
      'pg_dumpall',
      'pg_dump',
      'pg_dump',
      'pg_dump',
      'pg_dump',
    ]);
    const dataArgs = calls[2]?.args ?? [];
    expect(dataArgs).toContain('--data-only');
    expect(hasSchemaFlag(dataArgs, 'auth')).toBe(true);
    expect(hasSchemaFlag(calls[3]?.args ?? [], 'supabase_migrations')).toBe(true);
    // The URL-encoded password reaches the tools decoded, through the environment only.
    expect(calls[0]?.options?.env).toMatchObject({
      PGHOST: 'aws-1-ap-south-1.pooler.supabase.com',
      PGPORT: '5432',
      PGUSER: 'backup_reader.projref',
      PGPASSWORD: 'p@ssw0rd',
    });

    // The encryptor shells to age with the recovery recipient.
    calls.length = 0;
    await deps.encryptor.encrypt(new Uint8Array([1]));
    expect(calls[0]).toMatchObject({ command: 'age', args: ['-r', 'age1recipientexample'] });

    // The archive writer signs with the writer key against the deployment's bucket.
    await deps.archiveWriter.putObject('run-x/data.sql.enc', new Uint8Array([1]));
    expect(requests[0]?.url).toBe(
      'https://s3.eu-central-003.backblazeb2.com/gt-sales-backups/run-x/data.sql.enc',
    );
    expect(requests[0]?.headers.get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=b2-writer-key-id\/\d{8}\/eu-central-003\/s3\/aws4_request, /,
    );

    // The storage reader signs exactly the physical key, against the source bucket only.
    await deps.storageSource.getObject('documents', 'workspaces/w1/docs/a.pdf');
    expect(requests[1]?.url).toBe(
      'https://projref.storage.supabase.co/storage/v1/s3/documents/workspaces/w1/docs/a.pdf',
    );
    expect(requests[1]?.headers.get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=storage-key-id\/\d{8}\/ap-south-1\/s3\/aws4_request, /,
    );
    await expect(deps.storageSource.getObject('other', 'workspaces/w1/x')).rejects.toThrow(
      'storage_source_bucket_mismatch:other',
    );
  });

  it('passes the optional run id, size limit and tool versions through', () => {
    const { io } = recordingIo();
    const deps = buildBackupDependencies(
      {
        ...REQUIRED,
        BACKUP_RUN_ID: 'run-manual-retry',
        BACKUP_MAX_SNAPSHOT_BYTES: '1048576',
        AGE_VERSION: '1.2.1',
        PG_DUMP_VERSION: '17.6',
      },
      NOW,
      io,
    );
    expect(deps.runId).toBe('run-manual-retry');
    expect(deps.maxSnapshotBytes).toBe(1048576);
    expect(deps.toolVersions).toEqual({ age: '1.2.1', pgDump: '17.6' });
    expect(() =>
      buildBackupDependencies({ ...REQUIRED, BACKUP_MAX_SNAPSHOT_BYTES: '2GiB' }, NOW, io),
    ).toThrow('BACKUP_MAX_SNAPSHOT_BYTES must be a positive whole number');
  });

  it('BACKUP_AUTH_DATA=skip and BACKUP_HISTORY=skip add their exclusions', async () => {
    const { io, calls } = recordingIo();
    const deps = buildBackupDependencies(
      { ...REQUIRED, BACKUP_AUTH_DATA: 'skip', BACKUP_HISTORY: 'skip' },
      NOW,
      io,
    );
    expect(deps.exclusions).toEqual([
      'auth_data_skipped_by_operator',
      'supabase_migrations_skipped_by_operator',
    ]);
    await deps.database.exportAll();
    expect(calls.map((call) => call.command)).toEqual(['pg_dumpall', 'pg_dump', 'pg_dump']);
    expect(hasSchemaFlag(calls[2]?.args ?? [], 'auth')).toBe(false);
  });

  it('the guard checks the auth schema exactly when auth data is dumped', async () => {
    const guardQuery = async (env: NodeJS.ProcessEnv) => {
      const { io, calls } = recordingIo();
      await buildBackupDependencies(env, NOW, io).guard.unreadableTables();
      const args = calls[0]?.args ?? [];
      expect(calls[0]?.command).toBe('psql');
      return args[args.indexOf('--command') + 1] ?? '';
    };
    const included = await guardQuery({ ...REQUIRED });
    const explicit = await guardQuery({ ...REQUIRED, BACKUP_AUTH_DATA: 'include' });
    const skipped = await guardQuery({ ...REQUIRED, BACKUP_AUTH_DATA: 'skip' });
    expect(included).toContain(`in ('app', 'public', 'drizzle', 'auth')`);
    expect(explicit).toBe(included);
    expect(skipped).toContain(`in ('app', 'public', 'drizzle')`);
    expect(skipped).not.toContain(`'auth'`);
  });

  it('names the first missing required variable', () => {
    const { io } = recordingIo();
    expect(() => buildBackupDependencies({}, NOW, io)).toThrow('BACKUP_DEPLOYMENT is required');
    for (const name of Object.keys(REQUIRED)) {
      const env: NodeJS.ProcessEnv = { ...REQUIRED, [name]: '  ' };
      expect(() => buildBackupDependencies(env, NOW, io)).toThrow(`${name} is required`);
    }
  });

  it('rejects BACKUP_AUTH_DATA values other than include or skip', () => {
    const { io } = recordingIo();
    expect(() => buildBackupDependencies({ ...REQUIRED, BACKUP_AUTH_DATA: 'no' }, NOW, io)).toThrow(
      'BACKUP_AUTH_DATA must be include or skip',
    );
    expect(() =>
      buildBackupDependencies({ ...REQUIRED, BACKUP_HISTORY: 'false' }, NOW, io),
    ).toThrow('BACKUP_HISTORY must be include or skip');
  });
});
