import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureException } from './error-tracking';

const ORIGINAL_ENV = { ...process.env };

function requestBody(init: RequestInit | undefined): unknown {
  const body = init?.body;
  if (typeof body !== 'string') throw new Error('expected a string request body');
  return JSON.parse(body);
}

describe('captureException (admin)', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SENTRY_DSN = 'https://key@o1.ingest.sentry.io/9';
    process.env.RELEASE_SHA = 'sha-admin-1';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it('posts a scrubbed event carrying the request id and release', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    captureException(new Error('failed for jane@example.com'), {
      requestId: 'req-admin-1',
      route: '/w/site-1/orders',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = requestBody(init);
    expect(body).toMatchObject({ tags: { requestId: 'req-admin-1' }, release: 'sha-admin-1' });
    expect(JSON.stringify(body)).not.toContain('jane@example.com');
  });

  it('does nothing when no DSN is configured', () => {
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(() => captureException(new Error('x'), { requestId: 'req-1' })).not.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
