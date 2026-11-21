/**
 * Hands a lead search from one screen to the leads inbox without putting it
 * in a URL. A search is a customer's name, email or phone, and an address is
 * copied, bookmarked and kept in history (issue #83), so the term is held in
 * memory for the one navigation: a reload or a new tab starts with no search.
 */
export const LEAD_SEARCH_OPENED = 'crm:lead-search-opened';

let pending: string | undefined;

/** Called by the link that opens the inbox on a search (Ctrl/Cmd K's "See all matches"). */
export function openLeadSearch(term: string): void {
  pending = term;
  window.dispatchEvent(new Event(LEAD_SEARCH_OPENED));
}

/** The search waiting for the inbox, left in place: safe to read while rendering. */
export function peekLeadSearch(): string | undefined {
  return pending;
}

/** The search waiting for the inbox, taken: the next inbox opens without it. */
export function takeLeadSearch(): string | undefined {
  const term = pending;
  pending = undefined;
  return term;
}
