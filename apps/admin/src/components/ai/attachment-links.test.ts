import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LINK_FRESH_MS,
  LINK_MIN_REFETCH_MS,
  createAttachmentLinkCache,
  useAttachmentLink,
} from './attachment-links';

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

type Link = { url: string; expiresAt: string };

afterEach(() => {
  vi.useRealTimers();
});

describe('createAttachmentLinkCache', () => {
  it('fetches a few links at a time and each one once', async () => {
    const pending = new Map<string, ReturnType<typeof deferred<Link>>>();
    const fetchLink = vi.fn((id: string) => {
      const next = deferred<Link>();
      pending.set(id, next);
      return next.promise;
    });
    const cache = createAttachmentLinkCache(fetchLink, { concurrency: 2, now: () => 0 });
    for (const id of ['a', 'b', 'c', 'a']) cache.request(id);
    expect(fetchLink.mock.calls.map((call) => call[0])).toEqual(['a', 'b']);
    expect(cache.get('c')).toEqual({ status: 'loading' });
    pending.get('a')?.resolve({ url: 'https://storage.test/a', expiresAt: '1970-01-01T00:02:00Z' });
    await settle();
    expect(fetchLink.mock.calls.map((call) => call[0])).toEqual(['a', 'b', 'c']);
    expect(cache.get('a')).toEqual({
      status: 'ready',
      url: 'https://storage.test/a',
      fetchedAt: 0,
      local: false,
    });
    cache.request('a');
    expect(fetchLink).toHaveBeenCalledTimes(3);
  });

  it('judges a link by when this browser fetched it, never by the server’s expiry', async () => {
    let clock = 0;
    // The server says the link expired long ago (a device clock far ahead of it).
    const fetchLink = vi.fn(async () => ({
      url: 'https://storage.test/1',
      expiresAt: '1970-01-01T00:00:00Z',
    }));
    const cache = createAttachmentLinkCache(fetchLink, { now: () => clock });
    cache.request('a');
    await settle();
    expect(cache.isFresh('a')).toBe(true);
    cache.refresh('a');
    cache.request('a');
    expect(fetchLink).toHaveBeenCalledTimes(1);
    expect(await cache.fresh('a')).toBe('https://storage.test/1');
    expect(fetchLink).toHaveBeenCalledTimes(1);
    // Old by its own clock: pointing at the file or opening it asks again.
    clock = LINK_FRESH_MS;
    expect(cache.isFresh('a')).toBe(false);
    cache.refresh('a');
    expect(fetchLink).toHaveBeenCalledTimes(2);
    await settle();
    cache.refresh('a');
    expect(fetchLink).toHaveBeenCalledTimes(2);
  });

  it('opens with a fresh link: an old one is fetched first, a fresh one is used as it is', async () => {
    let clock = 0;
    let n = 0;
    const fetchLink = vi.fn(async () => {
      n += 1;
      return { url: `https://storage.test/${n}`, expiresAt: '2026-01-01T00:00:00Z' };
    });
    const cache = createAttachmentLinkCache(fetchLink, { now: () => clock });
    expect(await cache.fresh('a')).toBe('https://storage.test/1');
    clock = LINK_FRESH_MS - 1;
    expect(await cache.fresh('a')).toBe('https://storage.test/1');
    clock = LINK_FRESH_MS + 1;
    expect(await cache.fresh('a')).toBe('https://storage.test/2');
    expect(fetchLink).toHaveBeenCalledTimes(2);
  });

  it('tries a failed link again after 30 s when pointed at, and at once on a click', async () => {
    let clock = 0;
    const fetchLink = vi
      .fn<(id: string) => Promise<Link>>()
      .mockRejectedValueOnce(new Error('gone'))
      .mockRejectedValueOnce(new Error('still gone'))
      .mockResolvedValue({ url: 'https://storage.test/ok', expiresAt: '2026-01-01T00:00:00Z' });
    const cache = createAttachmentLinkCache(fetchLink, { now: () => clock });
    cache.request('a');
    await settle();
    expect(cache.get('a')).toEqual({ status: 'failed', failedAt: 0 });
    cache.request('a');
    cache.refresh('a');
    expect(fetchLink).toHaveBeenCalledTimes(1);
    clock = LINK_MIN_REFETCH_MS;
    cache.refresh('a');
    expect(fetchLink).toHaveBeenCalledTimes(2);
    await settle();
    expect(cache.get('a')).toMatchObject({ status: 'failed' });
    // A click does not wait out the pause.
    expect(await cache.fresh('a')).toBe('https://storage.test/ok');
    expect(fetchLink).toHaveBeenCalledTimes(3);
  });

  it('keeps a link it had when asking again fails', async () => {
    let clock = 0;
    const fetchLink = vi
      .fn<(id: string) => Promise<Link>>()
      .mockResolvedValueOnce({ url: 'https://storage.test/1', expiresAt: '2026-01-01T00:00:00Z' })
      .mockRejectedValueOnce(new Error('offline'));
    const cache = createAttachmentLinkCache(fetchLink, { now: () => clock });
    cache.request('a');
    await settle();
    clock = LINK_FRESH_MS;
    cache.refresh('a');
    await settle();
    expect(cache.get('a')).toMatchObject({ status: 'ready', url: 'https://storage.test/1' });
  });

  it('owns the local preview of a sent file and revokes it when disposed, dropping late answers', async () => {
    const revoke = vi.fn();
    const late = deferred<Link>();
    const cache = createAttachmentLinkCache(() => late.promise, { revoke });
    const listener = vi.fn();
    cache.subscribe(listener);
    cache.seedLocal('a', 'blob:http://admin.test/1');
    expect(cache.get('a')).toMatchObject({ status: 'ready', url: 'blob:http://admin.test/1' });
    expect(cache.isFresh('a')).toBe(true);
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

describe('useAttachmentLink', () => {
  /** One file on screen for `forMs`, its links living `lifeMs` by the server's clock. */
  async function fetchesWhileShown(lifeMs: number, forMs: number): Promise<number> {
    vi.useFakeTimers();
    let calls = 0;
    const cache = createAttachmentLinkCache(async () => {
      calls += 1;
      return {
        url: 'https://ref.storage.supabase.co/f',
        expiresAt: new Date(Date.now() + lifeMs).toISOString(),
      };
    });
    renderHook(() => useAttachmentLink(cache, 'a', true));
    for (let elapsed = 0; elapsed < forMs; elapsed += 100) {
      await act(async () => {
        vi.advanceTimersByTime(100);
        await settle();
      });
    }
    return calls;
  }

  it('fetches one link for a file left on screen for 10 minutes', async () => {
    expect(await fetchesWhileShown(120_000, 10 * 60_000)).toBe(1);
  });

  it('does not loop when the device clock runs ahead of the server', async () => {
    // The link "expires" 30 s after the server made it, which this clock already passed.
    expect(await fetchesWhileShown(-90_000, 2_000)).toBe(1);
  });
});
