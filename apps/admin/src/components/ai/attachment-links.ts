import { useEffect, useSyncExternalStore } from 'react';

/**
 * Short-lived signed links to the member's own attached files, fetched only
 * when a message that shows them is on screen, a few at a time, and kept in
 * memory until they are about to expire. A file sent from this tab starts
 * with the local `blob:` preview of the picked file, which this cache then
 * owns and revokes. Nothing is written to any browser storage; a new cache is
 * made for each site and member, and the old one is disposed.
 */

export type AttachmentLinkEntry =
  | { status: 'loading' }
  | { status: 'ready'; url: string; expiresAt: number; local: boolean }
  | { status: 'failed' };

export interface AttachmentLinkCache {
  get(id: string): AttachmentLinkEntry | undefined;
  /** Fetches a link unless a fresh one is held or on its way. */
  request(id: string): void;
  /** The local preview of a file just sent; the cache revokes it when disposed. */
  seedLocal(id: string, url: string): void;
  subscribe(listener: () => void): () => void;
  /**
   * Forgets every link and revokes the local previews; answers already on
   * their way are dropped. The cache stays usable (React may mount the same
   * provider twice in development), so a later request simply asks again.
   */
  dispose(): void;
}

export interface AttachmentLinkCacheOptions {
  /** Links fetched at the same time. */
  concurrency?: number;
  /** A link this close to its expiry is fetched again. */
  refreshMarginMs?: number;
  now?: () => number;
  revoke?: (url: string) => void;
}

export function createAttachmentLinkCache(
  fetchLink: (id: string) => Promise<{ url: string; expiresAt: string }>,
  options: AttachmentLinkCacheOptions = {},
): AttachmentLinkCache {
  const concurrency = options.concurrency ?? 3;
  const margin = options.refreshMarginMs ?? 60_000;
  const now = options.now ?? (() => Date.now());
  const revoke =
    options.revoke ??
    ((url: string) => {
      if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
    });
  const entries = new Map<string, AttachmentLinkEntry>();
  const listeners = new Set<() => void>();
  const queue: string[] = [];
  /** Queued or being fetched, so a repeated request never asks twice. */
  const wanted = new Set<string>();
  let running = 0;
  /** Bumped by `dispose`: an answer to an older epoch is dropped. */
  let epoch = 0;

  function set(id: string, entry: AttachmentLinkEntry): void {
    entries.set(id, entry);
    for (const listener of listeners) listener();
  }

  function pump(): void {
    while (running < concurrency && queue.length > 0) {
      const id = queue.shift();
      if (id === undefined) break;
      const asked = epoch;
      running += 1;
      fetchLink(id).then(
        (link) => {
          running -= 1;
          if (asked !== epoch) return pump();
          wanted.delete(id);
          const expiresAt = Date.parse(link.expiresAt);
          set(id, {
            status: 'ready',
            url: link.url,
            expiresAt: Number.isFinite(expiresAt) ? expiresAt : now() + margin * 2,
            local: false,
          });
          pump();
        },
        () => {
          running -= 1;
          if (asked !== epoch) return pump();
          wanted.delete(id);
          // A link that worked before keeps working until it expires.
          const previous = entries.get(id);
          if (previous?.status === 'ready' && previous.expiresAt > now()) return pump();
          set(id, { status: 'failed' });
          pump();
        },
      );
    }
  }

  return {
    get: (id) => entries.get(id),
    request(id) {
      if (wanted.has(id)) return;
      const entry = entries.get(id);
      if (entry?.status === 'failed') return;
      if (entry?.status === 'ready' && (entry.local || entry.expiresAt - now() > margin)) return;
      // A link that is about to expire stays usable while the next one comes.
      if (entry === undefined) set(id, { status: 'loading' });
      wanted.add(id);
      queue.push(id);
      pump();
    },
    seedLocal(id, url) {
      const previous = entries.get(id);
      if (previous?.status === 'ready' && previous.local) revoke(previous.url);
      set(id, { status: 'ready', url, expiresAt: Number.POSITIVE_INFINITY, local: true });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      epoch += 1;
      queue.length = 0;
      wanted.clear();
      for (const entry of entries.values()) {
        if (entry.status === 'ready' && entry.local) revoke(entry.url);
      }
      entries.clear();
      for (const listener of listeners) listener();
    },
  };
}

/**
 * One file's link from the cache, asked for once `visible` is true (and again
 * when it is about to expire, so a click opens a working link).
 */
export function useAttachmentLink(
  cache: AttachmentLinkCache | undefined,
  id: string,
  visible: boolean,
): AttachmentLinkEntry | undefined {
  const entry = useSyncExternalStore(
    (listener) => cache?.subscribe(listener) ?? (() => undefined),
    () => cache?.get(id),
    () => undefined,
  );
  useEffect(() => {
    if (visible) cache?.request(id);
  }, [cache, id, visible]);
  useEffect(() => {
    if (!visible || entry?.status !== 'ready' || entry.local) return;
    const wait = Math.max(0, entry.expiresAt - Date.now() - 60_000);
    // Beyond a day a timer is pointless (and overflows); links live minutes.
    if (wait > 86_400_000) return;
    const timer = window.setTimeout(() => cache?.request(id), wait);
    return () => window.clearTimeout(timer);
  }, [cache, entry, id, visible]);
  return entry;
}
