import { FakeErrorTracker } from '@gt-sales/adapters';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InMemoryArchiveBackend, S3ArchiveRetentionAdmin } from '../src/archive/archive-store.js';
import { HEARTBEAT_KEY, publishHeartbeat } from '../src/archive/heartbeat.js';
import { buildRetentionOptions, runRetentionCli } from '../src/retention/cli.js';
import { DEFAULT_GRACE_SECONDS } from '../src/retention/run.js';
import { defaultRetentionPolicy } from '../src/retention/select.js';

const NOW = new Date('2026-10-29T07:43:00.000Z');

const REQUIRED: Record<string, string> = {
  B2_ARCHIVE_RETENTION_KEY_ID: 'b2-retention-key-id',
  B2_ARCHIVE_RETENTION_APPLICATION_KEY: 'b2-retention-secret',
  B2_ARCHIVE_ENDPOINT: 'https://s3.eu-central-003.backblazeb2.com',
  B2_ARCHIVE_REGION: 'eu-central-003',
  B2_ARCHIVE_BUCKET: 'gt-sales-backups',
};

const BUCKET_URL = 'https://s3.eu-central-003.backblazeb2.com/gt-sales-backups';

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * A fake S3 endpoint over an in-memory archive: ListObjectsV2, GET and
 * DELETE on path-style URLs, every request recorded. `hideLastModified`
 * leaves a key's upload time out of the listing, as a provider might.
 */
function fakeArchive(
  backend: InMemoryArchiveBackend,
  hideLastModified: ReadonlySet<string> = new Set(),
) {
  const store = backend.asRetentionAdmin();
  const requests: { url: string; method: string; headers: Headers }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    requests.push({ url: url.href, method, headers: new Headers(init?.headers) });
    if (!url.href.startsWith(BUCKET_URL)) return new Response(null, { status: 404 });
    const key = url.pathname
      .slice('/gt-sales-backups/'.length)
      .split('/')
      .map(decodeURIComponent)
      .join('/');
    if (method === 'GET' && url.searchParams.get('list-type') === '2') {
      const objects = await store.listObjects(url.searchParams.get('prefix') ?? '');
      const contents = objects
        .map(
          (object) =>
            `<Contents><Key>${escapeXml(object.key)}</Key><Size>${object.sizeBytes}</Size>${
              object.lastModified && !hideLastModified.has(object.key)
                ? `<LastModified>${object.lastModified.toISOString()}</LastModified>`
                : ''
            }</Contents>`,
        )
        .join('');
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
        { status: 200 },
      );
    }
    if (method === 'DELETE') {
      await store.deleteObject(key);
      return new Response(null, { status: 204 });
    }
    if (method === 'GET') {
      const body = await store.getObject(key);
      return body ? new Response(body, { status: 200 }) : new Response(null, { status: 404 });
    }
    return new Response(null, { status: 405 });
  };
  return { fetchImpl, requests };
}

async function seededBackend(): Promise<InMemoryArchiveBackend> {
  let clock = new Date('2026-10-01T06:17:00.000Z');
  const backend = new InMemoryArchiveBackend(() => clock);
  const writer = backend.asWriter();
  for (const day of ['2026-10-01', '2026-10-02', '2026-10-03']) {
    clock = new Date(`${day}T06:17:00.000Z`);
    const runId = `run-${day}`;
    await writer.putObject(`${runId}/data.sql.enc`, new Uint8Array([1, 2, 3]));
    await writer.putObject(`${runId}/manifest.json.enc`, new Uint8Array([4]));
  }
  await publishHeartbeat(writer, {
    schemaVersion: 1,
    deployment: 'gt-sales',
    runId: 'run-2026-10-03',
    completedAt: clock.toISOString(),
    verified: true,
    manifestKey: 'run-2026-10-03/manifest.json.enc',
    artifactCount: 1,
  });
  // An attempt that stopped before its manifest, long past the grace period.
  await writer.putObject('run-failed/data.sql.enc', new Uint8Array([9]));
  return backend;
}

/** Two daily points keep the newest two runs; the oldest is pruned. */
const POLICY_ENV = { RETENTION_DAILY_POINTS: '2', RETENTION_MONTHLY_POINTS: '1' };

function logLines(spy: { mock: { calls: unknown[][] } }): unknown[] {
  return spy.mock.calls.map((call) => JSON.parse(String(call[0])));
}

describe('buildRetentionOptions', () => {
  it('builds a retention admin signed with the retention key, dry-run and the default policy', async () => {
    const backend = await seededBackend();
    const { fetchImpl, requests } = fakeArchive(backend);
    const options = buildRetentionOptions({ ...REQUIRED }, { fetchImpl });
    expect(options.dryRun).toBe(true);
    expect(options.policy).toEqual(defaultRetentionPolicy);
    expect(options.graceSeconds).toBe(DEFAULT_GRACE_SECONDS);
    expect(options.admin).toBeInstanceOf(S3ArchiveRetentionAdmin);
    // It never holds a decryptor or the recovery key.
    expect(Object.keys(options).sort()).toEqual(['admin', 'dryRun', 'graceSeconds', 'policy']);

    await options.admin.listObjects('');
    expect(requests[0]?.url).toBe(`${BUCKET_URL}?list-type=2&prefix=`);
    expect(requests[0]?.headers.get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=b2-retention-key-id\/\d{8}\/eu-central-003\/s3\/aws4_request, /,
    );
  });

  it('deletes only when RETENTION_DRY_RUN is exactly false, in any case', () => {
    const dryRun = (value: string) =>
      buildRetentionOptions({ ...REQUIRED, RETENTION_DRY_RUN: value }).dryRun;
    expect(dryRun('false')).toBe(false);
    expect(dryRun(' FALSE ')).toBe(false);
    expect(dryRun('False')).toBe(false);
    for (const value of ['', 'true', 'no', '0', 'off', 'falsey']) expect(dryRun(value)).toBe(true);
  });

  it('passes the policy and grace period from the environment and rejects invalid values', () => {
    const options = buildRetentionOptions({
      ...REQUIRED,
      ...POLICY_ENV,
      RETENTION_GRACE_SECONDS: '600',
    });
    expect(options.policy).toEqual({ dailyPoints: 2, monthlyPoints: 1 });
    expect(options.graceSeconds).toBe(600);
    expect(() => buildRetentionOptions({ ...REQUIRED, RETENTION_DAILY_POINTS: '0' })).toThrow(
      'RETENTION_DAILY_POINTS must be a positive whole number',
    );
  });

  it('names each missing required variable', () => {
    for (const name of Object.keys(REQUIRED)) {
      expect(() => buildRetentionOptions({ ...REQUIRED, [name]: '' })).toThrow(
        `${name} is required`,
      );
    }
  });
});

describe('runRetentionCli', () => {
  let info: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    info = vi.spyOn(console, 'info').mockImplementation(() => {});
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a default run is a dry run: it reports and never sends a delete', async () => {
    const backend = await seededBackend();
    const sizeBefore = backend.size();
    const { fetchImpl, requests } = fakeArchive(backend);
    const errorTracker = new FakeErrorTracker();
    const env = { ...REQUIRED, ...POLICY_ENV, BACKUP_DEPLOYMENT: 'gt-sales' };

    expect(await runRetentionCli(env, { fetchImpl, errorTracker, now: () => NOW })).toBe(0);
    expect(requests.map((request) => request.method)).toEqual(['GET']);
    expect(backend.size()).toBe(sizeBefore);
    expect(logLines(info)).toEqual([
      {
        event: 'retention_completed',
        deployment: 'gt-sales',
        dryRun: true,
        totalRuns: 4,
        retainedRunCount: 2,
        candidateDeletionCount: 3,
        deletedCount: 0,
        unreadableManifestCount: 0,
        abandonedRunCount: 1,
        pendingRunCount: 0,
        abandonedRunIds: ['run-failed'],
        pendingRunIds: [],
        candidateRunIds: ['run-2026-10-01', 'run-failed'],
      },
    ]);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(errorTracker.events).toEqual([]);
  });

  it('RETENTION_DRY_RUN=false deletes the pruned objects and never the heartbeat', async () => {
    const backend = await seededBackend();
    const { fetchImpl, requests } = fakeArchive(backend);
    const env = { ...REQUIRED, ...POLICY_ENV, RETENTION_DRY_RUN: 'false' };

    expect(await runRetentionCli(env, { fetchImpl, now: () => NOW })).toBe(0);
    const deletes = requests.filter((request) => request.method === 'DELETE');
    expect(deletes.map((request) => request.url)).toEqual([
      `${BUCKET_URL}/run-2026-10-01/data.sql.enc`,
      `${BUCKET_URL}/run-2026-10-01/manifest.json.enc`,
      `${BUCKET_URL}/run-failed/data.sql.enc`,
    ]);
    const remaining = (await backend.asReader().listObjects('')).map((object) => object.key);
    expect(remaining.sort()).toEqual(
      [
        'run-2026-10-02/data.sql.enc',
        'run-2026-10-02/manifest.json.enc',
        'run-2026-10-03/data.sql.enc',
        'run-2026-10-03/manifest.json.enc',
        HEARTBEAT_KEY,
      ].sort(),
    );
    expect(logLines(info)).toEqual([
      expect.objectContaining({ event: 'retention_completed', dryRun: false, deletedCount: 3 }),
    ]);
  });

  it('reports unreadable manifests with their keys, deletes nothing of that run and exits 1', async () => {
    const backend = await seededBackend();
    const { fetchImpl } = fakeArchive(backend, new Set(['run-2026-10-01/manifest.json.enc']));
    const errorTracker = new FakeErrorTracker();
    const env = { ...REQUIRED, ...POLICY_ENV, RETENTION_DRY_RUN: 'false' };

    expect(await runRetentionCli(env, { fetchImpl, errorTracker, now: () => NOW })).toBe(1);
    expect(await backend.asReader().getObject('run-2026-10-01/data.sql.enc')).toBeDefined();
    expect(logLines(info)).toEqual([
      expect.objectContaining({ event: 'retention_completed', unreadableManifestCount: 1 }),
    ]);
    expect(logLines(warn)).toEqual([
      { event: 'retention_unreadable_manifests', keys: ['run-2026-10-01/manifest.json.enc'] },
    ]);
    expect(logLines(error)).toEqual([
      { event: 'retention_failed', message: 'retention_unreadable_manifests' },
    ]);
    expect(errorTracker.events).toHaveLength(1);
    expect(errorTracker.events[0]?.tags).toMatchObject({ route: 'jobs:retention' });
  });

  it('fails before touching the archive when a retention credential is missing', async () => {
    const backend = await seededBackend();
    const { fetchImpl, requests } = fakeArchive(backend);
    const errorTracker = new FakeErrorTracker();
    const env = { ...REQUIRED, B2_ARCHIVE_RETENTION_APPLICATION_KEY: '' };

    expect(await runRetentionCli(env, { fetchImpl, errorTracker, now: () => NOW })).toBe(1);
    expect(requests).toEqual([]);
    expect(logLines(error)).toEqual([
      { event: 'retention_failed', message: 'B2_ARCHIVE_RETENTION_APPLICATION_KEY is required' },
    ]);
    expect(errorTracker.events).toHaveLength(1);
  });
});
