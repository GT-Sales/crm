'use client';

import { useState } from 'react';
import { type LeadTableColumn } from '@gt-sales/contracts';
import { parseHiddenColumns, type InboxQuery } from './inbox-query';

/**
 * What the leads inbox does with its address beyond `inbox-query.ts`'s
 * parsing: keeping property params it cannot read yet, taking over the hidden
 * columns an older build kept in the browser, and the sort param's two halves.
 */

/** The URL params that name properties, with the `InboxQuery` field each one carries. */
const PROPERTY_PARAMS = [
  ['where', 'where'],
  ['cols', 'columns'],
  ['sort', 'sort'],
] as const;

/**
 * While the site's catalogue cannot be read, the built-in one cannot parse a
 * custom property's filter, column or sort; a change that does not touch
 * them keeps them as the URL had them, so a shared link loses nothing.
 */
export function keepUnreadProperties(
  search: string,
  currentUrl: string,
  patch: Partial<InboxQuery>,
): string {
  const params = new URLSearchParams(search.slice(1));
  const current = new URLSearchParams(currentUrl);
  for (const [param, field] of PROPERTY_PARAMS) {
    if (field in patch) continue;
    const raw = current.get(param) ?? (param === 'cols' ? current.get('columns') : null);
    if (raw !== null) params.set(param, raw);
  }
  const kept = params.toString();
  return kept ? `?${kept}` : '';
}

const LEGACY_HIDDEN_COLUMNS_KEY = 'gt-table-hidden-cols:';

/**
 * The hidden table columns this browser kept before they moved into the URL
 * (`?hide=`), read once and forgotten. Returns undefined when there were none.
 */
export function takeLegacyHiddenColumns(workspaceId: string): LeadTableColumn[] | undefined {
  try {
    const key = `${LEGACY_HIDDEN_COLUMNS_KEY}${workspaceId}`;
    const raw = window.localStorage.getItem(key);
    if (raw === null) return undefined;
    window.localStorage.removeItem(key);
    const saved: unknown = JSON.parse(raw);
    if (!Array.isArray(saved)) return undefined;
    const hide = parseHiddenColumns(
      saved.filter((entry): entry is string => typeof entry === 'string'),
    );
    return hide.length > 0 ? hide : undefined;
  } catch {
    return undefined;
  }
}

export const SORT_FIELDS: readonly { field: string; label: string; first: 'asc' | 'desc' }[] = [
  { field: 'fullName', label: 'Name', first: 'asc' },
  { field: 'createdAt', label: 'Created', first: 'desc' },
  { field: 'updatedAt', label: 'Last activity', first: 'desc' },
];

export function splitSort(sort: string | undefined): {
  field?: string;
  direction?: 'asc' | 'desc';
} {
  if (!sort) return {};
  const colon = sort.lastIndexOf(':');
  const direction = sort.slice(colon + 1);
  return {
    field: sort.slice(0, colon),
    direction: direction === 'asc' || direction === 'desc' ? direction : undefined,
  };
}

/**
 * The previous reference while `value` serializes the same (`undefined`
 * included), so a re-parse of the URL does not hand consumers a new array.
 */
export function useStableValue<T>(value: T): T {
  const key = JSON.stringify(value) ?? 'undefined';
  const [held, setHeld] = useState({ key, value });
  if (held.key === key) return held.value;
  setHeld({ key, value });
  return value;
}
