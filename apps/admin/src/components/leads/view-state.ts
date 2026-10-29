import {
  cleanSavedViewState,
  codePropertyCatalog,
  DEFAULT_LEAD_VIEW_STATE,
  type LeadPropertyFilter,
  type PropertyCatalog,
  type SavedViewState,
} from '@gt-sales/contracts';

import { inboxSearch, parseHiddenColumns, parseInboxQuery, type InboxQuery } from './inbox-query';

/**
 * A saved view is the inbox's URL state without the free-text search, the page
 * and the view id: the search is never saved and opening a view always starts
 * on page one. The mapping is pure so the inbox, the switcher and the tests
 * share it.
 */

/** What the inbox shows now as a saved view's state; drops `q`, `page` and `view`. */
export function inboxQueryToViewState(query: InboxQuery): SavedViewState {
  return {
    layout: query.layout,
    ...(query.type ? { leadType: query.type } : {}),
    trash: query.trash,
    ...(query.stage ? { stage: query.stage } : {}),
    ...(query.assignee ? { assignee: query.assignee } : {}),
    due: query.due,
    where: [...(query.where ?? [])],
    ...(query.sort ? { sort: query.sort } : {}),
    columns: [...(query.columns ?? [])],
    hiddenColumns: parseHiddenColumns(query.hide),
  };
}

function queryFromState(state: SavedViewState, view: string | undefined): InboxQuery {
  return {
    ...(state.leadType ? { type: state.leadType } : {}),
    trash: state.trash,
    layout: state.layout,
    ...(view ? { view } : {}),
    ...(state.stage ? { stage: state.stage } : {}),
    ...(state.assignee ? { assignee: state.assignee } : {}),
    where: state.where.length > 0 ? state.where : undefined,
    ...(state.sort ? { sort: state.sort } : {}),
    columns: state.columns.length > 0 ? state.columns : undefined,
    hide: parseHiddenColumns(state.hiddenColumns),
    due: state.due,
    page: 1,
  };
}

/** The inbox query that opens a saved view: its state on page one, no search, `view=<id>`. */
export function viewStateToInboxQuery(state: SavedViewState, viewId: string): InboxQuery {
  return queryFromState(state, viewId);
}

/** "All leads": the unsaved default, with no view id. */
export function allLeadsQuery(): InboxQuery {
  return queryFromState(DEFAULT_LEAD_VIEW_STATE, undefined);
}

/**
 * A saved state as the inbox would show it today: filters the site no longer
 * has dropped (`cleanSavedViewState`) and the rest read the way the URL is
 * read (a board without a type is a table). The dirty dot compares against
 * this, so a stale view does not open already "changed".
 */
export function appliedViewState(
  state: SavedViewState,
  catalog: PropertyCatalog = codePropertyCatalog,
): SavedViewState {
  const query = viewStateToInboxQuery(cleanSavedViewState(state, catalog), '');
  return inboxQueryToViewState(
    parseInboxQuery(new URLSearchParams(inboxSearch(query).slice(1)), catalog),
  );
}

function sameFilter(a: LeadPropertyFilter, b: LeadPropertyFilter): boolean {
  return a.key === b.key && a.op === b.op && JSON.stringify(a.value) === JSON.stringify(b.value);
}

function sameList<T>(a: readonly T[], b: readonly T[], same: (x: T, y: T) => boolean): boolean {
  return (
    a.length === b.length &&
    a.every((item, index) => {
      const other = b[index];
      return other !== undefined && same(item, other);
    })
  );
}

/**
 * Whether the inbox differs from the saved state. The hidden columns are a
 * set (their order is the table's); the property columns and the filters are
 * ordered lists, since the order is what staff see.
 */
export function isViewDirty(saved: SavedViewState, current: SavedViewState): boolean {
  const savedHidden = new Set(saved.hiddenColumns);
  const sameHidden =
    savedHidden.size === new Set(current.hiddenColumns).size &&
    current.hiddenColumns.every((column) => savedHidden.has(column));
  return !(
    saved.layout === current.layout &&
    saved.leadType === current.leadType &&
    saved.trash === current.trash &&
    saved.stage === current.stage &&
    saved.assignee === current.assignee &&
    saved.due === current.due &&
    saved.sort === current.sort &&
    sameHidden &&
    sameList(saved.columns, current.columns, (x, y) => x === y) &&
    sameList(saved.where, current.where, sameFilter)
  );
}
