'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { BackendError } from './api';

/** The contract error code of a failed call, or `internal_error` for anything else. */
export function errorReason(error: unknown): string {
  return error instanceof BackendError ? error.code : 'internal_error';
}

/** The strings a failed call's `details[key]` lists (`missing` on `documents_incomplete`), or none. */
export function errorDetailList(error: unknown, key: string): readonly string[] {
  const value = error instanceof BackendError ? error.details?.[key] : undefined;
  return Array.isArray(value)
    ? value.filter((entry: unknown): entry is string => typeof entry === 'string')
    : [];
}

export interface Resource<T> {
  /** The newest answer, kept while a later load is on its way or after it fails. */
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
