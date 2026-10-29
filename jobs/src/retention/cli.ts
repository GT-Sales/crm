#!/usr/bin/env node
import { createErrorTrackerFromEnv, type ErrorTracker } from '@gt-sales/adapters';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { S3ArchiveRetentionAdmin } from '../archive/archive-store.js';
import { optionalEnv, requiredEnv } from '../archive/env.js';
import {
  graceSecondsFromEnv,
  retentionPolicyFromEnv,
  runRetention,
  type RetentionRunOptions,
} from './run.js';

/**
 * Entry point of the weekly retention workflow (`pnpm --filter
 * @gt-sales/jobs run retention`), one run per deployment inside its
 * `backup-retention-<deployment>` GitHub Environment (docs/ENV.md "Backups").
 * It holds the retention-admin key only: never the writer's key and never the
 * recovery private key, since it prunes from the archive listing alone. It is
 * a dry run unless `RETENTION_DRY_RUN` is exactly `false`. A manifest whose
 * age cannot be read fails the job after the rest is done, so it is seen. The
 * log is one JSON line per outcome with ids and counts only.
 */

/** The fetch, error tracker and clock, replaceable for tests. */
export interface RetentionCliIo {
  fetchImpl?: typeof fetch;
  errorTracker?: ErrorTracker;
  now?: () => Date;
}

/** One listing page or one delete; bounded well inside the workflow's time limit. */
const ARCHIVE_REQUEST_TIMEOUT_MS = 60_000;

export function buildRetentionOptions(
  env: NodeJS.ProcessEnv,
  io: Pick<RetentionCliIo, 'fetchImpl' | 'now'> = {},
): RetentionRunOptions {
  const admin = new S3ArchiveRetentionAdmin(
    {
      accessKeyId: requiredEnv('B2_ARCHIVE_RETENTION_KEY_ID', env),
      secretAccessKey: requiredEnv('B2_ARCHIVE_RETENTION_APPLICATION_KEY', env),
      endpoint: requiredEnv('B2_ARCHIVE_ENDPOINT', env),
      region: requiredEnv('B2_ARCHIVE_REGION', env),
      bucket: requiredEnv('B2_ARCHIVE_BUCKET', env),
    },
    io.fetchImpl ?? fetch,
    ARCHIVE_REQUEST_TIMEOUT_MS,
  );
  return {
    admin,
    dryRun: optionalEnv('RETENTION_DRY_RUN', env)?.toLowerCase() !== 'false',
    policy: retentionPolicyFromEnv(env),
    graceSeconds: graceSecondsFromEnv(env),
    ...(io.now ? { now: io.now } : {}),
  };
}

/** Runs retention once and returns the process exit code. */
export async function runRetentionCli(
  env: NodeJS.ProcessEnv,
  io: RetentionCliIo = {},
): Promise<number> {
  const deployment = optionalEnv('BACKUP_DEPLOYMENT', env);
  const context = deployment ? { deployment } : {};
  try {
    const report = await runRetention(buildRetentionOptions(env, io));
    const candidateRunIds = [
      ...new Set(report.candidateDeletions.map((key) => key.split('/')[0] ?? key)),
    ];
    console.info(
      JSON.stringify({
        event: 'retention_completed',
        ...context,
        dryRun: report.dryRun,
        totalRuns: report.totalRuns,
        retainedRunCount: report.retainedRunIds.length,
        candidateDeletionCount: report.candidateDeletions.length,
        deletedCount: report.deleted.length,
        unreadableManifestCount: report.unreadableManifests.length,
        abandonedRunCount: report.abandonedRunIds.length,
        pendingRunCount: report.pendingRunIds.length,
        abandonedRunIds: report.abandonedRunIds,
        pendingRunIds: report.pendingRunIds,
        candidateRunIds,
      }),
    );
    if (report.unreadableManifests.length > 0) {
      console.warn(
        JSON.stringify({
          event: 'retention_unreadable_manifests',
          ...context,
          keys: report.unreadableManifests,
        }),
      );
      throw new Error('retention_unreadable_manifests');
    }
    return 0;
  } catch (error: unknown) {
    // Messages are codes (`NAME is required`, `archive_delete_failed:<status>`);
    // no credential value ever reaches one.
    console.error(
      JSON.stringify({
        event: 'retention_failed',
        ...context,
        message: error instanceof Error ? error.message : 'non_error_thrown',
      }),
    );
    (io.errorTracker ?? createErrorTrackerFromEnv({ env })).captureException(error, {
      requestId: deployment ? `retention-${deployment}` : 'retention',
      route: 'jobs:retention',
      release: env['RELEASE_SHA'] ?? 'unknown',
      environment: env['DEPLOYMENT_ENV'] ?? env['NODE_ENV'],
    });
    return 1;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runRetentionCli(process.env);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  void main();
}
