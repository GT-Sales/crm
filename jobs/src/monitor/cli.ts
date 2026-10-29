#!/usr/bin/env node
import {
  createErrorTrackerFromEnv,
  createOwnerAlertChannelFromEnv,
  type ErrorTracker,
  type OwnerAlertChannel,
} from '@gt-sales/adapters';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { S3ArchiveReader } from '../archive/archive-store.js';
import { optionalEnv, optionalPositiveInteger, requiredEnv } from '../archive/env.js';
import {
  DEFAULT_MAX_AGE_SECONDS,
  alertDetail,
  requiresAlert,
  runMonitor,
  type MonitorOptions,
} from './run.js';

/**
 * Entry point of the hourly backup monitor workflow (`pnpm --filter
 * @gt-sales/jobs run monitor`), one run per deployment inside its
 * `backup-monitor-<deployment>` GitHub Environment (docs/ENV.md "Backups").
 * It holds the reader key only. Every outcome other than `ok` emails the
 * owner (`backup_stale`) and exits 1, so the failed workflow run notifies too;
 * a scheduled workflow's own failure mail is easy to miss, hence both. An
 * unconfigured alert channel only logs, so it never becomes a second failure.
 * The log is one JSON line per outcome with ids, times and counts only.
 */

/** The fetch, alert channel, error tracker and clock, replaceable for tests. */
export interface MonitorCliIo {
  fetchImpl?: typeof fetch;
  alerts?: OwnerAlertChannel;
  errorTracker?: ErrorTracker;
  now?: () => Date;
}

/** The heartbeat is a few hundred bytes. */
const ARCHIVE_READ_TIMEOUT_MS = 30_000;

export function buildMonitorOptions(
  env: NodeJS.ProcessEnv,
  io: Pick<MonitorCliIo, 'fetchImpl' | 'now'> = {},
): MonitorOptions {
  const deployment = requiredEnv('BACKUP_DEPLOYMENT', env);
  const reader = new S3ArchiveReader(
    {
      accessKeyId: requiredEnv('B2_ARCHIVE_READER_KEY_ID', env),
      secretAccessKey: requiredEnv('B2_ARCHIVE_READER_APPLICATION_KEY', env),
      endpoint: requiredEnv('B2_ARCHIVE_ENDPOINT', env),
      region: requiredEnv('B2_ARCHIVE_REGION', env),
      bucket: requiredEnv('B2_ARCHIVE_BUCKET', env),
    },
    io.fetchImpl ?? fetch,
    ARCHIVE_READ_TIMEOUT_MS,
  );
  return {
    reader,
    deployment,
    maxAgeSeconds:
      optionalPositiveInteger('BACKUP_MONITOR_MAX_AGE_SECONDS', env) ?? DEFAULT_MAX_AGE_SECONDS,
    ...(io.now ? { now: io.now } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'non_error_thrown';
}

/** Runs one check and returns the process exit code. */
export async function runMonitorCli(
  env: NodeJS.ProcessEnv,
  io: MonitorCliIo = {},
): Promise<number> {
  const now = io.now ?? (() => new Date());
  const deployment = optionalEnv('BACKUP_DEPLOYMENT', env);
  const context = deployment ? { deployment } : {};
  const alerts = (): OwnerAlertChannel => io.alerts ?? createOwnerAlertChannelFromEnv({ env });
  const sendAlert = async (detail: string): Promise<void> => {
    try {
      await alerts().send({ kind: 'backup_stale', detail, occurredAt: now().toISOString() });
    } catch (error: unknown) {
      console.error(
        JSON.stringify({
          event: 'monitor_alert_delivery_failed',
          ...context,
          message: errorMessage(error),
        }),
      );
    }
  };

  try {
    const options = buildMonitorOptions(env, { ...io, now });
    const status = await runMonitor(options);
    console.info(
      JSON.stringify({ event: 'monitor_status', deployment: options.deployment, ...status }),
    );
    if (!requiresAlert(status)) return 0;

    const detail = alertDetail(status);
    console.error(
      JSON.stringify({
        event: 'monitor_alert',
        deployment: options.deployment,
        status: status.status,
        detail,
      }),
    );
    await sendAlert(detail);
    return 1;
  } catch (error: unknown) {
    // Messages are codes (`NAME is required`, `archive_get_failed:<status>`);
    // no credential value ever reaches one.
    console.error(
      JSON.stringify({ event: 'monitor_failed', ...context, message: errorMessage(error) }),
    );
    (io.errorTracker ?? createErrorTrackerFromEnv({ env })).captureException(error, {
      requestId: deployment ? `monitor-${deployment}` : 'monitor',
      route: 'jobs:monitor',
      release: env['RELEASE_SHA'] ?? 'unknown',
      environment: env['DEPLOYMENT_ENV'] ?? env['NODE_ENV'],
    });
    await sendAlert('monitor_failed');
    return 1;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runMonitorCli(process.env);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  void main();
}
