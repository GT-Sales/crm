import { describe, expect, it } from 'vitest';

import { InMemoryArchiveBackend } from '../src/archive/archive-store.js';
import {
  HEARTBEAT_KEY,
  publishHeartbeat,
  readLatestHeartbeat,
  type Heartbeat,
} from '../src/archive/heartbeat.js';

const heartbeat: Heartbeat = {
  schemaVersion: 1,
  deployment: 'gt-sales',
  runId: 'run-1',
  completedAt: '2026-10-29T06:20:00.000Z',
  verified: true,
  manifestKey: 'run-1/manifest.json.age',
  artifactCount: 4,
};

describe('heartbeat', () => {
  it('the writer publishes it at heartbeat/latest.json and the reader reads it back', async () => {
    const backend = new InMemoryArchiveBackend();
    await publishHeartbeat(backend.asWriter(), heartbeat);
    expect(HEARTBEAT_KEY).toBe('heartbeat/latest.json');
    expect(
      (await backend.asWriter().listObjects('heartbeat/')).map((object) => object.key),
    ).toEqual([HEARTBEAT_KEY]);
    expect(await readLatestHeartbeat(backend.asReader())).toEqual({ status: 'ok', heartbeat });
  });

  it('a later publish replaces the earlier heartbeat', async () => {
    const backend = new InMemoryArchiveBackend();
    await publishHeartbeat(backend.asWriter(), heartbeat);
    await publishHeartbeat(backend.asWriter(), { ...heartbeat, runId: 'run-2' });
    const result = await readLatestHeartbeat(backend.asReader());
    expect(result.status === 'ok' && result.heartbeat.runId).toBe('run-2');
  });

  it('refuses to publish an invalid heartbeat', async () => {
    const backend = new InMemoryArchiveBackend();
    await expect(
      publishHeartbeat(backend.asWriter(), { ...heartbeat, artifactCount: 0 }),
    ).rejects.toThrow();
    await expect(
      publishHeartbeat(backend.asWriter(), { ...heartbeat, deployment: '' }),
    ).rejects.toThrow();
    expect(backend.size()).toBe(0);
  });

  it('reads missing when no run has published one', async () => {
    expect(await readLatestHeartbeat(new InMemoryArchiveBackend().asReader())).toEqual({
      status: 'missing',
    });
  });

  it.each([
    ['not JSON', '{not json'],
    ['JSON without a deployment', JSON.stringify({ ...heartbeat, deployment: undefined })],
    ['an unverified run', JSON.stringify({ ...heartbeat, verified: false })],
  ])('reads malformed for %s', async (_label, body) => {
    const backend = new InMemoryArchiveBackend();
    await backend.asWriter().putObject(HEARTBEAT_KEY, new TextEncoder().encode(body));
    expect(await readLatestHeartbeat(backend.asReader())).toEqual({ status: 'malformed' });
  });
});
