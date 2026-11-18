import { describe, expect, it, vi } from 'vitest';

import { createAttachmentLinkCache } from './attachment-links';

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('createAttachmentLinkCache', () => {
  it('fetches a few links at a time and each one once', async () => {
    const pending = new Map<
      string,
      ReturnType<typeof deferred<{ url: string; expiresAt: string }>>
    >();
    const fetchLink = vi.fn((id: string) => {
      const next = deferred<{ url: string; expiresAt: string }>();
      pending.set(id, next);
      return next.promise;
    });
    const cache = createAttachmentLinkCache(fetchLink, { concurrency: 2, now: () => 0 });
    for (const id of ['a', 'b', 'c', 'a']) cache.request(id);
    expect(fetchLink.mock.calls.map((call) => call[0])).toEqual(['a', 'b']);
    expect(cache.get('c')).toEqual({ status: 'loading' });
    pending.get('a')?.resolve({ url: 'https://storage.test/a', expiresAt: '1970-01-01T01:00:00Z' });
    await settle();
    expect(fetchLink.mock.calls.map((call) => call[0])).toEqual(['a', 'b', 'c']);
    expect(cache.get('a')).toEqual({
      status: 'ready',
      url: 'https://storage.test/a',
      expiresAt: 3_600_000,
      local: false,
    });
    cache.request('a');
    expect(fetchLink).toHaveBeenCalledTimes(3);
  });

  it('asks again only when a link is about to expire, and keeps a working one if that fails', async () => {
    let clock = 0;
    const fetchLink = vi
      .fn<(id: string) => Promise<{ url: string; expiresAt: string }>>()
      .mockResolvedValueOnce({ url: 'https://storage.test/1', expiresAt: '1970-01-01T00:05:00Z' })
      .mockRejectedValueOnce(new Error('offline'));
    const cache = createAttachmentLinkCache(fetchLink, {
      now: () => clock,
      refreshMarginMs: 60_000,
    });
    cache.request('a');
    await settle();
    clock = 200_000;
    cache.request('a');
    expect(fetchLink).toHaveBeenCalledTimes(1);
    clock = 250_000;
    cache.request('a');
    expect(fetchLink).toHaveBeenCalledTimes(2);
    await settle();
    expect(cache.get('a')).toMatchObject({ status: 'ready', url: 'https://storage.test/1' });
  });

  it('marks a link that cannot be had as failed, without asking again and again', async () => {
    const fetchLink = vi.fn().mockRejectedValue(new Error('gone'));
    const cache = createAttachmentLinkCache(fetchLink);
    cache.request('a');
    await settle();
    expect(cache.get('a')).toEqual({ status: 'failed' });
    cache.request('a');
    expect(fetchLink).toHaveBeenCalledTimes(1);
  });

  it('owns the local preview of a sent file and revokes it when disposed, dropping late answers', async () => {
    const revoke = vi.fn();
    const late = deferred<{ url: string; expiresAt: string }>();
    const cache = createAttachmentLinkCache(() => late.promise, { revoke });
    const listener = vi.fn();
    cache.subscribe(listener);
    cache.seedLocal('a', 'blob:http://admin.test/1');
    expect(cache.get('a')).toMatchObject({ status: 'ready', url: 'blob:http://admin.test/1' });
    cache.request('a');
    cache.request('b');
    cache.dispose();
    expect(revoke).toHaveBeenCalledWith('blob:http://admin.test/1');
    late.resolve({ url: 'https://storage.test/b', expiresAt: '2099-01-01T00:00:00Z' });
    await settle();
    expect(cache.get('b')).toBeUndefined();
    expect(listener).toHaveBeenCalled();
  });
});
