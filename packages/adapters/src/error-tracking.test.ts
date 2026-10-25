import { describe, expect, test, vi } from 'vitest';

import {
  createErrorTrackerFromEnv,
  NoopErrorTracker,
  parseSentryDsn,
  SentryHttpErrorTracker,
} from './error-tracking.js';

function requestBody(init: RequestInit | undefined): unknown {
  const body = init?.body;
  if (typeof body !== 'string') throw new Error('expected a string request body');
  return JSON.parse(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('expected an object');
  return value;
}

describe('parseSentryDsn', () => {
  test('parses a standard DSN', () => {
    expect(parseSentryDsn('https://examplekey@o123.ingest.sentry.io/456')).toEqual({
      publicKey: 'examplekey',
      host: 'o123.ingest.sentry.io',
      projectId: '456',
    });
  });

  test('rejects a malformed DSN', () => {
    expect(parseSentryDsn('not-a-url')).toBeUndefined();
    expect(parseSentryDsn('https://o123.ingest.sentry.io/456')).toBeUndefined();
  });
});

describe('SentryHttpErrorTracker', () => {
  test('posts a scrubbed event to the DSN store endpoint and never throws on network failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const tracker = new SentryHttpErrorTracker({
      dsn: 'https://key@o1.ingest.sentry.io/9',
      release: 'sha-abc123',
      environment: 'production',
      fetchImpl,
    });

    tracker.captureException(new Error('order failed for jane@example.com'), {
      requestId: 'req-1',
      workspaceId: 'ws-1',
      route: '/api/v1/orders',
      release: 'sha-abc123',
    });

    // The call is fire-and-forget; let the microtask queue drain.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain('o1.ingest.sentry.io');
    const body = asRecord(requestBody(init));
    expect(asRecord(body.tags).requestId).toBe('req-1');
    expect(JSON.stringify(body)).not.toContain('jane@example.com');
  });

  test('a rejected fetch never throws back to the caller', () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    const tracker = new SentryHttpErrorTracker({
      dsn: 'https://key@o1.ingest.sentry.io/9',
      release: 'sha-abc123',
      fetchImpl,
    });
    expect(() =>
      tracker.captureException(new Error('boom'), { requestId: 'req-1', release: 'sha-abc123' }),
    ).not.toThrow();
  });

  test('a rejected delivery is logged with its status, never the endpoint or key', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401 });
      const tracker = new SentryHttpErrorTracker({
        dsn: 'https://publickey@o1.ingest.sentry.io/9/',
        release: 'sha-abc123',
        fetchImpl,
      });
      tracker.captureException(new Error('boom'), { requestId: 'req-1', release: 'sha-abc123' });
      await vi.waitFor(() => expect(logged).toHaveBeenCalled());
      const line = String(logged.mock.calls[0]?.[0]);
      expect(line).toContain('error_tracker_delivery_rejected');
      expect(line).toContain('401');
      expect(line).not.toContain('publickey');
      // The trailing slash in the DSN did not leak into the project path.
      expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('/api/9/');
    } finally {
      logged.mockRestore();
    }
  });

  test('throws at construction for an invalid DSN', () => {
    expect(() => new SentryHttpErrorTracker({ dsn: 'bad', release: 'v1' })).toThrow();
  });
});

describe('createErrorTrackerFromEnv', () => {
  test('returns a no-op tracker when SENTRY_DSN is unset', () => {
    const tracker = createErrorTrackerFromEnv({ env: {} });
    expect(tracker).toBeInstanceOf(NoopErrorTracker);
    expect(() =>
      tracker.captureException(new Error('x'), { requestId: 'req-1', release: 'v1' }),
    ).not.toThrow();
  });

  test('returns a real tracker when SENTRY_DSN is set', () => {
    const tracker = createErrorTrackerFromEnv({
      env: { SENTRY_DSN: 'https://key@o1.ingest.sentry.io/9', RELEASE_SHA: 'sha-1' },
      fetchImpl: vi.fn().mockResolvedValue({ ok: true }),
    });
    expect(tracker).toBeInstanceOf(SentryHttpErrorTracker);
  });
});
