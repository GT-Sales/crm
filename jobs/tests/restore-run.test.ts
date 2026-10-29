import { describe, expect, it } from 'vitest';

import {
  InMemoryArchiveBackend,
  type ArchiveReader,
  type ArchiveWriter,
} from '../src/archive/archive-store.js';
import {
  generateTestRecipientKeyPair,
  TestEnvelopeDecryptor,
  TestEnvelopeEncryptor,
  type Decryptor,
  type Encryptor,
} from '../src/archive/encryptor.js';
import { buildManifest, manifestArtifact, type BackupManifest } from '../src/archive/manifest.js';
import type { DatabaseDumpArtifacts } from '../src/backup/pg-dump.js';
import { runRestore, type RestoreDependencies, type RestoreTarget } from '../src/restore/run.js';

const RUN_ID = 'run-2026-10-29T06-17-00-000Z-test';
const CAPTURED_AT = new Date('2026-10-29T06:17:00.000Z');
const NOW = new Date('2026-10-29T09:00:00.000Z');
const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const ARTIFACTS: Record<string, string> = {
  'roles.sql': 'roles',
  'schema.sql': 'schema',
  'data.sql': 'data',
  'objects/ws-1/doc-1.pdf': '%PDF-1 one',
  'objects/ws-2/doc-2.pdf': '%PDF-1 two',
};
const ROW_COUNTS = { 'app.leads': 2, 'app.workspaces': 1 };

interface Archive {
  reader: ArchiveReader;
  writer: ArchiveWriter;
  encryptor: Encryptor;
  decryptor: Decryptor;
  manifest: BackupManifest;
}

/** A complete run in the archive, as the backup runner writes it. */
async function seedArchive(
  options: {
    artifacts?: Record<string, string>;
    skipUpload?: readonly string[];
    manifestRunId?: string;
    writeManifest?: boolean;
  } = {},
): Promise<Archive> {
  const backend = new InMemoryArchiveBackend();
  const writer = backend.asWriter();
  const { publicKeyBase64, privateKeyBase64 } = generateTestRecipientKeyPair();
  const encryptor = new TestEnvelopeEncryptor(publicKeyBase64);
  const artifacts = options.artifacts ?? ARTIFACTS;
  const manifest = buildManifest({
    deployment: 'gt-sales',
    runId: options.manifestRunId ?? RUN_ID,
    capturedAt: CAPTURED_AT,
    sourceIds: { supabaseProjectRef: 'ref' },
    toolVersions: { age: '1.2.1', pgDump: '17.6' },
    artifacts: Object.entries(artifacts).map(([name, text]) =>
      manifestArtifact(name, encode(text)),
    ),
    rowCounts: ROW_COUNTS,
    counts: { referencedObjects: 2 },
    exclusions: [],
  });
  for (const [name, text] of Object.entries(artifacts)) {
    if (options.skipUpload?.includes(name)) continue;
    await writer.putObject(`${RUN_ID}/${name}.enc`, await encryptor.encrypt(encode(text)));
  }
  if (options.writeManifest !== false) {
    await writer.putObject(
      `${RUN_ID}/manifest.json.enc`,
      await encryptor.encrypt(encode(JSON.stringify(manifest))),
    );
  }
  return {
    reader: backend.asReader(),
    writer,
    encryptor,
    decryptor: new TestEnvelopeDecryptor(privateKeyBase64),
    manifest,
  };
}

type TargetCall =
  | { method: 'preflight' }
  | { method: 'applyDatabase'; artifacts: Record<string, string> }
  | { method: 'applyObjects'; objects: Record<string, string> }
  | { method: 'countRows'; tables: string[] };

/** Records every call in order; any method can be made to throw. */
class RecordingTarget implements RestoreTarget {
  readonly calls: TargetCall[] = [];
  constructor(
    private readonly options: {
      counts?: Record<string, number>;
      fail?: Partial<Record<'preflight' | 'applyDatabase' | 'applyObjects' | 'countRows', string>>;
    } = {},
  ) {}

  private maybeFail(method: 'preflight' | 'applyDatabase' | 'applyObjects' | 'countRows'): void {
    const message = this.options.fail?.[method];
    if (message) throw new Error(message);
  }

  async preflight(): Promise<void> {
    this.calls.push({ method: 'preflight' });
    this.maybeFail('preflight');
  }

  async applyDatabase(artifacts: DatabaseDumpArtifacts): Promise<void> {
    this.calls.push({
      method: 'applyDatabase',
      artifacts: Object.fromEntries(
        Object.entries(artifacts).map(([name, bytes]) => [
          name,
          bytes instanceof Uint8Array ? decode(bytes) : '',
        ]),
      ),
    });
    this.maybeFail('applyDatabase');
  }

  async applyObjects(objects: ReadonlyMap<string, Uint8Array>): Promise<void> {
    this.calls.push({
      method: 'applyObjects',
      objects: Object.fromEntries([...objects].map(([key, bytes]) => [key, decode(bytes)])),
    });
    this.maybeFail('applyObjects');
  }

  async countRows(tables: readonly string[]): Promise<Record<string, number>> {
    this.calls.push({ method: 'countRows', tables: [...tables] });
    this.maybeFail('countRows');
    return this.options.counts ?? { ...ROW_COUNTS };
  }
}

function deps(archive: Archive, overrides: Partial<RestoreDependencies> = {}): RestoreDependencies {
  return {
    runId: RUN_ID,
    reader: archive.reader,
    decryptor: archive.decryptor,
    now: () => NOW,
    ...overrides,
  };
}

describe('runRestore', () => {
  it('verify-only: a complete archive is verified and not restored', async () => {
    const archive = await seedArchive();
    const report = await runRestore(deps(archive));
    expect(report).toEqual({
      runId: RUN_ID,
      verified: true,
      restored: false,
      manifest: archive.manifest,
      missingArtifacts: [],
      mismatchedArtifacts: [],
      rowCountMismatches: [],
      restoreDurationMs: 0,
    });
  });

  it('fails closed when the manifest object is missing', async () => {
    const archive = await seedArchive({ writeManifest: false });
    const target = new RecordingTarget();
    const report = await runRestore(deps(archive, { target }));
    expect(report).toMatchObject({
      verified: false,
      restored: false,
      failedStage: 'manifest_fetch',
      failureReason: 'manifest_object_missing',
    });
    expect(report.manifest).toBeUndefined();
    expect(target.calls).toEqual([]);
  });

  it('fails closed when the archive cannot be read', async () => {
    const archive = await seedArchive();
    const reader: ArchiveReader = {
      listObjects: archive.reader.listObjects.bind(archive.reader),
      getObject: async () => {
        throw new Error('archive_get_failed:403');
      },
    };
    const report = await runRestore(deps(archive, { reader }));
    expect(report).toMatchObject({
      verified: false,
      failedStage: 'manifest_fetch',
      failureReason: 'archive_get_failed:403',
    });
  });

  it('fails closed on a tampered manifest', async () => {
    const archive = await seedArchive();
    const ciphertext = Buffer.from(
      await archive.encryptor.encrypt(encode(JSON.stringify(archive.manifest))),
    );
    const last = ciphertext.length - 1;
    ciphertext.writeUInt8(ciphertext.readUInt8(last) ^ 0xff, last);
    await archive.writer.putObject(`${RUN_ID}/manifest.json.enc`, ciphertext);
    const target = new RecordingTarget();
    const report = await runRestore(deps(archive, { target }));
    expect(report.verified).toBe(false);
    expect(report.failedStage).toBe('manifest_decrypt');
    expect(report.failureReason).toMatch(/^decryption_failed:/);
    expect(target.calls).toEqual([]);
  });

  it('fails closed on a manifest that does not match the schema', async () => {
    const archive = await seedArchive();
    await archive.writer.putObject(
      `${RUN_ID}/manifest.json.enc`,
      await archive.encryptor.encrypt(encode(JSON.stringify({ schemaVersion: 1 }))),
    );
    const report = await runRestore(deps(archive));
    expect(report.verified).toBe(false);
    expect(report.failedStage).toBe('manifest_decrypt');
  });

  it('fails closed on a manifest that names another run', async () => {
    const archive = await seedArchive({ manifestRunId: 'run-other' });
    const report = await runRestore(deps(archive));
    expect(report).toMatchObject({
      verified: false,
      failedStage: 'manifest_decrypt',
      failureReason: 'manifest_run_id_mismatch',
    });
  });

  it('fails closed on a missing artifact, naming it', async () => {
    const archive = await seedArchive({ skipUpload: ['data.sql'] });
    const target = new RecordingTarget();
    const report = await runRestore(deps(archive, { target }));
    expect(report).toMatchObject({
      verified: false,
      restored: false,
      failedStage: 'artifact_fetch_and_decrypt',
      failureReason: 'artifact_verification_failed',
      manifest: archive.manifest,
      missingArtifacts: ['data.sql'],
      mismatchedArtifacts: [],
    });
    expect(target.calls).toEqual([]);
  });

  it('fails closed on a mismatched artifact and never calls the target', async () => {
    const archive = await seedArchive();
    await archive.writer.putObject(
      `${RUN_ID}/schema.sql.enc`,
      await archive.encryptor.encrypt(encode('schema with an extra statement')),
    );
    const target = new RecordingTarget();
    const report = await runRestore(deps(archive, { target }));
    expect(report).toMatchObject({
      verified: false,
      restored: false,
      failedStage: 'artifact_fetch_and_decrypt',
      missingArtifacts: [],
      mismatchedArtifacts: ['schema.sql'],
    });
    expect(target.calls).toEqual([]);
  });

  it('reports an artifact that does not decrypt as mismatched, not missing', async () => {
    const archive = await seedArchive();
    await archive.writer.putObject(`${RUN_ID}/objects/ws-1/doc-1.pdf.enc`, encode('not age'));
    const target = new RecordingTarget();
    const report = await runRestore(deps(archive, { target }));
    expect(report).toMatchObject({
      verified: false,
      failedStage: 'artifact_fetch_and_decrypt',
      missingArtifacts: [],
      mismatchedArtifacts: ['objects/ws-1/doc-1.pdf'],
    });
    expect(target.calls).toEqual([]);
  });

  it('stops at target_preflight when the target role cannot bypass RLS', async () => {
    const archive = await seedArchive();
    const target = new RecordingTarget({
      fail: { preflight: 'restore_target_role_cannot_bypass_rls' },
    });
    const report = await runRestore(deps(archive, { target }));
    expect(report).toMatchObject({
      verified: true,
      restored: false,
      failedStage: 'target_preflight',
      failureReason: 'restore_target_role_cannot_bypass_rls',
    });
    expect(target.calls).toEqual([{ method: 'preflight' }]);
  });

  it('restores and reports no mismatches when target counts equal the manifest', async () => {
    const archive = await seedArchive();
    const target = new RecordingTarget();
    const report = await runRestore(deps(archive, { target }));
    expect(report).toEqual({
      runId: RUN_ID,
      verified: true,
      restored: true,
      manifest: archive.manifest,
      missingArtifacts: [],
      mismatchedArtifacts: [],
      rowCountMismatches: [],
      restoreDurationMs: 0,
    });
    expect(target.calls).toEqual([
      { method: 'preflight' },
      { method: 'applyDatabase', artifacts: { roles: 'roles', schema: 'schema', data: 'data' } },
      {
        method: 'applyObjects',
        objects: { 'objects/ws-1/doc-1.pdf': '%PDF-1 one', 'objects/ws-2/doc-2.pdf': '%PDF-1 two' },
      },
      { method: 'countRows', tables: ['app.leads', 'app.workspaces'] },
    ]);
  });

  it('passes the history artifacts to the target when the run holds them', async () => {
    const archive = await seedArchive({
      artifacts: {
        ...ARTIFACTS,
        'history_schema.sql': 'history schema',
        'history_data.sql': 'history data',
      },
    });
    const target = new RecordingTarget();
    const report = await runRestore(deps(archive, { target }));
    expect(report.restored).toBe(true);
    expect(target.calls[1]).toEqual({
      method: 'applyDatabase',
      artifacts: {
        roles: 'roles',
        schema: 'schema',
        data: 'data',
        historySchema: 'history schema',
        historyData: 'history data',
      },
    });
  });

  it('fails at database_apply when the run holds no data.sql, before applying anything', async () => {
    const { 'data.sql': _omitted, ...withoutData } = ARTIFACTS;
    const archive = await seedArchive({ artifacts: withoutData });
    const target = new RecordingTarget();
    const report = await runRestore(deps(archive, { target }));
    expect(report).toMatchObject({
      verified: true,
      restored: false,
      failedStage: 'database_apply',
      failureReason: 'restore_database_artifact_missing:data.sql',
    });
    expect(target.calls).toEqual([{ method: 'preflight' }]);
  });

  it('a failed database apply stops the run before objects and counts', async () => {
    const archive = await seedArchive();
    const target = new RecordingTarget({ fail: { applyDatabase: 'psql_failed:3:boom' } });
    const report = await runRestore(deps(archive, { target }));
    expect(report).toMatchObject({
      verified: true,
      restored: false,
      failedStage: 'database_apply',
      failureReason: 'psql_failed:3:boom',
    });
    expect(target.calls.map((call) => call.method)).toEqual(['preflight', 'applyDatabase']);
  });

  it('a failed object apply stops the run before counts', async () => {
    const archive = await seedArchive();
    const target = new RecordingTarget({
      fail: { applyObjects: 'restore_storage_not_configured' },
    });
    const report = await runRestore(deps(archive, { target }));
    expect(report).toMatchObject({
      restored: false,
      failedStage: 'objects_apply',
      failureReason: 'restore_storage_not_configured',
    });
    expect(target.calls.map((call) => call.method)).toEqual([
      'preflight',
      'applyDatabase',
      'applyObjects',
    ]);
  });

  it('a failed count is a row_count_check failure', async () => {
    const archive = await seedArchive();
    const target = new RecordingTarget({ fail: { countRows: 'psql_failed:2:gone' } });
    const report = await runRestore(deps(archive, { target }));
    expect(report).toMatchObject({
      verified: true,
      restored: false,
      failedStage: 'row_count_check',
      failureReason: 'psql_failed:2:gone',
      rowCountMismatches: [],
    });
  });

  it('reports a row count mismatch and restored=false', async () => {
    const archive = await seedArchive();
    const target = new RecordingTarget({ counts: { 'app.leads': 1, 'app.workspaces': 1 } });
    const report = await runRestore(deps(archive, { target }));
    expect(report).toMatchObject({
      verified: true,
      restored: false,
      failedStage: 'row_count_check',
      failureReason: 'row_count_mismatch',
      rowCountMismatches: [{ table: 'app.leads', expected: 2, actual: 1 }],
    });
  });

  it('a table the target did not count is a mismatch with actual -1', async () => {
    const archive = await seedArchive();
    const target = new RecordingTarget({ counts: { 'app.leads': 2 } });
    const report = await runRestore(deps(archive, { target }));
    expect(report.restored).toBe(false);
    expect(report.rowCountMismatches).toEqual([
      { table: 'app.workspaces', expected: 1, actual: -1 },
    ]);
  });

  it('measures the loss window from capturedAt to incidentDetectedAt', async () => {
    const archive = await seedArchive();
    const incidentDetectedAt = new Date('2026-10-29T08:47:00.000Z');
    const verifyOnly = await runRestore(deps(archive, { incidentDetectedAt }));
    expect(verifyOnly.measuredLossWindowMs).toBe(
      incidentDetectedAt.getTime() - CAPTURED_AT.getTime(),
    );
    const restored = await runRestore(
      deps(archive, { incidentDetectedAt, target: new RecordingTarget() }),
    );
    expect(restored.restored).toBe(true);
    expect(restored.measuredLossWindowMs).toBe(2.5 * 60 * 60 * 1000);
  });

  it('measures the restore duration with the injected clock', async () => {
    const archive = await seedArchive();
    let tick = 0;
    const report = await runRestore(
      deps(archive, {
        target: new RecordingTarget(),
        now: () => new Date(NOW.getTime() + 1000 * tick++),
      }),
    );
    expect(report.restored).toBe(true);
    expect(report.restoreDurationMs).toBe(1000);
  });
});
