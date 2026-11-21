#!/usr/bin/env node
import {
  createErrorTrackerFromEnv,
  createOwnerAlertChannelFromEnv,
  type OwnerAlertChannel,
} from '@gt-sales/adapters';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { S3ArchiveWriter } from '../archive/archive-store.js';
import { nodeRunCommand, type RunCommand } from '../archive/command.js';
import { AgeCliEncryptor } from '../archive/encryptor.js';
import { optionalEnv, optionalPositiveInteger, requiredEnv } from '../archive/env.js';
import { AUTH_TABLES, PgDumpDatabaseExporter } from './pg-dump.js';
import {
  BackupIncompleteError,
  BackupSourceUnreadableError,
  BackupUploadVerificationError,
  createBackupRunId,
  runBackup,
  type BackupRunDependencies,
  type BackupRunSummary,
} from './run.js';
import { PsqlSourceCompletenessGuard, S3StorageSourceReader } from './sources.js';

/**
 * Entry point of the daily backup workflow (`pnpm --filter @gt-sales/jobs run
 * backup`), one run per deployment. Every credential arrives as a secret of
 * that deployment's `backup-<deployment>` GitHub Environment (docs/ENV.md
 * "Backups"); nothing is hardcoded and no value is ever logged. The log is
 * one JSON line per outcome with ids and counts only.
 */

/** The child-process runner and fetch, replaceable so the wiring is testable. */
export interface BackupCliIo {
  run?: RunCommand;
  fetchImpl?: typeof fetch;
}

/** A full database dump is one PUT; bounded well inside the workflow's time limit. */
const ARCHIVE_WRITE_TIMEOUT_MS = 15 * 60_000;
const STORAGE_READ_TIMEOUT_MS = 10 * 60_000;

function includeOrSkip(name: string, env: NodeJS.ProcessEnv): 'include' | 'skip' {
  const value = optionalEnv(name, env) ?? 'include';
  if (value !== 'include' && value !== 'skip') {
    throw new Error(`${name} must be include or skip`);
  }
  return value;
}

export function buildBackupDependencies(
  env: NodeJS.ProcessEnv,
  now: Date,
  io: BackupCliIo = {},
): BackupRunDependencies {
  const run = io.run ?? nodeRunCommand;
  const fetchImpl = io.fetchImpl ?? fetch;

  const deployment = requiredEnv('BACKUP_DEPLOYMENT', env);
  const sourceDatabaseUrl = requiredEnv('SOURCE_DATABASE_URL', env);
  const storageConfig = {
    endpoint: requiredEnv('SOURCE_STORAGE_ENDPOINT', env),
    region: requiredEnv('SOURCE_STORAGE_REGION', env),
    bucket: requiredEnv('SOURCE_STORAGE_BUCKET', env),
    accessKeyId: requiredEnv('SOURCE_STORAGE_ACCESS_KEY_ID', env),
    secretAccessKey: requiredEnv('SOURCE_STORAGE_SECRET_ACCESS_KEY', env),
  };
  const supabaseProjectRef = requiredEnv('SUPABASE_PROJECT_REF', env);
  const ageRecipient = requiredEnv('RECOVERY_AGE_RECIPIENT', env);
  const archiveConfig = {
    endpoint: requiredEnv('B2_ARCHIVE_ENDPOINT', env),
    region: requiredEnv('B2_ARCHIVE_REGION', env),
    bucket: requiredEnv('B2_ARCHIVE_BUCKET', env),
    accessKeyId: requiredEnv('B2_ARCHIVE_WRITER_KEY_ID', env),
    secretAccessKey: requiredEnv('B2_ARCHIVE_WRITER_APPLICATION_KEY', env),
  };

  const authData = includeOrSkip('BACKUP_AUTH_DATA', env);
  const history = includeOrSkip('BACKUP_HISTORY', env);
  const maxSnapshotBytes = optionalPositiveInteger('BACKUP_MAX_SNAPSHOT_BYTES', env);
  const exclusions = [
    ...(authData === 'skip' ? ['auth_data_skipped_by_operator'] : []),
    ...(history === 'skip' ? ['supabase_migrations_skipped_by_operator'] : []),
  ];

  return {
    deployment,
    runId: optionalEnv('BACKUP_RUN_ID', env) ?? createBackupRunId(now),
    encryptor: new AgeCliEncryptor(ageRecipient, run),
    archiveWriter: new S3ArchiveWriter(archiveConfig, fetchImpl, ARCHIVE_WRITE_TIMEOUT_MS),
    database: new PgDumpDatabaseExporter(sourceDatabaseUrl, run, { authData, history }, env),
    storageSource: new S3StorageSourceReader(storageConfig, fetchImpl, STORAGE_READ_TIMEOUT_MS),
    // An auth table that would dump silently empty under row security fails
    // the run like an app table, whenever auth data is part of the dump. Only
    // the two dumped auth tables are checked; the rest of auth is never read.
    guard: new PsqlSourceCompletenessGuard(sourceDatabaseUrl, run, {
      tables: authData === 'include' ? AUTH_TABLES : [],
    }),
    sourceIds: { supabaseProjectRef },
    // Recorded by the workflow from the installed binaries.
    toolVersions: {
      age: optionalEnv('AGE_VERSION', env) ?? 'unknown',
      pgDump: optionalEnv('PG_DUMP_VERSION', env) ?? 'unknown',
    },
    exclusions,
    ...(maxSnapshotBytes === undefined ? {} : { maxSnapshotBytes }),
  };
}

/**
 * The `backup_failed` log line. Messages are codes and counts; tool stderr is
 * already redacted by CommandFailedError. Besides the message, only names
 * are logged: the unreadable tables' (table names are not personal data),
 * and the archive and document object keys a run could not copy or verify.
 * Those keys are opaque server-generated ids (`<bucket>/candidate/<workspace
 * uuid>/<random token>`, `<runId>/<artifact>.enc`; apps/backend/src/documents/
 * keys.ts), never a filename and no personal data, which is the only reason
 * they may appear in a public workflow log.
 */
export function backupFailedLogLine(
  error: unknown,
  ids: { deployment?: string | undefined; runId?: string | undefined } = {},
): Record<string, unknown> {
  return {
    event: 'backup_failed',
    ...(ids.deployment ? { deployment: ids.deployment } : {}),
    ...(ids.runId ? { runId: ids.runId } : {}),
    errorCode: error instanceof Error ? error.name : 'unknown_error',
    message: error instanceof Error ? error.message : 'non_error_thrown',
    ...(error instanceof BackupSourceUnreadableError ? { tables: error.tables } : {}),
    ...(error instanceof BackupIncompleteError
      ? { missingOrMismatchedObjects: error.missingOrMismatchedObjects }
      : {}),
    ...(error instanceof BackupUploadVerificationError ? { missingKeys: error.missingKeys } : {}),
  };
}

/**
 * The `backup_completed` log line: ids and counts, and the missing documents'
 * opaque labels when the run had to complete without some (#86).
 */
export function backupCompletedLogLine(
  deployment: string,
  summary: BackupRunSummary,
): Record<string, unknown> {
  return {
    event: 'backup_completed',
    deployment,
    runId: summary.runId,
    artifactCount: summary.artifactCount,
    referencedObjectCount: summary.referencedObjectCount,
    purgedObjectCount: summary.purgedObjectCount,
    missingObjectCount: summary.missingObjectCount,
    ...(summary.missingObjectCount > 0 ? { missingObjects: summary.missingObjects } : {}),
    rowCountTables: summary.rowCountTables,
    durationMs: summary.durationMs,
  };
}

/**
 * A run that completed without some documents warns the owner once, through
 * the monitor's alert channel (`backup_objects_missing`), with the count and
 * the labels it can show. The alert is best effort: the backup itself has
 * succeeded and its heartbeat is published, so a failed alert is only logged.
 */
export async function alertMissingObjects(
  deployment: string,
  summary: BackupRunSummary,
  channel: () => OwnerAlertChannel,
  now: Date,
): Promise<void> {
  if (summary.missingObjectCount === 0) return;
  try {
    await channel().send({
      kind: 'backup_objects_missing',
      detail: `${deployment}:${summary.runId}:missing_objects:${summary.missingObjectCount}:${summary.missingObjects.join(',')}`,
      occurredAt: now.toISOString(),
    });
  } catch (error: unknown) {
    console.error(
      JSON.stringify({
        event: 'backup_alert_delivery_failed',
        deployment,
        runId: summary.runId,
        message: error instanceof Error ? error.message : 'non_error_thrown',
      }),
    );
  }
}

async function main(): Promise<void> {
  const deployment = optionalEnv('BACKUP_DEPLOYMENT');
  let runId = optionalEnv('BACKUP_RUN_ID');
  try {
    const deps = buildBackupDependencies(process.env, new Date());
    runId = deps.runId;
    const summary = await runBackup(deps);
    const line = JSON.stringify(backupCompletedLogLine(deps.deployment, summary));
    if (summary.missingObjectCount > 0) console.warn(line);
    else console.info(line);
    await alertMissingObjects(
      deps.deployment,
      summary,
      () => createOwnerAlertChannelFromEnv({ env: process.env }),
      new Date(),
    );
  } catch (error: unknown) {
    console.error(JSON.stringify(backupFailedLogLine(error, { deployment, runId })));
    createErrorTrackerFromEnv().captureException(error, {
      requestId: runId ?? 'backup',
      route: 'jobs:backup',
      release: process.env['RELEASE_SHA'] ?? 'unknown',
      environment: process.env['DEPLOYMENT_ENV'] ?? process.env['NODE_ENV'],
    });
    process.exitCode = 1;
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  void main();
}
