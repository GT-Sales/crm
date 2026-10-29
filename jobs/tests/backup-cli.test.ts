import { describe, expect, it } from 'vitest';

import { S3ArchiveWriter } from '../src/archive/archive-store.js';
import type { RunCommand, RunCommandInput } from '../src/archive/command.js';
import { AgeCliEncryptor } from '../src/archive/encryptor.js';
import { backupFailedLogLine, buildBackupDependencies } from '../src/backup/cli.js';
import { PgDumpDatabaseExporter } from '../src/backup/pg-dump.js';
import {
  BackupIncompleteError,
  BackupSourceUnreadableError,
  BackupUploadVerificationError,
} from '../src/backup/run.js';
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

    // PgDumpOptions include/include: the two auth tables' data, and both history dumps.
    await deps.database.exportAll();
    expect(calls.map((call) => call.command)).toEqual([
      'pg_dumpall',
      'pg_dump',
      'pg_dump',
      'pg_dump',
      'pg_dump',
      'pg_dump',
    ]);
    const authArgs = calls[3]?.args ?? [];
    expect(authArgs).toContain('--data-only');
    expect(authArgs).toEqual(expect.arrayContaining(['--table', 'auth.users', 'auth.identities']));
    expect(hasSchemaFlag(authArgs, 'auth')).toBe(false);
    expect(hasSchemaFlag(calls[4]?.args ?? [], 'supabase_migrations')).toBe(true);
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
    for (const call of calls) expect(call.args.join(' ')).not.toContain('auth');
  });

  it('the guard checks the two auth tables exactly when auth data is dumped, never the auth schema', async () => {
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
    expect(included).toContain(`n.nspname in ('app', 'public', 'drizzle')`);
    expect(included).toContain(
      `(n.nspname, c.relname) in (('auth', 'users'), ('auth', 'identities'))`,
    );
    expect(included).not.toContain(`'drizzle', 'auth'`);
    expect(explicit).toBe(included);
    expect(skipped).toContain(`n.nspname in ('app', 'public', 'drizzle')`);
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

describe('backupFailedLogLine', () => {
  it('names the unreadable tables of a guard failure', () => {
    expect(
      backupFailedLogLine(new BackupSourceUnreadableError(['app.leads', 'auth.users']), {
        deployment: 'gt-sales',
        runId: 'run-1',
      }),
    ).toEqual({
      event: 'backup_failed',
      deployment: 'gt-sales',
      runId: 'run-1',
      errorCode: 'BackupSourceUnreadableError',
      message: 'backup_source_unreadable:2_tables',
      tables: ['app.leads', 'auth.users'],
    });
  });

  it('names the missing or mismatched document objects of an incomplete backup', () => {
    const objects = [`documents/candidate/w1/${'a'.repeat(8)}-0123456789abcdef`];
    expect(backupFailedLogLine(new BackupIncompleteError(objects), { runId: 'run-1' })).toEqual({
      event: 'backup_failed',
      runId: 'run-1',
      errorCode: 'BackupIncompleteError',
      message: 'backup_incomplete:1_objects',
      missingOrMismatchedObjects: objects,
    });
  });

  it('names the archive keys an upload listing did not show', () => {
    const keys = ['run-1/data.sql.enc', 'run-1/manifest.json.enc'];
    expect(backupFailedLogLine(new BackupUploadVerificationError(keys))).toEqual({
      event: 'backup_failed',
      errorCode: 'BackupUploadVerificationError',
      message: 'backup_upload_incomplete:2_keys',
      missingKeys: keys,
    });
  });

  it('logs only the name and message of any other error, and a code for a non-error', () => {
    expect(backupFailedLogLine(new Error('age_failed'), { deployment: 'gt-sales' })).toEqual({
      event: 'backup_failed',
      deployment: 'gt-sales',
      errorCode: 'Error',
      message: 'age_failed',
    });
    expect(backupFailedLogLine('boom')).toEqual({
      event: 'backup_failed',
      errorCode: 'unknown_error',
      message: 'non_error_thrown',
    });
  });
});
