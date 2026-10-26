'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { BackendError } from './api';

/** The contract error code of a failed call, or `internal_error` for anything else. */
export function errorReason(error: unknown): string {
  return error instanceof BackendError ? error.code : 'internal_error';
}

export interface Resource<T> {
  data: T | undefined;
  /** The failed load's error code; cleared by the next load. */
  error: string | undefined;
  loading: boolean;
  reload(): Promise<void>;
  /** Replace the loaded value in place, for an optimistic or a server-confirmed change. */
  mutate(update: (current: T) => T): void;
}

/**
 * Loads `load()` whenever it changes (memoise it with `useCallback`), keeping
 * only the newest answer: a slow response to an earlier filter can never
 * overwrite a newer one. `undefined` (no session or site yet) loads nothing.
 */
export function useResource<T>(load: (() => Promise<T>) | undefined): Resource<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const version = useRef(0);

  const reload = useCallback(async () => {
    if (!load) return;
    const current = ++version.current;
    setLoading(true);
    setError(undefined);
    try {
      const result = await load();
      if (version.current !== current) return;
      setData(result);
    } catch (caught) {
      if (version.current !== current) return;
      setError(errorReason(caught));
    } finally {
      if (version.current === current) setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    void reload();
    return () => {
      version.current += 1;
    };
  }, [reload]);

  const mutate = useCallback((update: (current: T) => T) => {
    setData((current) => (current === undefined ? current : update(current)));
  }, []);

  return { data, error, loading, reload, mutate };
}
