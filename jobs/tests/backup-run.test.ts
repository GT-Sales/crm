import { sha256Hex } from '@gt-sales/adapters';
import { describe, expect, it } from 'vitest';

import { InMemoryArchiveBackend, type ArchiveWriter } from '../src/archive/archive-store.js';
import {
  generateTestRecipientKeyPair,
  TestEnvelopeDecryptor,
  TestEnvelopeEncryptor,
} from '../src/archive/encryptor.js';
import { HEARTBEAT_KEY, readLatestHeartbeat } from '../src/archive/heartbeat.js';
import { backupManifestSchema, verifyManifestArtifacts } from '../src/archive/manifest.js';
import { countCopyRows } from '../src/backup/copy-rows.js';
import type { DatabaseDumpArtifacts, DatabaseExporter } from '../src/backup/pg-dump.js';
import {
  BackupIncompleteError,
  BackupSourceUnreadableError,
  BackupTooLargeError,
  BackupUploadVerificationError,
  createBackupRunId,
  DEFAULT_MAX_SNAPSHOT_BYTES,
  runBackup,
  type BackupRunDependencies,
} from '../src/backup/run.js';
import {
  FakeReferencedObjectManifestSource,
  FakeSourceCompletenessGuard,
  FakeStorageSourceReader,
  type StorageSourceReader,
} from '../src/backup/sources.js';

const RUN_ID = 'run-2026-10-29T06-17-00-000Z-test';
const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const DATA_SQL = [
  'SET row_security = on;',
  'COPY "app"."leads" ("id", "name") FROM stdin;',
  '1\tAda',
  '2\tGrace',
  '3\tLinus',
  '\\.',
  'COPY "app"."files" ("id") FROM stdin;',
  '\\.',
  '',
].join('\n');

const BASE_EXCLUSIONS = [
  'storage_objects_metadata',
  'supabase_project_settings',
  'jwt_and_api_keys',
  'database_and_role_passwords',
  'smtp_oauth_secrets',
  'provider_account_mfa',
];

function dump(): DatabaseDumpArtifacts {
  return {
    roles: encode('roles'),
    schema: encode('schema'),
    data: encode(DATA_SQL),
    historySchema: encode('history-schema'),
    historyData: encode('history-data'),
  };
}

function dumpBytes(artifacts: DatabaseDumpArtifacts): number {
  return [
    artifacts.roles,
    artifacts.schema,
    artifacts.data,
    artifacts.historySchema,
    artifacts.historyData,
  ].reduce((total, bytes) => total + (bytes?.byteLength ?? 0), 0);
}

/** A database exporter that records whether it was asked to export. */
function spyDatabase(artifacts: DatabaseDumpArtifacts = dump()) {
  const calls = { exportAll: 0 };
  const database: DatabaseExporter = {
    exportAll: async () => {
      calls.exportAll += 1;
      return artifacts;
    },
  };
  return { database, calls };
}

/** A storage reader that counts reads and delegates to a fake. */
function countingStorage(objects: Map<string, Uint8Array>) {
  const reads: string[] = [];
  const inner = new FakeStorageSourceReader(objects);
  const storageSource: StorageSourceReader = {
    getObject: async (bucket, key) => {
      reads.push(`${bucket}/${key}`);
      return inner.getObject(bucket, key);
    },
  };
  return { storageSource, reads };
}

/** A writer that records the order of its uploads. */
function recordingWriter(writer: ArchiveWriter) {
  const puts: string[] = [];
  const recorded: ArchiveWriter = {
    putObject: async (key, body) => {
      puts.push(key);
      return writer.putObject(key, body);
    },
    listObjects: (prefix) => writer.listObjects(prefix),
  };
  return { writer: recorded, puts };
}

function setup() {
  const backend = new InMemoryArchiveBackend();
  const { publicKeyBase64, privateKeyBase64 } = generateTestRecipientKeyPair();
  const document = encode('customer-document-bytes');
  const { database, calls } = spyDatabase();
  const { storageSource, reads } = countingStorage(
    new Map([['documents/workspaces/w1/docs/passport.pdf', document]]),
  );
  const { writer, puts } = recordingWriter(backend.asWriter());
  const deps: BackupRunDependencies = {
    deployment: 'gt-sales',
    runId: RUN_ID,
    now: () => new Date('2026-10-29T06:17:00.000Z'),
    encryptor: new TestEnvelopeEncryptor(publicKeyBase64),
    archiveWriter: writer,
    database,
    referencedObjects: new FakeReferencedObjectManifestSource([
      {
        workspaceId: 'w1',
        bucket: 'documents',
        objectKey: 'docs/passport.pdf',
        checksumSha256: sha256Hex(document),
        sizeBytes: document.byteLength,
      },
    ]),
    storageSource,
    guard: new FakeSourceCompletenessGuard([]),
    sourceIds: { supabaseProjectRef: 'proj-abc' },
    toolVersions: { age: '1.2.1', pgDump: '17.6' },
  };
  return {
    backend,
    deps,
    document,
    calls,
    reads,
    puts,
    decryptor: new TestEnvelopeDecryptor(privateKeyBase64),
  };
}

async function decryptManifest(
  backend: InMemoryArchiveBackend,
  decryptor: TestEnvelopeDecryptor,
  key = `${RUN_ID}/manifest.json.enc`,
) {
  const ciphertext = await backend.asReader().getObject(key);
  if (!ciphertext) throw new Error('manifest missing');
  return backupManifestSchema.parse(JSON.parse(decode(await decryptor.decrypt(ciphertext))));
}

describe('createBackupRunId', () => {
  it('is run-<timestamp>-<uuid> and distinct even at the same instant', () => {
    const now = new Date('2026-10-21T01:00:00.000Z');
    const first = createBackupRunId(now);
    expect(first).toMatch(
      /^run-2026-10-21T01-00-00-000Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(createBackupRunId(now)).not.toBe(first);
  });
});

describe('runBackup', () => {
  it('a complete run uploads every artifact encrypted, the manifest last, and publishes a verified heartbeat', async () => {
    const { backend, deps, document, decryptor, puts, reads } = setup();
    const summary = await runBackup(deps);

    expect(summary).toEqual({
      runId: RUN_ID,
      manifestKey: `${RUN_ID}/manifest.json.enc`,
      artifactCount: 6,
      referencedObjectCount: 1,
      rowCountTables: 2,
      durationMs: 0,
      heartbeatPublished: true,
    });
    // The reader is asked for exactly the physical key the document adapter writes.
    expect(reads).toEqual(['documents/workspaces/w1/docs/passport.pdf']);

    const artifactNames = [
      'roles.sql',
      'schema.sql',
      'data.sql',
      'history_schema.sql',
      'history_data.sql',
      'objects/w1/docs/passport.pdf',
    ];
    expect(puts).toEqual([
      ...artifactNames.map((name) => `${RUN_ID}/${name}.enc`),
      `${RUN_ID}/manifest.json.enc`,
      HEARTBEAT_KEY,
    ]);

    const manifest = await decryptManifest(backend, decryptor);
    expect(manifest.deployment).toBe('gt-sales');
    expect(manifest.runId).toBe(RUN_ID);
    expect(manifest.capturedAt).toBe('2026-10-29T06:17:00.000Z');
    expect(manifest.sourceIds).toEqual({ supabaseProjectRef: 'proj-abc' });
    expect(manifest.toolVersions).toEqual({ age: '1.2.1', pgDump: '17.6' });
    expect(manifest.artifacts.map((artifact) => artifact.name)).toEqual(artifactNames);
    expect(manifest.rowCounts).toEqual(countCopyRows(DATA_SQL));
    expect(manifest.rowCounts).toEqual({ 'app.leads': 3, 'app.files': 0 });
    expect(manifest.counts).toEqual({ referencedObjects: 1 });
    expect(manifest.exclusions).toEqual(BASE_EXCLUSIONS);

    // Every artifact is stored encrypted and decrypts to what the manifest describes.
    const reader = backend.asReader();
    const decrypted = new Map<string, Uint8Array>();
    for (const artifact of manifest.artifacts) {
      const ciphertext = await reader.getObject(`${RUN_ID}/${artifact.name}.enc`);
      if (!ciphertext) throw new Error(`missing ciphertext for ${artifact.name}`);
      decrypted.set(artifact.name, await decryptor.decrypt(ciphertext));
    }
    expect(verifyManifestArtifacts(manifest, decrypted)).toEqual({ ok: true });
    expect(decrypted.get('objects/w1/docs/passport.pdf')).toEqual(document);
    expect(decode(decrypted.get('data.sql') ?? new Uint8Array())).toBe(DATA_SQL);
    const storedData = await reader.getObject(`${RUN_ID}/data.sql.enc`);
    expect(decode(storedData ?? new Uint8Array())).not.toContain('Ada');

    const heartbeat = await readLatestHeartbeat(reader);
    expect(heartbeat).toEqual({
      status: 'ok',
      heartbeat: {
        schemaVersion: 1,
        deployment: 'gt-sales',
        runId: RUN_ID,
        completedAt: '2026-10-29T06:17:00.000Z',
        verified: true,
        manifestKey: `${RUN_ID}/manifest.json.enc`,
        artifactCount: 6,
      },
    });
  });

  it('omits the history artifacts the export did not produce', async () => {
    const { backend, deps, decryptor } = setup();
    const { historySchema: _schema, historyData: _data, ...withoutHistory } = dump();
    void _schema;
    void _data;
    deps.database = spyDatabase(withoutHistory).database;
    await expect(runBackup(deps)).resolves.toMatchObject({ artifactCount: 4 });
    const manifest = await decryptManifest(backend, decryptor);
    expect(manifest.artifacts.map((artifact) => artifact.name)).toEqual([
      'roles.sql',
      'schema.sql',
      'data.sql',
      'objects/w1/docs/passport.pdf',
    ]);
  });

  it('fails with backup_source_unreadable before exporting when the guard names a table', async () => {
    const { backend, deps, calls, reads } = setup();
    deps.guard = new FakeSourceCompletenessGuard(['app.new_table', 'app.other_table']);
    const error = await runBackup(deps).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BackupSourceUnreadableError);
    expect(String(error)).toContain('backup_source_unreadable:2_tables');
    if (!(error instanceof BackupSourceUnreadableError)) throw new Error('unreachable');
    expect(error.tables).toEqual(['app.new_table', 'app.other_table']);
    expect(calls.exportAll).toBe(0);
    expect(reads).toEqual([]);
    expect(backend.size()).toBe(0);
  });

  it('fails with backup_incomplete naming the missing object and publishes no heartbeat', async () => {
    const { backend, deps } = setup();
    deps.storageSource = new FakeStorageSourceReader(new Map());
    const error = await runBackup(deps).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BackupIncompleteError);
    expect(String(error)).toContain('backup_incomplete:1_objects');
    if (!(error instanceof BackupIncompleteError)) throw new Error('unreachable');
    expect(error.missingOrMismatchedObjects).toEqual(['documents/docs/passport.pdf']);
    expect(backend.size()).toBe(0);
    expect((await readLatestHeartbeat(backend.asReader())).status).toBe('missing');
  });

  it('fails with backup_incomplete on a checksum mismatch', async () => {
    const { backend, deps } = setup();
    // Same length as the real document, different bytes.
    deps.storageSource = new FakeStorageSourceReader(
      new Map([['documents/workspaces/w1/docs/passport.pdf', encode('customer-document-BYTES')]]),
    );
    const error = await runBackup(deps).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BackupIncompleteError);
    expect(String(error)).toContain('backup_incomplete:1_objects');
    expect(backend.size()).toBe(0);
    expect((await readLatestHeartbeat(backend.asReader())).status).toBe('missing');
  });

  it('fails with backup_incomplete on a size mismatch', async () => {
    const { backend, deps, document } = setup();
    deps.referencedObjects = new FakeReferencedObjectManifestSource([
      {
        workspaceId: 'w1',
        bucket: 'documents',
        objectKey: 'docs/passport.pdf',
        checksumSha256: sha256Hex(document),
        sizeBytes: document.byteLength + 1,
      },
    ]);
    await expect(runBackup(deps)).rejects.toBeInstanceOf(BackupIncompleteError);
    expect(backend.size()).toBe(0);
  });

  it('fails with backup_snapshot_too_large_for_runner before fetching any object', async () => {
    const { backend, deps, document, reads } = setup();
    // The dump plus the document are one byte over the limit.
    const limit = dumpBytes(dump()) + document.byteLength - 1;
    const error = await runBackup({ ...deps, maxSnapshotBytes: limit }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(BackupTooLargeError);
    expect(String(error)).toContain('backup_snapshot_too_large_for_runner:');
    expect(reads).toEqual([]);
    expect(backend.size()).toBe(0);
    expect((await readLatestHeartbeat(backend.asReader())).status).toBe('missing');
  });

  it('fails with backup_snapshot_too_large_for_runner when a stale size hides a larger object', async () => {
    const { backend, deps, document } = setup();
    deps.referencedObjects = new FakeReferencedObjectManifestSource([
      {
        workspaceId: 'w1',
        bucket: 'documents',
        objectKey: 'docs/passport.pdf',
        checksumSha256: sha256Hex(document),
        sizeBytes: 1,
      },
    ]);
    // The recorded size fits; the bytes actually fetched do not.
    const limit = dumpBytes(dump()) + 1;
    await expect(runBackup({ ...deps, maxSnapshotBytes: limit })).rejects.toBeInstanceOf(
      BackupTooLargeError,
    );
    expect(backend.size()).toBe(0);
  });

  it('runs normally at exactly the limit', async () => {
    const { deps, document } = setup();
    const limit = dumpBytes(dump()) + document.byteLength;
    await expect(runBackup({ ...deps, maxSnapshotBytes: limit })).resolves.toMatchObject({
      heartbeatPublished: true,
    });
  });

  it('formats the size error in MiB and defaults the limit to 2 GiB', () => {
    expect(DEFAULT_MAX_SNAPSHOT_BYTES).toBe(2 * 1024 ** 3);
    expect(new BackupTooLargeError(3 * 1024 ** 3 + 1, DEFAULT_MAX_SNAPSHOT_BYTES).message).toBe(
      'backup_snapshot_too_large_for_runner:3073MiB>2048MiB',
    );
  });

  it('refuses a run id whose prefix already holds objects', async () => {
    const { backend, deps, calls } = setup();
    const key = `${RUN_ID}/data.sql.enc`;
    await backend.asWriter().putObject(key, new Uint8Array([1]));
    await expect(runBackup(deps)).rejects.toThrow('backup_run_id_already_exists');
    expect(calls.exportAll).toBe(0);
    expect(backend.size()).toBe(1);
    expect(await backend.asReader().getObject(key)).toEqual(new Uint8Array([1]));
    expect((await readLatestHeartbeat(backend.asReader())).status).toBe('missing');
  });

  it('refuses to overwrite a completed run', async () => {
    const { backend, deps } = setup();
    await runBackup(deps);
    const before = backend.size();
    await expect(runBackup(deps)).rejects.toThrow('backup_run_id_already_exists');
    expect(backend.size()).toBe(before);
  });

  it('fails with backup_upload_incomplete when the listing lacks an uploaded key', async () => {
    const { backend, deps } = setup();
    const writer = deps.archiveWriter;
    deps.archiveWriter = {
      putObject: (key, body) => writer.putObject(key, body),
      listObjects: async (prefix) => (await writer.listObjects(prefix)).slice(0, -1),
    };
    const error = await runBackup(deps).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BackupUploadVerificationError);
    expect(String(error)).toContain('backup_upload_incomplete:1_keys');
    if (!(error instanceof BackupUploadVerificationError)) throw new Error('unreachable');
    expect(error.missingKeys).toEqual([`${RUN_ID}/manifest.json.enc`]);
    expect((await readLatestHeartbeat(backend.asReader())).status).toBe('missing');
  });

  it('records operator exclusions in the manifest', async () => {
    const { backend, deps, decryptor } = setup();
    await runBackup({ ...deps, exclusions: ['auth_data_skipped_by_operator'] });
    const manifest = await decryptManifest(backend, decryptor);
    expect(manifest.exclusions).toEqual([...BASE_EXCLUSIONS, 'auth_data_skipped_by_operator']);
  });
});
