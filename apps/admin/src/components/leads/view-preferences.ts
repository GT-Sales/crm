'use client';

import { LEAD_TABLE_COLUMNS, type LeadTableColumn } from '@gt-sales/contracts';
import { useEffect, useRef, useState } from 'react';

export const VIEW_PREF_EVENT = 'gt-sales:view-pref';

export type BoardCardField = 'contact' | 'countdown' | 'assignee' | 'timestamp';

export const BOARD_CARD_FIELDS: readonly { key: BoardCardField; label: string }[] = [
  { key: 'contact', label: 'Phone / email' },
  { key: 'countdown', label: 'Countdown date' },
  { key: 'assignee', label: 'Assignee' },
  { key: 'timestamp', label: 'Next task / created' },
];

/**
 * The optional table columns; the ids live in the contracts so saved views
 * share them. Which are hidden is in the URL (`?hide=`, `InboxQuery.hide`);
 * this browser's storage keeps only the board's preferences.
 */
export type TableColumnKey = LeadTableColumn;

const TABLE_COLUMN_LABELS: Record<TableColumnKey, string> = {
  type: 'Type',
  stage: 'Stage',
  assignee: 'Assignee',
  nextTask: 'Next task',
  countdown: 'Countdown date',
  source: 'Source',
  created: 'Created',
  activity: 'Last activity',
};

export const TABLE_COLUMNS: readonly { key: TableColumnKey; label: string }[] =
  LEAD_TABLE_COLUMNS.map((key) => ({ key, label: TABLE_COLUMN_LABELS[key] }));

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

function readStoredChoice<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const saved = window.localStorage.getItem(key);
    return allowed.find((entry) => entry === saved) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * One of a few choices kept in this browser's storage (a personal view
 * preference, such as the Tasks page's List or Board). Storage that throws or
 * holds something else reads as `fallback`; a save that cannot persist still
 * changes the choice for this page.
 */
export function useStoredChoice<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): [T, (next: T) => void] {
  const [choice, setChoice] = useState<T>(fallback);
  // `allowed` is a constant list at every call site; a ref keeps a list
  // written inline from re-running the read on each render.
  const allowedRef = useRef(allowed);
  allowedRef.current = allowed;
  useEffect(() => {
    setChoice(readStoredChoice(key, allowedRef.current, fallback));
  }, [key, fallback]);
  function save(next: T) {
    setChoice(next);
    try {
      window.localStorage.setItem(key, next);
    } catch {
      // Not persisted.
    }
  }
  return [choice, save];
}
