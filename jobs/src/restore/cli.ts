#!/usr/bin/env node
import {
  createErrorTrackerFromEnv,
  type ErrorTracker,
  type S3SigningConfig,
} from '@gt-sales/adapters';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

import { S3ArchiveReader } from '../archive/archive-store.js';
import { nodeRunCommand, type RunCommand } from '../archive/command.js';
import { AgeCliDecryptor } from '../archive/encryptor.js';
import { envFlag, optionalEnv, requiredEnv } from '../archive/env.js';
import { runRestore, type RestoreDependencies, type RestoreReport } from './run.js';
import { PsqlAndS3RestoreTarget } from './target.js';

/**
 * Entry point of an owner-run restore (`pnpm --filter @gt-sales/jobs run
 * restore`, docs/RUNBOOKS/restore.md). It runs on the owner's machine, never
 * in GitHub: it needs the recovery reader key and the recovery private key,
 * a local file supplied at restore time only (docs/ENV.md "Restore").
 * Without `TARGET_DATABASE_URL` it verifies the archive and stops; with it,
 * it loads the run into that isolated, empty project. The log is one JSON
 * line per outcome with ids, stages, table names and counts only: never the
 * key's contents, a password or a credentialed URL.
 */

/** The fetch, child-process runner, key-file check, error tracker and clock, replaceable for tests. */
export interface RestoreCliIo {
  fetchImpl?: typeof fetch;
  run?: RunCommand;
  /** Resolves when `path` is a readable file; rejects otherwise. */
  access?: (path: string) => Promise<void>;
  errorTracker?: ErrorTracker;
  now?: () => Date;
}

/** A full database dump is one GET; bounded well inside a restore session. */
const ARCHIVE_READ_TIMEOUT_MS = 15 * 60_000;

const RUN_ID = /^run-[A-Za-z0-9._-]+$/;
const TARGET_STORAGE_VARIABLES = [
  'TARGET_STORAGE_ENDPOINT',
  'TARGET_STORAGE_REGION',
  'TARGET_STORAGE_BUCKET',
  'TARGET_STORAGE_ACCESS_KEY_ID',
  'TARGET_STORAGE_SECRET_ACCESS_KEY',
] as const;
const isoDateTime = z.iso.datetime({ offset: true });

async function readableFile(path: string): Promise<void> {
  if (!(await stat(path)).isFile()) throw new Error('not_a_file');
  await access(path, constants.R_OK);
}

function targetStorage(env: NodeJS.ProcessEnv): S3SigningConfig | undefined {
  if (!TARGET_STORAGE_VARIABLES.some((name) => optionalEnv(name, env) !== undefined)) {
    return undefined;
  }
  // All five or none: name the first one missing (properties evaluate in order).
  return {
    endpoint: requiredEnv('TARGET_STORAGE_ENDPOINT', env),
    region: requiredEnv('TARGET_STORAGE_REGION', env),
    bucket: requiredEnv('TARGET_STORAGE_BUCKET', env),
    accessKeyId: requiredEnv('TARGET_STORAGE_ACCESS_KEY_ID', env),
    secretAccessKey: requiredEnv('TARGET_STORAGE_SECRET_ACCESS_KEY', env),
  };
}

function incidentDetectedAt(env: NodeJS.ProcessEnv): Date | undefined {
  const value = optionalEnv('INCIDENT_DETECTED_AT', env);
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  if (!isoDateTime.safeParse(value).success || !Number.isFinite(parsed.getTime())) {
    throw new Error('INCIDENT_DETECTED_AT must be an ISO 8601 date-time');
  }
  return parsed;
}

export async function buildRestoreDependencies(
  env: NodeJS.ProcessEnv,
  io: RestoreCliIo = {},
): Promise<RestoreDependencies> {
  const run = io.run ?? nodeRunCommand;
  const fetchImpl = io.fetchImpl ?? fetch;

  const runId = requiredEnv('RESTORE_RUN_ID', env).trim();
  if (!RUN_ID.test(runId)) throw new Error('RESTORE_RUN_ID must look like run-<id>');
  const archiveConfig = {
    accessKeyId: requiredEnv('B2_ARCHIVE_READER_KEY_ID', env),
    secretAccessKey: requiredEnv('B2_ARCHIVE_READER_APPLICATION_KEY', env),
    endpoint: requiredEnv('B2_ARCHIVE_ENDPOINT', env),
    region: requiredEnv('B2_ARCHIVE_REGION', env),
    bucket: requiredEnv('B2_ARCHIVE_BUCKET', env),
  };
  // Only the path is handled here; `age` reads the key itself.
  const identityPath = requiredEnv('RECOVERY_PRIVATE_KEY_PATH', env);
  try {
    await (io.access ?? readableFile)(identityPath);
  } catch {
    throw new Error('RECOVERY_PRIVATE_KEY_PATH is not a readable file');
  }

  const databaseUrl = optionalEnv('TARGET_DATABASE_URL', env);
  const storage = targetStorage(env);
  if (storage && !databaseUrl) {
    throw new Error('TARGET_DATABASE_URL is required when TARGET_STORAGE_* is set');
  }
  const detectedAt = incidentDetectedAt(env);

  return {
    runId,
    reader: new S3ArchiveReader(archiveConfig, fetchImpl, ARCHIVE_READ_TIMEOUT_MS),
    decryptor: new AgeCliDecryptor(identityPath, run),
    ...(databaseUrl
      ? {
          target: new PsqlAndS3RestoreTarget({
            databaseUrl,
            skipRoles: envFlag('RESTORE_SKIP_ROLES', env),
            run,
            fetchImpl,
            baseEnv: env,
            ...(storage ? { storage } : {}),
          }),
        }
      : {}),
    ...(io.now ? { now: io.now } : {}),
    ...(detectedAt ? { incidentDetectedAt: detectedAt } : {}),
  };
}

/** The report as logged: the manifest summarised, never its artifact list. */
export function restoreReportLine(
  report: RestoreReport,
  mode: 'verify_only' | 'restore',
): Record<string, unknown> {
  const { runId, manifest, ...rest } = report;
  return {
    event: 'restore_report',
    runId,
    mode,
    ...rest,
    ...(manifest
      ? {
          manifest: {
            runId: manifest.runId,
            deployment: manifest.deployment,
            capturedAt: manifest.capturedAt,
            artifactCount: manifest.artifacts.length,
            rowCountTables: Object.keys(manifest.rowCounts).length,
          },
        }
      : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'non_error_thrown';
}

/** Runs one restore and returns the process exit code. */
export async function runRestoreCli(
  env: NodeJS.ProcessEnv,
  io: RestoreCliIo = {},
): Promise<number> {
  const runId = optionalEnv('RESTORE_RUN_ID', env);
  try {
    const deps = await buildRestoreDependencies(env, io);
    const report = await runRestore(deps);
    const mode = deps.target ? 'restore' : 'verify_only';
    console.info(JSON.stringify(restoreReportLine(report, mode)));
    return report.verified && (!deps.target || report.restored) ? 0 : 1;
  } catch (error: unknown) {
    // Messages are codes (`NAME is required`, `archive_get_failed:<status>`);
    // tool stderr is already redacted by CommandFailedError.
    console.error(
      JSON.stringify({
        event: 'restore_failed',
        ...(runId ? { runId } : {}),
        errorCode: error instanceof Error ? error.name : 'unknown_error',
        message: errorMessage(error),
      }),
    );
    (io.errorTracker ?? createErrorTrackerFromEnv({ env })).captureException(error, {
      requestId: runId ?? 'restore',
      route: 'jobs:restore',
      release: env['RELEASE_SHA'] ?? 'unknown',
      environment: env['DEPLOYMENT_ENV'] ?? env['NODE_ENV'],
    });
    return 1;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runRestoreCli(process.env);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  void main();
}
