import { FakeErrorTracker } from '@gt-sales/adapters';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { S3ArchiveReader } from '../src/archive/archive-store.js';
import type { RunCommand, RunCommandInput } from '../src/archive/command.js';
import { AgeCliDecryptor } from '../src/archive/encryptor.js';
import { buildManifest, manifestArtifact, type BackupManifest } from '../src/archive/manifest.js';
import { buildRestoreDependencies, runRestoreCli, type RestoreCliIo } from '../src/restore/cli.js';
import { PsqlAndS3RestoreTarget, ROLE_BYPASSES_RLS_QUERY } from '../src/restore/target.js';

const RUN_ID = 'run-2026-10-29T06-17-00-000Z-0b5e';
const CAPTURED_AT = new Date('2026-10-29T06:17:00.000Z');
const NOW = new Date('2026-10-29T09:00:00.000Z');
const KEY_CONTENTS = 'AGE-SECRET-KEY-1QQQQTESTONLYNOTAREALKEYQQQQ';
const TARGET_PASSWORD = 'tgt-p@ss';
const TARGET_DATABASE_URL = `postgresql://postgres.targetref:${encodeURIComponent(TARGET_PASSWORD)}@aws-1-ap-south-1.pooler.supabase.com:5432/postgres`;
const ARCHIVE_BASE = 'https://s3.eu-central-003.backblazeb2.com/gt-sales-backups/';
const STORAGE_BASE = 'https://targetref.storage.supabase.co/storage/v1/s3/documents/';

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const ARTIFACTS: Record<string, string> = {
  'roles.sql': 'roles',
  'schema.sql': 'schema',
  'data.sql': 'data',
  'objects/ws-1/doc-1.pdf': '%PDF-1 one',
};
const ROW_COUNTS = { 'app.leads': 2, 'app.workspaces': 1 };

let keyDir = '';
let keyPath = '';

function required(): Record<string, string> {
  return {
    RESTORE_RUN_ID: RUN_ID,
    B2_ARCHIVE_READER_KEY_ID: 'b2-recovery-key-id',
    B2_ARCHIVE_READER_APPLICATION_KEY: 'b2-recovery-secret',
    B2_ARCHIVE_ENDPOINT: 'https://s3.eu-central-003.backblazeb2.com',
    B2_ARCHIVE_REGION: 'eu-central-003',
    B2_ARCHIVE_BUCKET: 'gt-sales-backups',
    RECOVERY_PRIVATE_KEY_PATH: keyPath,
  };
}

const TARGET_STORAGE: Record<string, string> = {
  TARGET_STORAGE_ENDPOINT: 'https://targetref.storage.supabase.co/storage/v1/s3',
  TARGET_STORAGE_REGION: 'ap-south-1',
  TARGET_STORAGE_BUCKET: 'documents',
  TARGET_STORAGE_ACCESS_KEY_ID: 'target-storage-key-id',
  TARGET_STORAGE_SECRET_ACCESS_KEY: 'target-storage-secret',
};

function manifest(): BackupManifest {
  return buildManifest({
    deployment: 'gt-sales',
    runId: RUN_ID,
    capturedAt: CAPTURED_AT,
    sourceIds: { supabaseProjectRef: 'sourceref' },
    toolVersions: { age: '1.2.1', pgDump: '17.6' },
    artifacts: Object.entries(ARTIFACTS).map(([name, text]) =>
      manifestArtifact(name, encode(text)),
    ),
    rowCounts: ROW_COUNTS,
    counts: { referencedObjects: 1 },
    exclusions: ['storage_objects_metadata', 'auth_data_skipped_by_operator'],
  });
}

/** Stand-in ciphertext: the fake `age` strips this prefix. */
const sealed = (text: string) => encode(`SEALED:${text}`);

interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body?: Uint8Array;
}

/** A fake archive (B2) and target Storage endpoint behind one fetch. */
function fakeEndpoints(objects: Map<string, Uint8Array>) {
  const requests: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const body = init?.body instanceof Uint8Array ? new Uint8Array(init.body) : undefined;
    const method = init?.method ?? 'GET';
    requests.push({ url: String(url), method, headers: new Headers(init?.headers), body });
    const href = String(url);
    if (href.startsWith(STORAGE_BASE) && method === 'PUT')
      return new Response(null, { status: 200 });
    if (href.startsWith(ARCHIVE_BASE) && method === 'GET') {
      const key = href.slice(ARCHIVE_BASE.length).split('/').map(decodeURIComponent).join('/');
      const stored = objects.get(key);
      return stored ? new Response(stored, { status: 200 }) : new Response(null, { status: 404 });
    }
    return new Response(null, { status: 400 });
  };
  return { fetchImpl, requests };
}

function archiveObjects(overrides: Record<string, Uint8Array> = {}): Map<string, Uint8Array> {
  const objects = new Map<string, Uint8Array>(
    Object.entries(ARTIFACTS).map(([name, text]) => [`${RUN_ID}/${name}.enc`, sealed(text)]),
  );
  objects.set(`${RUN_ID}/manifest.json.enc`, sealed(JSON.stringify(manifest())));
  for (const [key, value] of Object.entries(overrides)) objects.set(key, value);
  return objects;
}

interface RecordedCall {
  command: string;
  args: readonly string[];
  options?: RunCommandInput;
}

/** A fake `age` (identity must be the key path) and `psql` (an empty, RLS-bypassing target). */
function fakeTools(counts: Record<string, number> = ROW_COUNTS, applyStderr?: string) {
  const calls: RecordedCall[] = [];
  const run: RunCommand = async (command, args, options) => {
    calls.push({ command, args, options });
    const ok = (text = '') => ({ stdout: encode(text), stderr: '', exitCode: 0 });
    if (command === 'age') {
      const input = decode(options?.input ?? new Uint8Array());
      if (args.join(' ') !== `-d -i ${keyPath}` || !input.startsWith('SEALED:')) {
        return { stdout: new Uint8Array(), stderr: 'age: error: no identity matched', exitCode: 1 };
      }
      return ok(input.slice('SEALED:'.length));
    }
    if (command === 'psql') {
      const sql = args[args.indexOf('--command') + 1] ?? '';
      if (args.includes('--single-transaction')) {
        return applyStderr ? { stdout: new Uint8Array(), stderr: applyStderr, exitCode: 3 } : ok();
      }
      if (sql === ROLE_BYPASSES_RLS_QUERY) return ok('t\n');
      if (sql.includes('pg_namespace')) return ok('0\n');
      if (sql.includes('query_to_xml')) {
        return ok(
          Object.entries(counts)
            .map(([table, count]) => `${table}\t${count}\n`)
            .join(''),
        );
      }
    }
    return { stdout: new Uint8Array(), stderr: 'unexpected command', exitCode: 127 };
  };
  return { run, calls };
}

function cliIo(objects = archiveObjects(), counts?: Record<string, number>, applyStderr?: string) {
  const endpoints = fakeEndpoints(objects);
  const tools = fakeTools(counts, applyStderr);
  const errorTracker = new FakeErrorTracker();
  let tick = 0;
  const io: RestoreCliIo = {
    fetchImpl: endpoints.fetchImpl,
    run: tools.run,
    errorTracker,
    now: () => new Date(NOW.getTime() + 1000 * tick++),
  };
  return { io, requests: endpoints.requests, calls: tools.calls, errorTracker };
}

function logLines(spy: { mock: { calls: unknown[][] } }): unknown[] {
  return spy.mock.calls.map((call) => JSON.parse(String(call[0])));
}

function rawLogs(...spies: { mock: { calls: unknown[][] } }[]): string {
  return spies.flatMap((spy) => spy.mock.calls.map((call) => String(call[0]))).join('\n');
}

describe('restore CLI', () => {
  let info: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    keyDir = await mkdtemp(join(tmpdir(), 'restore-cli-test-'));
    keyPath = join(keyDir, 'recovery.agekey');
    await writeFile(keyPath, KEY_CONTENTS, { mode: 0o600 });
    info = vi.spyOn(console, 'info').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(keyDir, { recursive: true, force: true });
  });

  it('the CLI refuses to start without the private key file', async () => {
    const { io, requests, calls, errorTracker } = cliIo();
    const env = { ...required(), RECOVERY_PRIVATE_KEY_PATH: join(keyDir, 'absent.agekey') };
    expect(await runRestoreCli(env, io)).toBe(1);
    expect(logLines(error)).toEqual([
      {
        event: 'restore_failed',
        runId: RUN_ID,
        errorCode: 'Error',
        message: 'RECOVERY_PRIVATE_KEY_PATH is not a readable file',
      },
    ]);
    expect(info).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
    expect(calls).toEqual([]);
    expect(errorTracker.events).toHaveLength(1);
    expect(errorTracker.events[0]?.tags).toMatchObject({ route: 'jobs:restore' });
  });

  it('refuses a key path that is a directory, or one the injected access check rejects', async () => {
    const { io } = cliIo();
    await expect(
      buildRestoreDependencies({ ...required(), RECOVERY_PRIVATE_KEY_PATH: keyDir }, io),
    ).rejects.toThrow('RECOVERY_PRIVATE_KEY_PATH is not a readable file');
    const seen: string[] = [];
    const access = async (path: string) => {
      seen.push(path);
      throw new Error('EACCES');
    };
    await expect(buildRestoreDependencies(required(), { ...io, access })).rejects.toThrow(
      'RECOVERY_PRIVATE_KEY_PATH is not a readable file',
    );
    expect(seen).toEqual([keyPath]);
  });

  it('names each missing required variable', async () => {
    const { io } = cliIo();
    for (const name of Object.keys(required())) {
      await expect(buildRestoreDependencies({ ...required(), [name]: ' ' }, io)).rejects.toThrow(
        `${name} is required`,
      );
    }
  });

  it('refuses a RESTORE_RUN_ID that is not a run id', async () => {
    const { io } = cliIo();
    for (const value of ['latest', 'run-', 'run-a/b', '../run-1', 'heartbeat']) {
      await expect(
        buildRestoreDependencies({ ...required(), RESTORE_RUN_ID: value }, io),
      ).rejects.toThrow('RESTORE_RUN_ID must look like run-<id>');
    }
  });

  it('builds a verify-only run from the reader key and the key path', async () => {
    const { io, requests, calls } = cliIo();
    const deps = await buildRestoreDependencies(required(), io);
    expect(deps.runId).toBe(RUN_ID);
    expect(deps.reader).toBeInstanceOf(S3ArchiveReader);
    expect(deps.decryptor).toBeInstanceOf(AgeCliDecryptor);
    expect(deps.target).toBeUndefined();
    expect(deps.incidentDetectedAt).toBeUndefined();
    await deps.reader.getObject(`${RUN_ID}/manifest.json.enc`);
    expect(requests[0]?.url).toBe(`${ARCHIVE_BASE}${RUN_ID}/manifest.json.enc`);
    expect(requests[0]?.headers.get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=b2-recovery-key-id\/\d{8}\/eu-central-003\/s3\/aws4_request, /,
    );
    await deps.decryptor.decrypt(sealed('x'));
    expect(calls[0]?.args).toEqual(['-d', '-i', keyPath]);
  });

  it('builds a psql and S3 target from TARGET_DATABASE_URL and all five storage variables', async () => {
    const { io } = cliIo();
    const deps = await buildRestoreDependencies(
      { ...required(), TARGET_DATABASE_URL, ...TARGET_STORAGE },
      io,
    );
    expect(deps.target).toBeInstanceOf(PsqlAndS3RestoreTarget);
  });

  it('requires all five target storage variables or none, naming the first missing', async () => {
    const { io } = cliIo();
    const names = Object.keys(TARGET_STORAGE);
    for (const [index, name] of names.entries()) {
      const partial = { ...TARGET_STORAGE, [name]: '' };
      const firstMissing = names.find((candidate, i) => i <= index && !partial[candidate]);
      await expect(
        buildRestoreDependencies({ ...required(), TARGET_DATABASE_URL, ...partial }, io),
      ).rejects.toThrow(`${firstMissing} is required`);
    }
    await expect(
      buildRestoreDependencies(
        { ...required(), TARGET_DATABASE_URL, TARGET_STORAGE_SECRET_ACCESS_KEY: 'only-this' },
        io,
      ),
    ).rejects.toThrow('TARGET_STORAGE_ENDPOINT is required');
  });

  it('refuses target storage without a target database', async () => {
    const { io } = cliIo();
    await expect(
      buildRestoreDependencies({ ...required(), ...TARGET_STORAGE }, io),
    ).rejects.toThrow('TARGET_DATABASE_URL is required when TARGET_STORAGE_* is set');
  });

  it('reads INCIDENT_DETECTED_AT as an ISO date-time and rejects anything else', async () => {
    const { io } = cliIo();
    const deps = await buildRestoreDependencies(
      { ...required(), INCIDENT_DETECTED_AT: '2026-10-29T08:47:00Z' },
      io,
    );
    expect(deps.incidentDetectedAt?.toISOString()).toBe('2026-10-29T08:47:00.000Z');
    for (const value of ['yesterday', '2026-10-29', '2026-13-40T00:00:00Z']) {
      await expect(
        buildRestoreDependencies({ ...required(), INCIDENT_DETECTED_AT: value }, io),
      ).rejects.toThrow('INCIDENT_DETECTED_AT must be an ISO 8601 date-time');
    }
  });

  it('verify-only: prints one restore_report line without the artifact list and exits 0', async () => {
    const { io, requests, calls, errorTracker } = cliIo();
    expect(
      await runRestoreCli({ ...required(), INCIDENT_DETECTED_AT: '2026-10-29T08:47:00Z' }, io),
    ).toBe(0);
    expect(logLines(info)).toEqual([
      {
        event: 'restore_report',
        runId: RUN_ID,
        mode: 'verify_only',
        verified: true,
        restored: false,
        manifest: {
          schemaVersion: 1,
          deployment: 'gt-sales',
          runId: RUN_ID,
          capturedAt: CAPTURED_AT.toISOString(),
          sourceIds: { supabaseProjectRef: 'sourceref' },
          toolVersions: { age: '1.2.1', pgDump: '17.6' },
          rowCounts: ROW_COUNTS,
          counts: { referencedObjects: 1 },
          exclusions: ['storage_objects_metadata', 'auth_data_skipped_by_operator'],
          artifactCount: 4,
        },
        missingArtifacts: [],
        mismatchedArtifacts: [],
        rowCountMismatches: [],
        measuredLossWindowMs: 2.5 * 60 * 60 * 1000,
        restoreDurationMs: 1000,
      },
    ]);
    const line = String(info.mock.calls[0]?.[0]);
    expect(line).toContain(
      '"exclusions":["storage_objects_metadata","auth_data_skipped_by_operator"]',
    );
    expect(line).toContain('"rowCounts":{"app.leads":2,"app.workspaces":1}');
    expect(line).not.toContain('"artifacts"');
    expect(line).not.toContain('sha256');
    expect(error).not.toHaveBeenCalled();
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
    expect(calls.every((call) => call.command === 'age')).toBe(true);
    expect(errorTracker.events).toEqual([]);
  });

  it('restores into the target: psql over PG* variables, signed PUTs to the target bucket, exit 0', async () => {
    const { io, requests, calls } = cliIo();
    const env = {
      ...required(),
      TARGET_DATABASE_URL,
      ...TARGET_STORAGE,
      RESTORE_SKIP_ROLES: 'true',
      PGSSLMODE: 'verify-full',
    };
    expect(await runRestoreCli(env, io)).toBe(0);
    expect(logLines(info)).toEqual([
      expect.objectContaining({
        event: 'restore_report',
        mode: 'restore',
        verified: true,
        restored: true,
        rowCountMismatches: [],
      }),
    ]);
    const psql = calls.filter((call) => call.command === 'psql');
    expect(psql).toHaveLength(4);
    for (const call of psql) {
      expect(call.options?.env).toMatchObject({
        PGHOST: 'aws-1-ap-south-1.pooler.supabase.com',
        PGUSER: 'postgres.targetref',
        PGPASSWORD: TARGET_PASSWORD,
        PGDATABASE: 'postgres',
        PGSSLMODE: 'verify-full',
      });
      expect(call.args.join(' ')).not.toContain('postgresql://');
      expect(call.args.join(' ')).not.toContain(TARGET_PASSWORD);
    }
    const apply = psql.find((call) => call.args.includes('--single-transaction'));
    expect(apply?.args.some((arg) => arg.endsWith('roles.sql'))).toBe(false);
    const puts = requests.filter((request) => request.method === 'PUT');
    expect(puts.map((put) => put.url)).toEqual([`${STORAGE_BASE}workspaces/ws-1/doc-1.pdf`]);
    expect(puts[0]?.body).toEqual(encode('%PDF-1 one'));
    expect(puts[0]?.headers.get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=target-storage-key-id\/\d{8}\/ap-south-1\/s3\/aws4_request, /,
    );
  });

  it('a row count mismatch prints the report and exits 1', async () => {
    const { io, errorTracker } = cliIo(archiveObjects(), { 'app.leads': 1, 'app.workspaces': 1 });
    expect(await runRestoreCli({ ...required(), TARGET_DATABASE_URL, ...TARGET_STORAGE }, io)).toBe(
      1,
    );
    expect(logLines(info)).toEqual([
      expect.objectContaining({
        event: 'restore_report',
        verified: true,
        restored: false,
        failedStage: 'row_count_check',
        failureReason: 'row_count_mismatch',
        rowCountMismatches: [{ table: 'app.leads', expected: 2, actual: 1 }],
      }),
    ]);
    expect(errorTracker.events).toEqual([]);
  });

  it('a tampered artifact fails verification, touches no target and exits 1', async () => {
    const { io, requests, calls } = cliIo(
      archiveObjects({ [`${RUN_ID}/data.sql.enc`]: sealed('data plus one forged row') }),
    );
    expect(await runRestoreCli({ ...required(), TARGET_DATABASE_URL, ...TARGET_STORAGE }, io)).toBe(
      1,
    );
    expect(logLines(info)).toEqual([
      expect.objectContaining({
        verified: false,
        restored: false,
        failedStage: 'artifact_fetch_and_decrypt',
        mismatchedArtifacts: ['data.sql'],
      }),
    ]);
    expect(calls.some((call) => call.command === 'psql')).toBe(false);
    expect(requests.some((request) => request.method === 'PUT')).toBe(false);
  });

  it('a verify-only run of a missing manifest exits 1', async () => {
    const objects = archiveObjects();
    objects.delete(`${RUN_ID}/manifest.json.enc`);
    const { io } = cliIo(objects);
    expect(await runRestoreCli(required(), io)).toBe(1);
    expect(logLines(info)).toEqual([
      expect.objectContaining({ verified: false, failedStage: 'manifest_fetch' }),
    ]);
  });

  it('a database target requires the target storage unless RESTORE_SKIP_OBJECTS is set', async () => {
    const { io } = cliIo();
    await expect(
      buildRestoreDependencies({ ...required(), TARGET_DATABASE_URL }, io),
    ).rejects.toThrow(
      'TARGET_STORAGE_ENDPOINT is required when TARGET_DATABASE_URL is set (or RESTORE_SKIP_OBJECTS=1)',
    );
    await expect(
      buildRestoreDependencies(
        { ...required(), TARGET_DATABASE_URL, ...TARGET_STORAGE, TARGET_STORAGE_REGION: ' ' },
        io,
      ),
    ).rejects.toThrow(
      'TARGET_STORAGE_REGION is required when TARGET_DATABASE_URL is set (or RESTORE_SKIP_OBJECTS=1)',
    );
    const deps = await buildRestoreDependencies(
      { ...required(), TARGET_DATABASE_URL, RESTORE_SKIP_OBJECTS: '1' },
      io,
    );
    expect(deps.target).toBeInstanceOf(PsqlAndS3RestoreTarget);
  });

  it('RESTORE_SKIP_OBJECTS loads the database and then fails at objects_apply when the run holds documents', async () => {
    const { io, requests, calls } = cliIo();
    const env = {
      ...required(),
      TARGET_DATABASE_URL,
      ...TARGET_STORAGE,
      RESTORE_SKIP_OBJECTS: 'true',
    };
    expect(await runRestoreCli(env, io)).toBe(1);
    expect(logLines(info)).toEqual([
      expect.objectContaining({
        mode: 'restore',
        verified: true,
        restored: false,
        failedStage: 'objects_apply',
        failureReason: 'restore_storage_not_configured',
      }),
    ]);
    expect(calls.some((call) => call.args.includes('--single-transaction'))).toBe(true);
    expect(requests.some((request) => request.method === 'PUT')).toBe(false);
  });

  it('a failed database load reports the psql ERROR line without row values or credentials', async () => {
    const stderr = [
      `psql: error: connection to postgresql://postgres.targetref:${encodeURIComponent(TARGET_PASSWORD)}@host:5432/postgres lost`,
      'psql:/tmp/gt-sales-restore-x/data.sql:12: ERROR:  duplicate key value violates unique constraint "leads_email_key"',
      'DETAIL:  Key (email)=(a@b.c) already exists.',
      'CONTEXT:  COPY leads, line 3: "3\tAda Lovelace\ta@b.c"',
    ].join('\n');
    const { io, errorTracker } = cliIo(archiveObjects(), undefined, stderr);
    expect(await runRestoreCli({ ...required(), TARGET_DATABASE_URL, ...TARGET_STORAGE }, io)).toBe(
      1,
    );
    expect(logLines(info)).toEqual([
      expect.objectContaining({
        verified: true,
        restored: false,
        failedStage: 'database_apply',
        failureReason: expect.stringContaining(
          'ERROR:  duplicate key value violates unique constraint',
        ),
      }),
    ]);
    const logs = rawLogs(info, error);
    for (const detail of [
      'a@b.c',
      'Ada Lovelace',
      'DETAIL',
      'CONTEXT',
      TARGET_PASSWORD,
      encodeURIComponent(TARGET_PASSWORD),
    ]) {
      expect(logs).not.toContain(detail);
    }
    expect(logs).not.toMatch(/[a-z]+:\/\/[^\s"/]*:[^\s"/[]+@/);
    expect(errorTracker.events).toEqual([]);
  });

  it('never logs the private key contents, a password or a credentialed URL', async () => {
    const failing = cliIo();
    const badTarget = {
      ...required(),
      ...TARGET_STORAGE,
      TARGET_DATABASE_URL: `mysql://root:${TARGET_PASSWORD}@h/db`,
    };
    expect(await runRestoreCli(badTarget, failing.io)).toBe(1);
    expect(logLines(error)).toEqual([
      expect.objectContaining({
        event: 'restore_failed',
        message: 'TARGET_DATABASE_URL must be a postgres:// URL',
      }),
    ]);
    const ok = cliIo();
    expect(
      await runRestoreCli({ ...required(), TARGET_DATABASE_URL, ...TARGET_STORAGE }, ok.io),
    ).toBe(0);
    const logs = rawLogs(info, error);
    for (const secret of [
      KEY_CONTENTS,
      TARGET_PASSWORD,
      encodeURIComponent(TARGET_PASSWORD),
      'b2-recovery-secret',
      'target-storage-secret',
    ]) {
      expect(logs).not.toContain(secret);
    }
    expect(logs).not.toMatch(/[a-z]+:\/\/[^\s"/]*@/);
  });
});
