import { describe, expect, it } from 'vitest';

import {
  InMemoryArchiveBackend,
  type ArchiveRetentionAdmin,
  type ArchiveWriter,
} from '../src/archive/archive-store.js';
import {
  TestEnvelopeDecryptor,
  TestEnvelopeEncryptor,
  generateTestRecipientKeyPair,
  type Decryptor,
  type Encryptor,
} from '../src/archive/encryptor.js';
import {
  HEARTBEAT_KEY,
  publishHeartbeat,
  readLatestHeartbeat,
  type Heartbeat,
} from '../src/archive/heartbeat.js';
import {
  backupManifestSchema,
  buildManifest,
  manifestArtifact,
  verifyManifestArtifacts,
} from '../src/archive/manifest.js';
import {
  DEFAULT_GRACE_SECONDS,
  graceSecondsFromEnv,
  retentionPolicyFromEnv,
  runRetention,
} from '../src/retention/run.js';
import { defaultRetentionPolicy } from '../src/retention/select.js';

// The in-memory archive stamps each upload with this clock, so a seeded run's
// manifest carries the capture time retention reads from the listing.
let clock = new Date('2026-09-14T02:00:00.000Z');

async function seedRun(
  writer: ArchiveWriter,
  encryptor: Encryptor,
  runId: string,
  capturedAt: Date,
): Promise<void> {
  clock = capturedAt;
  const artifactBytes = new TextEncoder().encode(`payload-for-${runId}`);
  const manifest = buildManifest({
    deployment: 'gt-sales',
    runId,
    capturedAt,
    sourceIds: {},
    toolVersions: {},
    artifacts: [manifestArtifact('data.sql', artifactBytes)],
    rowCounts: {},
    counts: {},
    exclusions: [],
  });
  await writer.putObject(`${runId}/data.sql.enc`, await encryptor.encrypt(artifactBytes));
  await writer.putObject(
    `${runId}/manifest.json.enc`,
    await encryptor.encrypt(new TextEncoder().encode(JSON.stringify(manifest))),
  );
}

function daysAgo(n: number): Date {
  const d = new Date('2026-09-14T02:00:00.000Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

function testEncryptor(): { encryptor: Encryptor; decryptor: Decryptor } {
  const { publicKeyBase64, privateKeyBase64 } = generateTestRecipientKeyPair();
  return {
    encryptor: new TestEnvelopeEncryptor(publicKeyBase64),
    decryptor: new TestEnvelopeDecryptor(privateKeyBase64),
  };
}

/** The retention admin, with every delete it is asked for recorded. */
function recordingAdmin(backend: InMemoryArchiveBackend) {
  const admin = backend.asRetentionAdmin();
  const deleteCalls: string[] = [];
  const recording: ArchiveRetentionAdmin = {
    listObjects: (prefix) => admin.listObjects(prefix),
    getObject: (key) => admin.getObject(key),
    deleteObject: async (key) => {
      deleteCalls.push(key);
      await admin.deleteObject(key);
    },
  };
  return { admin: recording, deleteCalls };
}

function heartbeatFor(runId: string, completedAt: Date): Heartbeat {
  return {
    schemaVersion: 1,
    deployment: 'gt-sales',
    runId,
    completedAt: completedAt.toISOString(),
    verified: true,
    manifestKey: `${runId}/manifest.json.enc`,
    artifactCount: 1,
  };
}

describe('runRetention', () => {
  it('dry-run reports candidate deletions without deleting anything', async () => {
    const backend = new InMemoryArchiveBackend(() => clock);
    const { encryptor } = testEncryptor();
    const writer = backend.asWriter();

    for (let i = 0; i < 35; i++) {
      await seedRun(writer, encryptor, `run-${i}`, daysAgo(i));
    }
    const sizeBefore = backend.size();
    const { admin, deleteCalls } = recordingAdmin(backend);

    const report = await runRetention({
      admin,
      now: () => new Date('2026-09-14T02:00:00.000Z'),
      dryRun: true,
    });

    expect(report.dryRun).toBe(true);
    expect(report.totalRuns).toBe(35);
    expect(report.retainedRunIds).toHaveLength(30);
    expect(report.candidateDeletions.length).toBeGreaterThan(0);
    expect(report.deleted).toEqual([]);
    expect(deleteCalls).toEqual([]);
    expect(backend.size()).toBe(sizeBefore);
  });

  it('deletes only unreferenced payloads outside the grace period, and a retained snapshot remains fully restorable', async () => {
    const backend = new InMemoryArchiveBackend(() => clock);
    const { encryptor, decryptor } = testEncryptor();
    const writer = backend.asWriter();

    for (let i = 0; i < 35; i++) {
      await seedRun(writer, encryptor, `run-${i}`, daysAgo(i));
    }
    const { admin, deleteCalls } = recordingAdmin(backend);

    const report = await runRetention({
      admin,
      now: () => new Date('2026-09-14T02:00:00.000Z'),
      graceSeconds: 0,
      dryRun: false,
    });

    expect(report.retainedRunIds).toHaveLength(30);
    expect(report.deleted.length).toBe(report.candidateDeletions.length);
    expect(report.deleted.length).toBeGreaterThan(0);
    expect(deleteCalls).toEqual(report.deleted);
    expect(new Set(report.deleted.map((key) => key.split('/')[0]))).toEqual(
      new Set(['run-30', 'run-31', 'run-32', 'run-33', 'run-34']),
    );

    // The oldest (unretained) run's objects are gone.
    const reader = backend.asReader();
    expect(await reader.getObject('run-34/manifest.json.enc')).toBeUndefined();
    expect(await reader.getObject('run-34/data.sql.enc')).toBeUndefined();

    // A retained run (the most recent) is still completely present and
    // decrypts and verifies exactly as it would during a real restore.
    const manifestCiphertext = await reader.getObject('run-0/manifest.json.enc');
    if (!manifestCiphertext) throw new Error('run-0 manifest missing');
    const manifest = backupManifestSchema.parse(
      JSON.parse(new TextDecoder().decode(await decryptor.decrypt(manifestCiphertext))),
    );
    const artifactCiphertext = await reader.getObject('run-0/data.sql.enc');
    if (!artifactCiphertext) throw new Error('run-0 artifact missing');
    const artifactBytes = await decryptor.decrypt(artifactCiphertext);
    expect(verifyManifestArtifacts(manifest, new Map([['data.sql', artifactBytes]]))).toEqual({
      ok: true,
    });
  });

  it('never deletes anything from a run whose manifest age is unknown (fail-safe, not fail-open)', async () => {
    const backend = new InMemoryArchiveBackend(() => clock);
    const { encryptor } = testEncryptor();
    const writer = backend.asWriter();

    for (let i = 0; i < 35; i++) {
      await seedRun(writer, encryptor, `run-${i}`, daysAgo(i));
    }
    // Retention never decrypts a manifest; it ages a run by the manifest
    // object's upload time. Hide that time for the oldest run so it cannot be
    // proven safe to delete.
    const admin = backend.asRetentionAdmin();
    const report = await runRetention({
      admin: {
        ...admin,
        listObjects: async (prefix) =>
          (await admin.listObjects(prefix)).map((object) =>
            object.key === 'run-34/manifest.json.enc'
              ? { key: object.key, sizeBytes: object.sizeBytes }
              : object,
          ),
      },
      now: () => new Date('2026-09-14T02:00:00.000Z'),
      graceSeconds: 0,
      dryRun: false,
    });

    expect(report.unreadableManifests).toEqual(['run-34/manifest.json.enc']);
    expect(report.retainedRunIds).toContain('run-34');
    expect(await backend.asReader().getObject('run-34/data.sql.enc')).toBeDefined();
  });

  it('deletes an abandoned attempt without a manifest once it is past the grace period', async () => {
    let clock = new Date('2026-09-10T06:17:00.000Z');
    const backend = new InMemoryArchiveBackend(() => clock);
    const { encryptor } = testEncryptor();
    const writer = backend.asWriter();
    await seedRun(writer, encryptor, 'run-complete', clock);
    // A failed attempt uploaded one artifact and stopped before its manifest.
    await writer.putObject('run-failed/data.sql.enc', new Uint8Array([1]));
    clock = new Date('2026-09-10T06:30:00.000Z');
    // A later attempt is still uploading when retention starts.
    await writer.putObject('run-uploading/data.sql.enc', new Uint8Array([2]));

    const report = await runRetention({
      admin: backend.asRetentionAdmin(),
      now: () => new Date('2026-09-11T06:20:00.000Z'),
      dryRun: false,
    });

    expect(report.unreadableManifests).toEqual([]);
    expect(report.abandonedRunIds).toEqual(['run-failed']);
    expect(report.pendingRunIds).toEqual(['run-uploading']);
    expect(report.deleted).toEqual(['run-failed/data.sql.enc']);
    expect(await backend.asReader().getObject('run-uploading/data.sql.enc')).toBeDefined();
    expect(await backend.asReader().getObject('run-complete/manifest.json.enc')).toBeDefined();
  });

  it('fails visibly instead of deleting a manifest-less attempt of unknown age', async () => {
    const backend = new InMemoryArchiveBackend(() => clock);
    const admin = backend.asRetentionAdmin();
    await backend.asWriter().putObject('run-unknown/data.sql.enc', new Uint8Array([1]));
    const report = await runRetention({
      admin: {
        ...admin,
        listObjects: async (prefix) =>
          (await admin.listObjects(prefix)).map(({ key, sizeBytes }) => ({ key, sizeBytes })),
      },
      now: () => new Date('2030-01-01T00:00:00.000Z'),
      graceSeconds: 0,
      dryRun: false,
    });
    expect(report.unreadableManifests).toEqual(['run-unknown/manifest.json.enc']);
    expect(report.deleted).toEqual([]);
  });

  it('never deletes the heartbeat object', async () => {
    const backend = new InMemoryArchiveBackend(() => clock);
    const { encryptor } = testEncryptor();
    const writer = backend.asWriter();
    await seedRun(writer, encryptor, 'run-0', new Date('2026-09-14T02:00:00.000Z'));
    await publishHeartbeat(writer, heartbeatFor('run-0', new Date('2026-09-14T02:00:00.000Z')));
    // A policy that keeps a single run, years later, with no grace: every
    // other object is old enough to go, the heartbeat never is.
    await seedRun(writer, encryptor, 'run-1', new Date('2026-09-15T02:00:00.000Z'));
    const { admin, deleteCalls } = recordingAdmin(backend);

    const report = await runRetention({
      admin,
      now: () => new Date('2027-01-01T00:00:00.000Z'),
      policy: { dailyPoints: 1, monthlyPoints: 1 },
      graceSeconds: 0,
      dryRun: false,
    });
    expect(report.deleted).toEqual(['run-0/data.sql.enc', 'run-0/manifest.json.enc']);
    expect(deleteCalls).not.toContain(HEARTBEAT_KEY);
    expect(report.candidateDeletions).not.toContain(HEARTBEAT_KEY);
    expect((await readLatestHeartbeat(backend.asReader())).status).toBe('ok');
  });

  it('a run with a manifest is a restore point even when its backup failed list-verification afterwards', async () => {
    // The backup uploads the manifest last, then verifies by listing and only
    // then publishes the heartbeat. A run that stopped between the two still
    // holds a complete, hash-verifiable set, so retention keeps and ages it
    // like any other restore point rather than as an abandoned attempt.
    const backend = new InMemoryArchiveBackend(() => clock);
    const { encryptor } = testEncryptor();
    const writer = backend.asWriter();
    await seedRun(writer, encryptor, 'run-unverified', daysAgo(1));
    await seedRun(writer, encryptor, 'run-verified', daysAgo(0));
    await publishHeartbeat(writer, heartbeatFor('run-verified', daysAgo(0)));

    const report = await runRetention({
      admin: backend.asRetentionAdmin(),
      now: () => new Date('2026-09-14T03:00:00.000Z'),
      graceSeconds: 0,
      dryRun: false,
    });
    expect(report.totalRuns).toBe(2);
    expect(report.abandonedRunIds).toEqual([]);
    expect(report.pendingRunIds).toEqual([]);
    expect(new Set(report.retainedRunIds)).toEqual(new Set(['run-unverified', 'run-verified']));
    expect(report.deleted).toEqual([]);
  });

  it('keeps a run outside the policy until it is past the default 24-hour grace period', async () => {
    const backend = new InMemoryArchiveBackend(() => clock);
    const { encryptor } = testEncryptor();
    const writer = backend.asWriter();
    await seedRun(writer, encryptor, 'run-old', new Date('2026-09-14T00:00:00.000Z'));
    await seedRun(writer, encryptor, 'run-new', new Date('2026-09-14T01:00:00.000Z'));
    const policy = { dailyPoints: 1, monthlyPoints: 1 };

    const inside = await runRetention({
      admin: backend.asRetentionAdmin(),
      now: () => new Date('2026-09-14T23:59:59.000Z'),
      policy,
      dryRun: true,
    });
    expect(inside.retainedRunIds).toEqual(['run-new']);
    expect(inside.candidateDeletions).toEqual([]);

    const past = await runRetention({
      admin: backend.asRetentionAdmin(),
      now: () => new Date('2026-09-15T00:00:01.000Z'),
      policy,
      dryRun: true,
    });
    expect(past.candidateDeletions).toEqual(['run-old/data.sql.enc', 'run-old/manifest.json.enc']);
  });

  it('a larger policy keeps more restore points', async () => {
    const backend = new InMemoryArchiveBackend(() => clock);
    const { encryptor } = testEncryptor();
    const writer = backend.asWriter();
    for (let i = 0; i < 10; i++) {
      await seedRun(writer, encryptor, `run-${i}`, daysAgo(i));
    }
    const run = (dailyPoints: number) =>
      runRetention({
        admin: backend.asRetentionAdmin(),
        now: () => new Date('2026-09-14T02:00:00.000Z'),
        policy: { dailyPoints, monthlyPoints: 1 },
        graceSeconds: 0,
        dryRun: true,
      });
    expect((await run(3)).retainedRunIds).toHaveLength(3);
    expect((await run(7)).retainedRunIds).toHaveLength(7);
  });
});

describe('retentionPolicyFromEnv and graceSecondsFromEnv', () => {
  it('default to 30 daily and 12 monthly points and a 24-hour grace period', () => {
    expect(retentionPolicyFromEnv({})).toEqual(defaultRetentionPolicy);
    expect(
      retentionPolicyFromEnv({ RETENTION_DAILY_POINTS: ' ', RETENTION_MONTHLY_POINTS: '' }),
    ).toEqual({ dailyPoints: 30, monthlyPoints: 12 });
    expect(DEFAULT_GRACE_SECONDS).toBe(86_400);
    expect(graceSecondsFromEnv({})).toBe(86_400);
  });

  it('read overrides', () => {
    expect(
      retentionPolicyFromEnv({ RETENTION_DAILY_POINTS: '7', RETENTION_MONTHLY_POINTS: '3' }),
    ).toEqual({ dailyPoints: 7, monthlyPoints: 3 });
    expect(retentionPolicyFromEnv({ RETENTION_DAILY_POINTS: '14' })).toEqual({
      dailyPoints: 14,
      monthlyPoints: 12,
    });
    expect(graceSecondsFromEnv({ RETENTION_GRACE_SECONDS: '3600' })).toBe(3600);
  });

  it('reject zero, negative and non-integer values', () => {
    for (const value of ['0', '-1', '1.5', 'ten', '1e3']) {
      expect(() => retentionPolicyFromEnv({ RETENTION_DAILY_POINTS: value })).toThrow(
        'RETENTION_DAILY_POINTS must be a positive whole number',
      );
      expect(() => retentionPolicyFromEnv({ RETENTION_MONTHLY_POINTS: value })).toThrow(
        'RETENTION_MONTHLY_POINTS must be a positive whole number',
      );
      expect(() => graceSecondsFromEnv({ RETENTION_GRACE_SECONDS: value })).toThrow(
        'RETENTION_GRACE_SECONDS must be a positive whole number',
      );
    }
  });
});
