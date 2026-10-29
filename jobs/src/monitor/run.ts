import type { ArchiveReader } from '../archive/archive-store.js';
import { readLatestHeartbeat, type Heartbeat } from '../archive/heartbeat.js';

/**
 * The independent backup monitor: the hourly check that the deployment's
 * latest complete, verified backup is younger than the threshold (26 hours by
 * default, so one missed nightly run alerts before the next is due). It holds
 * the reader key only (list + read), never the writer's or the retention
 * admin's. The backup publishes its heartbeat as its very last step, after
 * every artifact and the manifest are uploaded and verified, so a stopped or
 * partial run leaves the previous heartbeat in place and its age simply grows
 * past the threshold: a crash mid-run can never look like success here. The
 * heartbeat names its deployment, so a monitor pointed at another
 * deployment's bucket alerts instead of reading that backup as fresh
 * (docs/RUNBOOKS/backup.md).
 */

export const DEFAULT_MAX_AGE_SECONDS = 26 * 60 * 60;

export type MonitorStatus =
  | { status: 'ok'; heartbeat: Heartbeat; ageSeconds: number }
  | { status: 'stale'; heartbeat: Heartbeat; ageSeconds: number; maxAgeSeconds: number }
  | { status: 'missing' }
  | { status: 'malformed' }
  | { status: 'wrong_deployment'; expected: string; actual: string };

export interface MonitorOptions {
  reader: ArchiveReader;
  /** The deployment being monitored; a heartbeat naming any other alerts. */
  deployment: string;
  now?: () => Date;
  maxAgeSeconds?: number;
}

export async function runMonitor(options: MonitorOptions): Promise<MonitorStatus> {
  const now = options.now ?? (() => new Date());
  const maxAgeSeconds = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  const result = await readLatestHeartbeat(options.reader);
  if (result.status !== 'ok') return result;

  const { heartbeat } = result;
  if (heartbeat.deployment !== options.deployment) {
    return {
      status: 'wrong_deployment',
      expected: options.deployment,
      actual: heartbeat.deployment,
    };
  }

  // A heartbeat stamped ahead of this clock reads as age zero, not negative.
  const ageSeconds = Math.max(
    0,
    (now().getTime() - new Date(heartbeat.completedAt).getTime()) / 1000,
  );
  if (ageSeconds > maxAgeSeconds) {
    return { status: 'stale', heartbeat, ageSeconds, maxAgeSeconds };
  }
  return { status: 'ok', heartbeat, ageSeconds };
}

/** True whenever the owner must be alerted: every status except `ok`. */
export function requiresAlert(status: MonitorStatus): boolean {
  return status.status !== 'ok';
}

/** The owner alert's short detail code for a status; ids and numbers only. */
export function alertDetail(status: MonitorStatus): string {
  switch (status.status) {
    case 'stale':
      return `stale:age_seconds:${Math.round(status.ageSeconds)}`;
    case 'missing':
      return 'missing';
    case 'malformed':
      return 'malformed';
    case 'wrong_deployment':
      return `wrong_deployment:${status.actual}`;
    case 'ok':
      return 'ok';
  }
}
