import { useEffect, useSyncExternalStore } from 'react';

/**
 * Short-lived signed links to the member's own attached files. A link is
 * fetched once, when a message that shows the file first comes on screen, a
 * few at a time, and kept in memory: a thumbnail keeps showing the picture it
 * already loaded however old its link is. Only opening a file needs a link
 * that still works, so hovering, focusing or clicking a file whose link is
 * old asks for a fresh one, and a click on an old link waits for it.
 *
 * How old a link is comes from this browser's own clock (when it was fetched),
 * never from comparing the server's `expiresAt` with `Date.now()`: a device
 * clock that runs ahead of the server would otherwise see every link as
 * expired and ask again forever. No link is asked for twice within 30
 * seconds, and a failed one is tried again only after 30 seconds, when the
 * member points at the file. A file sent from this tab starts with the local
 * `blob:` preview of the picked file, which this cache owns and revokes.
 * Nothing is written to any browser storage.
 */

export type AttachmentLinkEntry =
  | { status: 'loading' }
  | { status: 'ready'; url: string; fetchedAt: number; local: boolean }
  | { status: 'failed'; failedAt: number };

export interface AttachmentLinkCache {
  get(id: string): AttachmentLinkEntry | undefined;
  /** The file came on screen: fetches a link unless one is held or on its way. */
  request(id: string): void;
  /** The member points at the file (hover, focus): an old or failed link is asked for again. */
  refresh(id: string): void;
  /** A link to open now: the held one while it is fresh, else a new one (undefined if none can be had). */
  fresh(id: string): Promise<string | undefined>;
  /** Whether the held link may be opened as it is. */
  isFresh(id: string): boolean;
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

/** A link is used to open a file for this long after it was fetched (the server's live 120 s). */
export const LINK_FRESH_MS = 60_000;
/** No link is asked for again sooner than this, and a failed one waits this long. */
export const LINK_MIN_REFETCH_MS = 30_000;

export interface AttachmentLinkCacheOptions {
  /** Links fetched at the same time. */
  concurrency?: number;
  now?: () => number;
  revoke?: (url: string) => void;
}

export function createAttachmentLinkCache(
  fetchLink: (id: string) => Promise<{ url: string; expiresAt: string }>,
  options: AttachmentLinkCacheOptions = {},
): AttachmentLinkCache {
  const concurrency = options.concurrency ?? 3;
  const now = options.now ?? (() => Date.now());
  const revoke =
    options.revoke ??
    ((url: string) => {
      if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
    });
  const entries = new Map<string, AttachmentLinkEntry>();
  const listeners = new Set<() => void>();
  const queue: string[] = [];
  /** Queued or being fetched, with what waits for the answer. */
  const wanted = new Map<string, ((url: string | undefined) => void)[]>();
  let running = 0;
  /** Bumped by `dispose`: an answer to an older epoch is dropped. */
  let epoch = 0;

  function set(id: string, entry: AttachmentLinkEntry): void {
    entries.set(id, entry);
    for (const listener of listeners) listener();
  }

  function settle(id: string, url: string | undefined): void {
    const waiting = wanted.get(id) ?? [];
    wanted.delete(id);
    for (const resolve of waiting) resolve(url);
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
          if (asked === epoch) {
            set(id, { status: 'ready', url: link.url, fetchedAt: now(), local: false });
            settle(id, link.url);
          }
          pump();
        },
        () => {
          running -= 1;
          if (asked === epoch) {
            // A link that was had before keeps its picture; the next attempt waits.
            const previous = entries.get(id);
            if (previous?.status !== 'ready') set(id, { status: 'failed', failedAt: now() });
            settle(id, previous?.status === 'ready' ? previous.url : undefined);
          }
          pump();
        },
      );
    }
  }

  function ask(id: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      const waiting = wanted.get(id);
      if (waiting !== undefined) {
        waiting.push(resolve);
        return;
      }
      wanted.set(id, [resolve]);
      if (entries.get(id) === undefined || entries.get(id)?.status === 'failed') {
        set(id, { status: 'loading' });
      }
      queue.push(id);
      pump();
    });
  }

  /** Whether a new fetch is allowed now: never twice within 30 s. */
  function mayAsk(entry: AttachmentLinkEntry | undefined, staleAfter: number): boolean {
    if (entry === undefined) return true;
    if (entry.status === 'loading') return false;
    if (entry.status === 'failed') return now() - entry.failedAt >= LINK_MIN_REFETCH_MS;
    if (entry.local) return false;
    return now() - entry.fetchedAt >= Math.max(staleAfter, LINK_MIN_REFETCH_MS);
  }

  return {
    get: (id) => entries.get(id),
    request(id) {
      if (wanted.has(id)) return;
      const entry = entries.get(id);
      // On screen again does not refresh a held link: the picture is already there.
      if (entry?.status === 'ready') return;
      if (mayAsk(entry, LINK_FRESH_MS)) void ask(id);
    },
    refresh(id) {
      if (wanted.has(id)) return;
      if (mayAsk(entries.get(id), LINK_FRESH_MS)) void ask(id);
    },
    isFresh(id) {
      const entry = entries.get(id);
      return entry?.status === 'ready' && (entry.local || now() - entry.fetchedAt < LINK_FRESH_MS);
    },
    async fresh(id) {
      const entry = entries.get(id);
      if (entry?.status === 'ready' && this.isFresh(id)) return entry.url;
      // A click asks at once, even for a link that failed a moment ago.
      return ask(id);
    },
    seedLocal(id, url) {
      const previous = entries.get(id);
      if (previous?.status === 'ready' && previous.local) revoke(previous.url);
      set(id, { status: 'ready', url, fetchedAt: now(), local: true });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      epoch += 1;
      queue.length = 0;
      for (const id of [...wanted.keys()]) settle(id, undefined);
      for (const entry of entries.values()) {
        if (entry.status === 'ready' && entry.local) revoke(entry.url);
      }
      entries.clear();
      for (const listener of listeners) listener();
    },
  };
}

/** One file's link from the cache, asked for once, when `visible` first turns true. */
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
  return entry;
}
