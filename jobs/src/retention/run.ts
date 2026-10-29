import type { ArchiveRetentionAdmin } from '../archive/archive-store.js';
import { optionalPositiveInteger } from '../archive/env.js';
import { HEARTBEAT_KEY } from '../archive/heartbeat.js';
import { defaultRetentionPolicy, selectRetainedRunIds, type RetentionPolicy } from './select.js';

/**
 * The weekly retention job: prunes restore points the policy no longer keeps
 * and attempts that never completed. It holds the retention-admin key (list,
 * read and delete) in its own `backup-retention-<deployment>` environment,
 * never the daily writer's key, and the backup cannot invoke it. It works from
 * the archive listing alone: every artifact lives under its run's prefix and
 * the backup uploads the manifest last, so it never decrypts anything and
 * never holds the recovery private key. Only objects past the grace period
 * are ever deleted, and it starts in dry-run (docs/RUNBOOKS/backup.md).
 */

export const DEFAULT_GRACE_SECONDS = 24 * 60 * 60;

export interface RetentionRunOptions {
  admin: ArchiveRetentionAdmin;
  now?: () => Date;
  policy?: RetentionPolicy;
  /** Only objects at least this old (by their run's captured time) are ever deleted. */
  graceSeconds?: number;
  dryRun: boolean;
}

export interface RetentionRunReport {
  totalRuns: number;
  unreadableManifests: string[];
  /** Attempts with no manifest, older than the grace period: deleted as abandoned. */
  abandonedRunIds: string[];
  /** Attempts with no manifest yet, still inside the grace period: kept for now. */
  pendingRunIds: string[];
  retainedRunIds: string[];
  candidateDeletions: string[];
  deleted: string[];
  dryRun: boolean;
}

/** `RETENTION_DAILY_POINTS` and `RETENTION_MONTHLY_POINTS`, positive whole numbers. */
export function retentionPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): RetentionPolicy {
  return {
    dailyPoints:
      optionalPositiveInteger('RETENTION_DAILY_POINTS', env) ?? defaultRetentionPolicy.dailyPoints,
    monthlyPoints:
      optionalPositiveInteger('RETENTION_MONTHLY_POINTS', env) ??
      defaultRetentionPolicy.monthlyPoints,
  };
}

/** `RETENTION_GRACE_SECONDS`, a positive whole number; 24 hours by default. */
export function graceSecondsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return optionalPositiveInteger('RETENTION_GRACE_SECONDS', env) ?? DEFAULT_GRACE_SECONDS;
}

interface RunInfo {
  runId: string;
  capturedAt: Date;
  objectKeys: Set<string>;
}

function extractRunId(key: string): string | undefined {
  const [first, ...rest] = key.split('/');
  if (!first || first === 'heartbeat' || rest.length === 0) return undefined;
  return first;
}

export async function runRetention(options: RetentionRunOptions): Promise<RetentionRunReport> {
  const now = options.now ?? (() => new Date());
  const policy = options.policy ?? defaultRetentionPolicy;
  const graceMs = (options.graceSeconds ?? DEFAULT_GRACE_SECONDS) * 1000;

  const allObjects = await options.admin.listObjects('');
  const runIds = new Set<string>();
  // Newest upload time per run; undefined when any object's time is unknown.
  const lastUploadByRunId = new Map<string, number | undefined>();
  for (const object of allObjects) {
    const runId = extractRunId(object.key);
    if (!runId) continue;
    runIds.add(runId);
    const previous = lastUploadByRunId.has(runId) ? lastUploadByRunId.get(runId) : 0;
    const uploaded = object.lastModified?.getTime();
    lastUploadByRunId.set(
      runId,
      previous === undefined || uploaded === undefined ? undefined : Math.max(previous, uploaded),
    );
  }
  const cutoff = now().getTime() - graceMs;

  const runs: RunInfo[] = [];
  const unreadableManifests: string[] = [];
  const abandonedRunIds: string[] = [];
  const pendingRunIds: string[] = [];
  for (const runId of runIds) {
    const manifestKey = `${runId}/manifest.json.enc`;
    const manifestObject = allObjects.find((object) => object.key === manifestKey);
    if (!manifestObject) {
      // The backup writes its manifest last, so a run without one is an
      // attempt that failed part-way (or is still uploading). Every attempt
      // has its own run id and is never resumed, so once its newest object
      // is past the grace period nothing can complete it: delete it. An
      // unknown upload time cannot prove that, so it fails visibly instead.
      const lastUpload = lastUploadByRunId.get(runId);
      if (lastUpload === undefined) unreadableManifests.push(manifestKey);
      else if (lastUpload < cutoff) abandonedRunIds.push(runId);
      else pendingRunIds.push(runId);
      continue;
    }
    // A run with a manifest is a restore point, even one whose backup stopped
    // at the listing check that follows the upload: the restore verifies
    // every artifact against the manifest's hashes. The manifest is written
    // last, so its upload time is the run's capture time for the policy, and
    // every object under the run prefix belongs to that run. A manifest
    // without a known upload time cannot be aged, so it fails visibly (and is
    // retained) instead of being deleted.
    if (manifestObject.lastModified === undefined) {
      unreadableManifests.push(manifestKey);
      continue;
    }
    const objectKeys = new Set<string>(
      allObjects.map((object) => object.key).filter((key) => key.startsWith(`${runId}/`)),
    );
    runs.push({ runId, capturedAt: manifestObject.lastModified, objectKeys });
  }

  const retainedRunIds = selectRetainedRunIds(
    runs.map((run) => ({ runId: run.runId, capturedAt: run.capturedAt })),
    policy,
  );
  // A run whose age could not be read cannot be proven safe to delete, so it
  // is retained until it can be. Pending attempts may still be uploading.
  for (const manifestKey of unreadableManifests) {
    const runId = extractRunId(manifestKey);
    if (runId) retainedRunIds.add(runId);
  }
  for (const runId of pendingRunIds) retainedRunIds.add(runId);
  const abandoned = new Set(abandonedRunIds);

  // The heartbeat is never a deletion candidate, whatever run it names.
  const retainedObjectKeys = new Set<string>([HEARTBEAT_KEY]);
  const runById = new Map(runs.map((run) => [run.runId, run]));
  for (const runId of retainedRunIds) {
    const run = runById.get(runId);
    if (run) for (const key of run.objectKeys) retainedObjectKeys.add(key);
  }

  const capturedAtByRunId = new Map(runs.map((run) => [run.runId, run.capturedAt.getTime()]));
  const candidateDeletions = allObjects
    .map((object) => object.key)
    .filter((key) => {
      if (retainedObjectKeys.has(key)) return false;
      const runId = extractRunId(key);
      if (!runId) return false;
      if (abandoned.has(runId)) return true;
      // Unknown run age is already retained above, so reaching here means
      // the run's age is known; enforce the grace period.
      const capturedAt = capturedAtByRunId.get(runId);
      return capturedAt === undefined ? false : capturedAt < cutoff;
    });

  const deleted: string[] = [];
  if (!options.dryRun) {
    for (const key of candidateDeletions) {
      await options.admin.deleteObject(key);
      deleted.push(key);
    }
  }

  return {
    totalRuns: runIds.size,
    unreadableManifests,
    abandonedRunIds,
    pendingRunIds,
    retainedRunIds: [...retainedRunIds],
    candidateDeletions,
    deleted,
    dryRun: options.dryRun,
  };
}
