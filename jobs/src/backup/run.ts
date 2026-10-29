import { documentObjectKey, sha256Hex } from '@gt-sales/adapters';
import { randomUUID } from 'node:crypto';

import type { ArchiveWriter } from '../archive/archive-store.js';
import type { Encryptor } from '../archive/encryptor.js';
import { publishHeartbeat, type Heartbeat } from '../archive/heartbeat.js';
import { buildManifest, manifestArtifact, type BackupManifest } from '../archive/manifest.js';
import { countCopyRows } from './copy-rows.js';
import type { DatabaseExporter } from './pg-dump.js';
import type {
  ReferencedObjectManifestSource,
  SourceCompletenessGuard,
  StorageSourceReader,
} from './sources.js';

/**
 * The nightly backup of one deployment: prove the dump role can read every
 * table, dump the database as `backup_reader`, copy every document the
 * database references from the deployment's Storage bucket (checksum and size
 * verified), encrypt each artifact and then the manifest, upload them under
 * `<runId>/` in the deployment's own archive bucket, verify the upload by
 * listing it, and only then publish the heartbeat the monitor watches. Any
 * failure stops the run before the heartbeat, so a broken backup is silence
 * the monitor alerts on, never a false success (docs/RUNBOOKS/backup.md).
 */

export class BackupSourceUnreadableError extends Error {
  constructor(readonly tables: readonly string[]) {
    super(`backup_source_unreadable:${tables.length}_tables`);
    this.name = 'BackupSourceUnreadableError';
  }
}

export class BackupIncompleteError extends Error {
  constructor(readonly missingOrMismatchedObjects: readonly string[]) {
    super(`backup_incomplete:${missingOrMismatchedObjects.length}_objects`);
    this.name = 'BackupIncompleteError';
  }
}

export class BackupUploadVerificationError extends Error {
  constructor(readonly missingKeys: readonly string[]) {
    super(`backup_upload_incomplete:${missingKeys.length}_keys`);
    this.name = 'BackupUploadVerificationError';
  }
}

/**
 * The runner holds the whole snapshot, plus each artifact's ciphertext, in
 * memory. Above this size it stops with a clear error before copying any
 * document instead of running out of memory part-way. A streaming runner
 * replaces this guard when the data nears it.
 */
export const DEFAULT_MAX_SNAPSHOT_BYTES = 2 * 1024 ** 3;

export class BackupTooLargeError extends Error {
  constructor(
    readonly snapshotBytes: number,
    readonly maxSnapshotBytes: number,
  ) {
    super(
      `backup_snapshot_too_large_for_runner:${Math.ceil(snapshotBytes / 1024 ** 2)}MiB>${Math.floor(maxSnapshotBytes / 1024 ** 2)}MiB`,
    );
    this.name = 'BackupTooLargeError';
  }
}

/** Always recorded: what a restore from this archive does not bring back. */
const BASE_EXCLUSIONS = [
  'storage_objects_metadata',
  'supabase_project_settings',
  'jwt_and_api_keys',
  'database_and_role_passwords',
  'smtp_oauth_secrets',
  'provider_account_mfa',
] as const;

export interface BackupRunDependencies {
  /** Whose database this is; recorded in the manifest and the heartbeat. */
  deployment: string;
  runId: string;
  now?: () => Date;
  encryptor: Encryptor;
  archiveWriter: ArchiveWriter;
  database: DatabaseExporter;
  referencedObjects: ReferencedObjectManifestSource;
  storageSource: StorageSourceReader;
  guard: SourceCompletenessGuard;
  sourceIds: Record<string, string>;
  toolVersions: Record<string, string>;
  /** Operator-chosen omissions (for example `auth_data_skipped_by_operator`). */
  exclusions?: string[];
  /** Largest snapshot this runner may hold in memory; default 2 GiB. */
  maxSnapshotBytes?: number;
}

export interface BackupRunSummary {
  runId: string;
  manifestKey: string;
  artifactCount: number;
  referencedObjectCount: number;
  rowCountTables: number;
  durationMs: number;
  heartbeatPublished: true;
}

function runPrefix(runId: string): string {
  return `${runId}/`;
}

/** Each attempt is its own restore point, including a retry on the same day. */
export function createBackupRunId(now: Date): string {
  return `run-${now.toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
}

export async function runBackup(deps: BackupRunDependencies): Promise<BackupRunSummary> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const prefix = runPrefix(deps.runId);

  // 1. Prove the dump role reads every table in full. Under
  // --enable-row-security a table it cannot read dumps silently empty, and
  // the dump's own row counts would agree; nothing is exported or uploaded.
  const unreadable = await deps.guard.unreadableTables();
  if (unreadable.length > 0) throw new BackupSourceUnreadableError(unreadable);

  // 2. Never write into any part of an earlier attempt, complete or not.
  if ((await deps.archiveWriter.listObjects(prefix)).length > 0) {
    throw new Error('backup_run_id_already_exists');
  }

  // 3–4. The export, and the row count of every table it holds.
  const db = await deps.database.exportAll();
  const rowCounts = countCopyRows(new TextDecoder().decode(db.data));

  // 5. Every document object a file row or retained revision points at.
  const referenced = await deps.referencedObjects.listReferencedObjects();

  // 6. Stop before fetching anything if the snapshot cannot fit in memory.
  const maxSnapshotBytes = deps.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES;
  const databaseBytes = [db.roles, db.schema, db.data, db.historySchema, db.historyData].reduce(
    (total, bytes) => total + (bytes?.byteLength ?? 0),
    0,
  );
  const declaredBytes =
    databaseBytes + referenced.reduce((total, object) => total + object.sizeBytes, 0);
  if (declaredBytes > maxSnapshotBytes) {
    throw new BackupTooLargeError(declaredBytes, maxSnapshotBytes);
  }

  // 7. Copy every referenced object. A snapshot is usable only when every one
  // is present with the recorded checksum and size; never accept a partial
  // copy. The running total uses the bytes actually fetched, so a stale
  // recorded size cannot carry the runner past its memory limit.
  const objectArtifacts = new Map<string, Uint8Array>();
  const problems: string[] = [];
  let heldBytes = databaseBytes;
  for (const object of referenced) {
    const bytes = await deps.storageSource.getObject(
      object.bucket,
      documentObjectKey(object.workspaceId, object.objectKey),
    );
    const label = `${object.bucket}/${object.objectKey}`;
    if (!bytes) {
      problems.push(label);
      continue;
    }
    heldBytes += bytes.byteLength;
    if (heldBytes > maxSnapshotBytes) throw new BackupTooLargeError(heldBytes, maxSnapshotBytes);
    if (bytes.byteLength !== object.sizeBytes || sha256Hex(bytes) !== object.checksumSha256) {
      problems.push(label);
      continue;
    }
    objectArtifacts.set(`objects/${object.workspaceId}/${object.objectKey}`, bytes);
  }
  if (problems.length > 0) throw new BackupIncompleteError(problems);

  // 8. The artifact set.
  const artifacts = new Map<string, Uint8Array>([
    ['roles.sql', db.roles],
    ['schema.sql', db.schema],
    ['data.sql', db.data],
    ...(db.historySchema ? ([['history_schema.sql', db.historySchema]] as const) : []),
    ...(db.historyData ? ([['history_data.sql', db.historyData]] as const) : []),
    ...objectArtifacts,
  ]);

  // 9. The manifest.
  const manifest: BackupManifest = buildManifest({
    deployment: deps.deployment,
    runId: deps.runId,
    capturedAt: startedAt,
    sourceIds: deps.sourceIds,
    toolVersions: deps.toolVersions,
    artifacts: [...artifacts.entries()].map(([name, bytes]) => manifestArtifact(name, bytes)),
    rowCounts,
    counts: { referencedObjects: referenced.length },
    exclusions: [...BASE_EXCLUSIONS, ...(deps.exclusions ?? [])],
  });

  // 10. Encrypt and upload every artifact, then the manifest last: a listing
  // that shows the manifest shows a run whose payloads were all written.
  const expectedKeys: string[] = [];
  for (const [name, bytes] of artifacts) {
    const key = `${prefix}${name}.enc`;
    await deps.archiveWriter.putObject(key, await deps.encryptor.encrypt(bytes));
    expectedKeys.push(key);
  }
  const manifestKey = `${prefix}manifest.json.enc`;
  await deps.archiveWriter.putObject(
    manifestKey,
    await deps.encryptor.encrypt(new TextEncoder().encode(JSON.stringify(manifest))),
  );
  expectedKeys.push(manifestKey);

  // 11. Verify the upload (the writer can list, never read or delete).
  const uploaded = new Set((await deps.archiveWriter.listObjects(prefix)).map((o) => o.key));
  const missingKeys = expectedKeys.filter((key) => !uploaded.has(key));
  if (missingKeys.length > 0) throw new BackupUploadVerificationError(missingKeys);

  // 12. The heartbeat, only after everything above succeeded.
  const completedAt = now();
  const heartbeat: Heartbeat = {
    schemaVersion: 1,
    deployment: deps.deployment,
    runId: deps.runId,
    completedAt: completedAt.toISOString(),
    verified: true,
    manifestKey,
    artifactCount: artifacts.size,
  };
  await publishHeartbeat(deps.archiveWriter, heartbeat);

  return {
    runId: deps.runId,
    manifestKey,
    artifactCount: artifacts.size,
    referencedObjectCount: referenced.length,
    rowCountTables: Object.keys(rowCounts).length,
    durationMs: completedAt.getTime() - startedAt.getTime(),
    heartbeatPublished: true,
  };
}
