import { FakeErrorTracker, FakeOwnerAlertChannel, type OwnerAlert } from '@gt-sales/adapters';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InMemoryArchiveBackend, S3ArchiveReader } from '../src/archive/archive-store.js';
import { HEARTBEAT_KEY, publishHeartbeat, type Heartbeat } from '../src/archive/heartbeat.js';
import { buildMonitorOptions, runMonitorCli } from '../src/monitor/cli.js';
import {
  DEFAULT_MAX_AGE_SECONDS,
  alertDetail,
  requiresAlert,
  runMonitor,
  type MonitorStatus,
} from '../src/monitor/run.js';

function heartbeatAt(completedAt: Date, deployment = 'gt-sales'): Heartbeat {
  return {
    schemaVersion: 1,
    deployment,
    runId: 'run-1',
    completedAt: completedAt.toISOString(),
    verified: true,
    manifestKey: 'run-1/manifest.json.enc',
    artifactCount: 3,
  };
}

describe('runMonitor', () => {
  it('reports ok well within the 26-hour threshold', async () => {
    const backend = new InMemoryArchiveBackend();
    await publishHeartbeat(backend.asWriter(), heartbeatAt(new Date('2026-09-14T00:00:00.000Z')));
    const status = await runMonitor({
      reader: backend.asReader(),
      deployment: 'gt-sales',
      now: () => new Date('2026-09-14T10:00:00.000Z'),
    });
    expect(status).toEqual({
      status: 'ok',
      heartbeat: heartbeatAt(new Date('2026-09-14T00:00:00.000Z')),
      ageSeconds: 10 * 60 * 60,
    });
    expect(requiresAlert(status)).toBe(false);
  });

  it('alerts once the latest verified snapshot exceeds 26 hours', async () => {
    const backend = new InMemoryArchiveBackend();
    await publishHeartbeat(backend.asWriter(), heartbeatAt(new Date('2026-09-13T00:00:00.000Z')));
    const status = await runMonitor({
      reader: backend.asReader(),
      deployment: 'gt-sales',
      now: () => new Date('2026-09-14T02:30:00.000Z'),
    });
    expect(status.status).toBe('stale');
    if (status.status !== 'stale') throw new Error('unreachable');
    expect(DEFAULT_MAX_AGE_SECONDS).toBe(26 * 60 * 60);
    expect(status.maxAgeSeconds).toBe(DEFAULT_MAX_AGE_SECONDS);
    expect(status.ageSeconds).toBeGreaterThan(DEFAULT_MAX_AGE_SECONDS);
    expect(requiresAlert(status)).toBe(true);
  });

  it('alerts when no heartbeat has ever been published (a stopped/never-completed run)', async () => {
    const backend = new InMemoryArchiveBackend();
    const status = await runMonitor({ reader: backend.asReader(), deployment: 'gt-sales' });
    expect(status).toEqual({ status: 'missing' });
    expect(requiresAlert(status)).toBe(true);
  });

  it('alerts on a malformed heartbeat rather than treating it as success', async () => {
    const backend = new InMemoryArchiveBackend();
    await backend.asWriter().putObject(HEARTBEAT_KEY, new TextEncoder().encode('not json'));
    const status = await runMonitor({ reader: backend.asReader(), deployment: 'gt-sales' });
    expect(status).toEqual({ status: 'malformed' });
    expect(requiresAlert(status)).toBe(true);
  });

  it('a stopped/partial backup run (no heartbeat write) cannot masquerade as success', async () => {
    // The backup publishes its heartbeat only as its last step; a crash
    // beforehand leaves artifacts under the run prefix and no heartbeat.
    const backend = new InMemoryArchiveBackend();
    await backend.asWriter().putObject('run-1/data.sql.enc', new Uint8Array([1]));
    const status = await runMonitor({ reader: backend.asReader(), deployment: 'gt-sales' });
    expect(status.status).toBe('missing');
  });

  it('alerts on a fresh heartbeat from another deployment, so two deployments pointed at one bucket by mistake are caught', async () => {
    const backend = new InMemoryArchiveBackend();
    await publishHeartbeat(
      backend.asWriter(),
      heartbeatAt(new Date('2026-09-14T09:00:00.000Z'), 'canadawide'),
    );
    const status = await runMonitor({
      reader: backend.asReader(),
      deployment: 'gt-sales',
      now: () => new Date('2026-09-14T10:00:00.000Z'),
    });
    expect(status).toEqual({
      status: 'wrong_deployment',
      expected: 'gt-sales',
      actual: 'canadawide',
    });
    expect(requiresAlert(status)).toBe(true);
  });

  it('a stale heartbeat from another deployment is reported as the wrong deployment', async () => {
    const backend = new InMemoryArchiveBackend();
    await publishHeartbeat(
      backend.asWriter(),
      heartbeatAt(new Date('2026-01-01T00:00:00.000Z'), 'canadawide'),
    );
    const status = await runMonitor({
      reader: backend.asReader(),
      deployment: 'gt-sales',
      now: () => new Date('2026-09-14T10:00:00.000Z'),
    });
    expect(status.status).toBe('wrong_deployment');
  });

  it('honours a custom threshold, and a heartbeat exactly at it is still ok', async () => {
    const backend = new InMemoryArchiveBackend();
    await publishHeartbeat(backend.asWriter(), heartbeatAt(new Date('2026-09-14T00:00:00.000Z')));
    const at = (iso: string) =>
      runMonitor({
        reader: backend.asReader(),
        deployment: 'gt-sales',
        now: () => new Date(iso),
        maxAgeSeconds: 3600,
      });
    expect((await at('2026-09-14T01:00:00.000Z')).status).toBe('ok');
    const stale = await at('2026-09-14T01:00:01.000Z');
    expect(stale).toMatchObject({ status: 'stale', ageSeconds: 3601, maxAgeSeconds: 3600 });
  });

  it('a heartbeat from the future reads as age zero, not negative', async () => {
    const backend = new InMemoryArchiveBackend();
    await publishHeartbeat(backend.asWriter(), heartbeatAt(new Date('2026-09-14T12:00:00.000Z')));
    const status = await runMonitor({
      reader: backend.asReader(),
      deployment: 'gt-sales',
      now: () => new Date('2026-09-14T10:00:00.000Z'),
    });
    expect(status).toMatchObject({ status: 'ok', ageSeconds: 0 });
  });
});

describe('alertDetail', () => {
  it('gives each alerting status its bounded detail code', () => {
    const heartbeat = heartbeatAt(new Date('2026-09-13T00:00:00.000Z'));
    const cases: [MonitorStatus, string][] = [
      [
        {
          status: 'stale',
          heartbeat,
          ageSeconds: 95_400.4,
          maxAgeSeconds: DEFAULT_MAX_AGE_SECONDS,
        },
        'stale:age_seconds:95400',
      ],
      [{ status: 'missing' }, 'missing'],
      [{ status: 'malformed' }, 'malformed'],
      [
        { status: 'wrong_deployment', expected: 'gt-sales', actual: 'canadawide' },
        'wrong_deployment:canadawide',
      ],
    ];
    for (const [status, detail] of cases) expect(alertDetail(status)).toBe(detail);
  });
});

// --- The CLI, against a fake S3 endpoint serving the archive ---------------

const NOW = new Date('2026-10-29T08:08:00.000Z');

const REQUIRED: Record<string, string> = {
  BACKUP_DEPLOYMENT: 'gt-sales',
  B2_ARCHIVE_READER_KEY_ID: 'b2-reader-key-id',
  B2_ARCHIVE_READER_APPLICATION_KEY: 'b2-reader-secret',
  B2_ARCHIVE_ENDPOINT: 'https://s3.eu-central-003.backblazeb2.com',
  B2_ARCHIVE_REGION: 'eu-central-003',
  B2_ARCHIVE_BUCKET: 'gt-sales-backups',
};

const HEARTBEAT_URL =
  'https://s3.eu-central-003.backblazeb2.com/gt-sales-backups/heartbeat/latest.json';

/** A fake S3 endpoint holding at most the heartbeat object. */
function fakeArchive(heartbeatBody?: string, status = 200) {
  const requests: { url: string; method: string; headers: Headers }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    requests.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
    });
    if (String(url) !== HEARTBEAT_URL) return new Response(null, { status: 404 });
    if (status !== 200) return new Response(null, { status });
    if (heartbeatBody === undefined) return new Response(null, { status: 404 });
    return new Response(new TextEncoder().encode(heartbeatBody), { status: 200 });
  };
  return { fetchImpl, requests };
}

function cliIo(fetchImpl: typeof fetch) {
  const alerts = new FakeOwnerAlertChannel();
  const errorTracker = new FakeErrorTracker();
  return { io: { fetchImpl, alerts, errorTracker, now: () => NOW }, alerts, errorTracker };
}

function logLines(spy: { mock: { calls: unknown[][] } }): unknown[] {
  return spy.mock.calls.map((call) => JSON.parse(String(call[0])));
}

describe('monitor CLI', () => {
  let info: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    info = vi.spyOn(console, 'info').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds a reader signed with the reader key for the deployment, with the default threshold', async () => {
    const { fetchImpl, requests } = fakeArchive(
      JSON.stringify(heartbeatAt(new Date('2026-10-29T06:20:00.000Z'))),
    );
    const options = buildMonitorOptions({ ...REQUIRED }, { fetchImpl });
    expect(options.deployment).toBe('gt-sales');
    expect(options.maxAgeSeconds).toBe(DEFAULT_MAX_AGE_SECONDS);
    expect(options.reader).toBeInstanceOf(S3ArchiveReader);
    await options.reader.getObject(HEARTBEAT_KEY);
    expect(requests[0]?.url).toBe(HEARTBEAT_URL);
    expect(requests[0]?.headers.get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=b2-reader-key-id\/\d{8}\/eu-central-003\/s3\/aws4_request, /,
    );
  });

  it('reads BACKUP_MONITOR_MAX_AGE_SECONDS and rejects a value that is not a positive whole number', () => {
    const { fetchImpl } = fakeArchive();
    expect(
      buildMonitorOptions({ ...REQUIRED, BACKUP_MONITOR_MAX_AGE_SECONDS: '7200' }, { fetchImpl })
        .maxAgeSeconds,
    ).toBe(7200);
    for (const value of ['0', '-5', '1.5', '26h']) {
      expect(() =>
        buildMonitorOptions({ ...REQUIRED, BACKUP_MONITOR_MAX_AGE_SECONDS: value }, { fetchImpl }),
      ).toThrow('BACKUP_MONITOR_MAX_AGE_SECONDS must be a positive whole number');
    }
  });

  it('names each missing required variable', () => {
    const { fetchImpl } = fakeArchive();
    expect(() => buildMonitorOptions({}, { fetchImpl })).toThrow('BACKUP_DEPLOYMENT is required');
    for (const name of Object.keys(REQUIRED)) {
      expect(() => buildMonitorOptions({ ...REQUIRED, [name]: ' ' }, { fetchImpl })).toThrow(
        `${name} is required`,
      );
    }
  });

  it('a fresh heartbeat logs monitor_status ok, sends no alert and exits 0', async () => {
    const heartbeat = heartbeatAt(new Date('2026-10-29T06:20:00.000Z'));
    const { fetchImpl } = fakeArchive(JSON.stringify(heartbeat));
    const { io, alerts, errorTracker } = cliIo(fetchImpl);
    expect(await runMonitorCli({ ...REQUIRED }, io)).toBe(0);
    expect(logLines(info)).toEqual([
      {
        event: 'monitor_status',
        deployment: 'gt-sales',
        status: 'ok',
        heartbeat,
        ageSeconds: 108 * 60,
      },
    ]);
    expect(error).not.toHaveBeenCalled();
    expect(alerts.sent).toEqual([]);
    expect(errorTracker.events).toEqual([]);
  });

  const alerting: [string, string | undefined, string][] = [
    [
      'stale',
      JSON.stringify(heartbeatAt(new Date('2026-10-28T06:00:00.000Z'))),
      `stale:age_seconds:${26 * 3600 + 8 * 60}`,
    ],
    ['missing', undefined, 'missing'],
    ['malformed', '{"schemaVersion":1}', 'malformed'],
    [
      'wrong_deployment',
      JSON.stringify(heartbeatAt(new Date('2026-10-29T06:20:00.000Z'), 'canadawide')),
      'wrong_deployment:canadawide',
    ],
  ];
  for (const [status, body, detail] of alerting) {
    it(`a ${status} heartbeat alerts the owner with ${detail} and exits 1`, async () => {
      const { fetchImpl } = fakeArchive(body);
      const { io, alerts, errorTracker } = cliIo(fetchImpl);
      expect(await runMonitorCli({ ...REQUIRED }, io)).toBe(1);
      expect(logLines(info)).toEqual([
        expect.objectContaining({ event: 'monitor_status', deployment: 'gt-sales', status }),
      ]);
      expect(logLines(error)).toEqual([
        { event: 'monitor_alert', deployment: 'gt-sales', status, detail },
      ]);
      const expected: OwnerAlert = {
        kind: 'backup_stale',
        detail,
        occurredAt: NOW.toISOString(),
      };
      expect(alerts.sent).toEqual([expected]);
      expect(errorTracker.events).toEqual([]);
    });
  }

  it('a failed alert delivery is logged and the run still exits 1', async () => {
    const { fetchImpl } = fakeArchive();
    const { io } = cliIo(fetchImpl);
    const failing = {
      send: async () => {
        throw new Error('alert_delivery_failed:503');
      },
    };
    expect(await runMonitorCli({ ...REQUIRED }, { ...io, alerts: failing })).toBe(1);
    expect(logLines(error)).toEqual([
      { event: 'monitor_alert', deployment: 'gt-sales', status: 'missing', detail: 'missing' },
      {
        event: 'monitor_alert_delivery_failed',
        deployment: 'gt-sales',
        message: 'alert_delivery_failed:503',
      },
    ]);
  });

  it('alerts monitor_failed, reports the error and exits 1 when configuration fails', async () => {
    const { fetchImpl, requests } = fakeArchive();
    const { io, alerts, errorTracker } = cliIo(fetchImpl);
    expect(await runMonitorCli({ ...REQUIRED, B2_ARCHIVE_READER_APPLICATION_KEY: '' }, io)).toBe(1);
    expect(requests).toEqual([]);
    expect(logLines(error)).toEqual([
      {
        event: 'monitor_failed',
        deployment: 'gt-sales',
        message: 'B2_ARCHIVE_READER_APPLICATION_KEY is required',
      },
    ]);
    expect(alerts.sent).toEqual([
      { kind: 'backup_stale', detail: 'monitor_failed', occurredAt: NOW.toISOString() },
    ]);
    expect(errorTracker.events).toHaveLength(1);
    expect(errorTracker.events[0]?.tags).toMatchObject({ route: 'jobs:monitor' });
  });

  it('alerts monitor_failed when the archive cannot be read', async () => {
    const { fetchImpl } = fakeArchive(undefined, 403);
    const { io, alerts, errorTracker } = cliIo(fetchImpl);
    expect(await runMonitorCli({ ...REQUIRED }, io)).toBe(1);
    expect(logLines(error)).toEqual([
      { event: 'monitor_failed', deployment: 'gt-sales', message: 'archive_get_failed:403' },
    ]);
    expect(alerts.sent.map((alert) => alert.detail)).toEqual(['monitor_failed']);
    expect(errorTracker.events).toHaveLength(1);
  });
});
