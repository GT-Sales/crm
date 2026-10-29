'use client';

import { useEffect, useState } from 'react';

export const VIEW_PREF_EVENT = 'gt-sales:view-pref';

export type BoardCardField = 'contact' | 'countdown' | 'assignee' | 'timestamp';

export const BOARD_CARD_FIELDS: readonly { key: BoardCardField; label: string }[] = [
  { key: 'contact', label: 'Phone / email' },
  { key: 'countdown', label: 'Countdown date' },
  { key: 'assignee', label: 'Assignee' },
  { key: 'timestamp', label: 'Next task / created' },
];

export type TableColumnKey =
  'type' | 'stage' | 'assignee' | 'nextTask' | 'countdown' | 'source' | 'created' | 'activity';

export const TABLE_COLUMNS: readonly { key: TableColumnKey; label: string }[] = [
  { key: 'type', label: 'Type' },
  { key: 'stage', label: 'Stage' },
  { key: 'assignee', label: 'Assignee' },
  { key: 'nextTask', label: 'Next task' },
  { key: 'countdown', label: 'Countdown date' },
  { key: 'source', label: 'Source' },
  { key: 'created', label: 'Created' },
  { key: 'activity', label: 'Last activity' },
];

function readStoredList(key: string): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(key) ?? '[]');
    return Array.isArray(saved)
      ? saved.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

/**
 * A list of strings kept in this browser's storage (a personal view preference,
 * not shared with other staff) and synchronized across components on the same page.
 */
export function useStoredList(key: string): [string[], (next: string[]) => void] {
  const [list, setList] = useState<string[]>([]);
  useEffect(() => {
    setList(readStoredList(key));
    function onChange(event: Event) {
      if (event instanceof CustomEvent && event.detail === key) {
        setList(readStoredList(key));
      }
    }
    window.addEventListener(VIEW_PREF_EVENT, onChange);
    return () => window.removeEventListener(VIEW_PREF_EVENT, onChange);
  }, [key]);
  function save(next: string[]) {
    setList(next);
    try {
      window.localStorage.setItem(key, JSON.stringify(next));
      window.dispatchEvent(new CustomEvent(VIEW_PREF_EVENT, { detail: key }));
    } catch {
      // Not persisted.
    }
  }
  return [list, save];
}
