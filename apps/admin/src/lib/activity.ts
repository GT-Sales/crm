/**
 * What the top loading bar watches: backend requests in flight and page
 * navigations. A tiny counter with subscribers, no React, so the API client
 * can report requests without knowing about the bar.
 */

type Listener = (busy: boolean) => void;

let pending = 0;
const listeners = new Set<Listener>();

function notify(): void {
  const busy = pending > 0;
  for (const listener of listeners) listener(busy);
}

/** Marks one piece of work as started; call the returned function once when it ends. */
export function beginActivity(): () => void {
  pending += 1;
  notify();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    pending = Math.max(0, pending - 1);
    notify();
  };
}

export function isBusy(): boolean {
  return pending > 0;
}

export function subscribeActivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * `fetch` that counts as activity until the response headers arrive (or it
 * fails). A streamed body is not waited for. Ask AI messages do not use this
 * at all (lib/api.ts): the panel shows its own "thinking" line instead.
 */
export const trackedFetch: typeof fetch = async (input, init) => {
  const end = beginActivity();
  try {
    return await globalThis.fetch(input, init);
  } finally {
    end();
  }
};

/** Test helper: forget all counted work and listeners. */
export function resetActivityForTests(): void {
  pending = 0;
  listeners.clear();
}
