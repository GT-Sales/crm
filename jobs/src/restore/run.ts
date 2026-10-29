import type { ArchiveReader } from '../archive/archive-store.js';
import type { Decryptor } from '../archive/encryptor.js';
import {
  backupManifestSchema,
  verifyManifestArtifacts,
  type BackupManifest,
} from '../archive/manifest.js';
import type { DatabaseDumpArtifacts } from '../backup/pg-dump.js';

/**
 * Restore of one backup run (docs/RUNBOOKS/restore.md). It trusts nothing it
 * cannot match against the run's encrypted manifest: the manifest is fetched
 * and decrypted, then every artifact it names, and each must decrypt and match
 * the recorded size and SHA-256 before anything touches a target. Without a
 * target the run stops there, a verification drill that proves the archive is
 * usable. With one it checks that the target is safe to load (its role
 * bypasses RLS, so the data load sees every row; it holds no `app` or
 * `drizzle` schema yet), loads the database, uploads the documents again and
 * compares the restored row count of every dumped table with the manifest.
 *
 * Every stage either produces evidence or the run fails closed: a thrown error
 * becomes `failedStage` + `failureReason` and no later stage runs, so a
 * stopped or partial restore is never reported as restored. It measures the
 * loss window and the duration; it guarantees neither.
 */

/** Where a verified run is loaded: an isolated, empty project. */
export interface RestoreTarget {
  /** Throws `restore_target_role_cannot_bypass_rls` or `restore_target_not_empty`. */
  preflight(): Promise<void>;
  applyDatabase(artifacts: DatabaseDumpArtifacts): Promise<void>;
  /** Keys are archive names, `objects/<ws>/<key>`; stored at `workspaces/<ws>/<key>`. */
  applyObjects(objects: ReadonlyMap<string, Uint8Array>): Promise<void>;
  /** The row count of each `schema.table`; a table the target lacks counts as -1. */
  countRows(tables: readonly string[]): Promise<Record<string, number>>;
}

export interface RestoreDependencies {
  runId: string;
  reader: ArchiveReader;
  decryptor: Decryptor;
  /** Absent: verify the archive only. */
  target?: RestoreTarget;
  now?: () => Date;
  /** When the incident was detected, to measure (never guarantee) the loss window. */
  incidentDetectedAt?: Date;
}

export type RestoreStage =
  | 'manifest_fetch'
  | 'manifest_decrypt'
  | 'artifact_fetch_and_decrypt'
  | 'target_preflight'
  | 'database_apply'
  | 'objects_apply'
  | 'row_count_check';

export interface RowCountMismatch {
  table: string;
  expected: number;
  actual: number;
}

export interface RestoreReport {
  runId: string;
  /** Every artifact the manifest names decrypted and matched it. */
  verified: boolean;
  /** Every target stage passed and every row count matched. */
  restored: boolean;
  failedStage?: RestoreStage;
  failureReason?: string;
  manifest?: BackupManifest;
  missingArtifacts: string[];
  mismatchedArtifacts: string[];
  rowCountMismatches: RowCountMismatch[];
  measuredLossWindowMs?: number;
  restoreDurationMs: number;
}

const OBJECT_PREFIX = 'objects/';

class StageFailedError extends Error {
  constructor(
    readonly stage: RestoreStage,
    reason: string,
  ) {
    super(reason);
    this.name = 'StageFailedError';
  }
}

async function inStage<T>(stage: RestoreStage, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error: unknown) {
    if (error instanceof StageFailedError) throw error;
    throw new StageFailedError(stage, error instanceof Error ? error.message : 'non_error_thrown');
  }
}

function requiredArtifact(decrypted: ReadonlyMap<string, Uint8Array>, name: string): Uint8Array {
  const bytes = decrypted.get(name);
  if (!bytes) throw new Error(`restore_database_artifact_missing:${name}`);
  return bytes;
}

function databaseArtifacts(decrypted: ReadonlyMap<string, Uint8Array>): DatabaseDumpArtifacts {
  const historySchema = decrypted.get('history_schema.sql');
  const historyData = decrypted.get('history_data.sql');
  return {
    roles: requiredArtifact(decrypted, 'roles.sql'),
    schema: requiredArtifact(decrypted, 'schema.sql'),
    data: requiredArtifact(decrypted, 'data.sql'),
    ...(historySchema ? { historySchema } : {}),
    ...(historyData ? { historyData } : {}),
  };
}

function rowCountMismatches(
  expected: Record<string, number>,
  actual: Record<string, number>,
): RowCountMismatch[] {
  return Object.entries(expected).flatMap(([table, count]) => {
    const restored = Object.hasOwn(actual, table) ? actual[table] : undefined;
    const value = typeof restored === 'number' ? restored : -1;
    return value === count ? [] : [{ table, expected: count, actual: value }];
  });
}

export async function runRestore(deps: RestoreDependencies): Promise<RestoreReport> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const prefix = `${deps.runId}/`;
  const report: Omit<RestoreReport, 'restoreDurationMs'> = {
    runId: deps.runId,
    verified: false,
    restored: false,
    missingArtifacts: [],
    mismatchedArtifacts: [],
    rowCountMismatches: [],
  };
  const finish = (): RestoreReport => ({
    ...report,
    restoreDurationMs: now().getTime() - startedAt.getTime(),
  });

  try {
    // 1. The manifest. Missing, undecryptable, malformed or naming another
    // run: nothing it lists can be trusted.
    const manifestCiphertext = await inStage('manifest_fetch', async () => {
      const bytes = await deps.reader.getObject(`${prefix}manifest.json.enc`);
      if (!bytes) throw new Error('manifest_object_missing');
      return bytes;
    });
    const manifest = await inStage('manifest_decrypt', async () => {
      const plaintext = await deps.decryptor.decrypt(manifestCiphertext);
      const parsed = backupManifestSchema.parse(JSON.parse(new TextDecoder().decode(plaintext)));
      if (parsed.runId !== deps.runId) throw new Error('manifest_run_id_mismatch');
      return parsed;
    });
    report.manifest = manifest;
    if (deps.incidentDetectedAt) {
      report.measuredLossWindowMs =
        deps.incidentDetectedAt.getTime() - new Date(manifest.capturedAt).getTime();
    }

    // 2. Every artifact, decrypted and matched. Never partial-accept: an
    // absent one is missing, one that does not decrypt or match is
    // mismatched, and either stops the run before any target is touched.
    const decrypted = await inStage('artifact_fetch_and_decrypt', async () => {
      const plaintexts = new Map<string, Uint8Array>();
      const undecryptable = new Set<string>();
      for (const artifact of manifest.artifacts) {
        const ciphertext = await deps.reader.getObject(`${prefix}${artifact.name}.enc`);
        if (!ciphertext) continue;
        try {
          plaintexts.set(artifact.name, await deps.decryptor.decrypt(ciphertext));
        } catch {
          undecryptable.add(artifact.name);
        }
      }
      const verification = verifyManifestArtifacts(manifest, plaintexts);
      if (verification.ok === false) {
        const mismatched = new Set([...verification.mismatched, ...undecryptable]);
        report.missingArtifacts = verification.missing.filter((name) => !undecryptable.has(name));
        report.mismatchedArtifacts = manifest.artifacts
          .map((artifact) => artifact.name)
          .filter((name) => mismatched.has(name));
        throw new Error('artifact_verification_failed');
      }
      return plaintexts;
    });
    report.verified = true;

    const target = deps.target;
    if (!target) return finish();

    // 3. Only an RLS-bypassing role on an empty target may load the dump.
    await inStage('target_preflight', () => target.preflight());

    // 4. The database: roles, schema, data, then the migration history.
    await inStage('database_apply', () => target.applyDatabase(databaseArtifacts(decrypted)));

    // 5. The documents, under their storage keys again.
    await inStage('objects_apply', () =>
      target.applyObjects(
        new Map([...decrypted].filter(([name]) => name.startsWith(OBJECT_PREFIX))),
      ),
    );

    // 6. The restored row count of every dumped table, exactly.
    const counts = await inStage('row_count_check', () =>
      target.countRows(Object.keys(manifest.rowCounts)),
    );
    report.rowCountMismatches = rowCountMismatches(manifest.rowCounts, counts);
    if (report.rowCountMismatches.length > 0) {
      throw new StageFailedError('row_count_check', 'row_count_mismatch');
    }

    report.restored = true;
    return finish();
  } catch (error: unknown) {
    if (!(error instanceof StageFailedError)) throw error;
    report.failedStage = error.stage;
    report.failureReason = error.message;
    return finish();
  }
}
