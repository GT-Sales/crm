import {
  DEFAULT_LEAD_VIEW_STATE,
  savedViewStateSchema,
  type SavedViewState,
} from '@gt-sales/contracts';
import { describe, expect, it } from 'vitest';

import { inboxSearch, parseInboxQuery, type InboxQuery } from './inbox-query';
import {
  allLeadsQuery,
  inboxQueryToViewState,
  isViewDirty,
  viewStateToInboxQuery,
} from './view-state';

const VIEW_ID = '40000000-0000-4000-8000-000000000001';

const FULL_STATE: SavedViewState = {
  layout: 'table',
  leadType: 'sim_order',
  trash: false,
  stage: 'pending',
  assignee: 'me',
  due: false,
  where: [
    { key: 'permitType', op: 'eq', value: 'student' },
    { key: 'arrivalDate', op: 'notEmpty' },
  ],
  sort: 'prop.arrivalDate:asc',
  columns: ['permitType', 'arrivalDate'],
  hiddenColumns: ['source', 'created'],
};

function fullQuery(): InboxQuery {
  return {
    type: 'internet',
    trash: false,
    layout: 'table',
    view: VIEW_ID,
    stage: 'contacted',
    assignee: 'me',
    q: 'blake',
    where: [{ key: 'city', op: 'eq', value: 'Calgary' }],
    sort: 'prop.arrivalDate:asc',
    columns: ['city', 'arrivalDate'],
    hide: ['source', 'created'],
    due: false,
    page: 3,
  };
}

describe('inboxQueryToViewState', () => {
  it('keeps the filters, sort and columns, and drops the search, page and view', () => {
    const state = inboxQueryToViewState(fullQuery());
    expect(state).toEqual({
      layout: 'table',
      leadType: 'internet',
      trash: false,
      stage: 'contacted',
      assignee: 'me',
      due: false,
      where: [{ key: 'city', op: 'eq', value: 'Calgary' }],
      sort: 'prop.arrivalDate:asc',
      columns: ['city', 'arrivalDate'],
      hiddenColumns: ['source', 'created'],
    });
    expect(Object.keys(state)).not.toContain('q');
    expect(Object.keys(state)).not.toContain('page');
    expect(Object.keys(state)).not.toContain('view');
    expect(savedViewStateSchema.safeParse(state).success).toBe(true);
  });

  it('turns the default inbox into the default view state', () => {
    const query = parseInboxQuery(new URLSearchParams(''));
    expect(inboxQueryToViewState(query)).toEqual(DEFAULT_LEAD_VIEW_STATE);
  });
});

describe('viewStateToInboxQuery', () => {
  it('opens on page one, without a search, on the named view', () => {
    const query = viewStateToInboxQuery(FULL_STATE, VIEW_ID);
    expect(query).toMatchObject({
      type: 'sim_order',
      view: VIEW_ID,
      page: 1,
      layout: 'table',
      hide: ['source', 'created'],
      columns: ['permitType', 'arrivalDate'],
    });
    expect(query.q).toBeUndefined();
  });

  it('round-trips a full state through the URL', () => {
    const query = viewStateToInboxQuery(FULL_STATE, VIEW_ID);
    const reparsed = parseInboxQuery(new URLSearchParams(inboxSearch(query).slice(1)));
    expect(reparsed.view).toBe(VIEW_ID);
    expect(inboxQueryToViewState(reparsed)).toEqual(FULL_STATE);
  });

  it('round-trips a board view and a trash view', () => {
    const board: SavedViewState = {
      ...DEFAULT_LEAD_VIEW_STATE,
      layout: 'board',
      leadType: 'internet',
    };
    const boardQuery = parseInboxQuery(
      new URLSearchParams(inboxSearch(viewStateToInboxQuery(board, VIEW_ID)).slice(1)),
    );
    expect(inboxQueryToViewState(boardQuery)).toEqual(board);

    const trash: SavedViewState = { ...DEFAULT_LEAD_VIEW_STATE, trash: true };
    const trashQuery = parseInboxQuery(
      new URLSearchParams(inboxSearch(viewStateToInboxQuery(trash, VIEW_ID)).slice(1)),
    );
    expect(inboxQueryToViewState(trashQuery)).toEqual(trash);
  });

  it('never carries a search, even from a state that came from a query that had one', () => {
    const state = inboxQueryToViewState(fullQuery());
    expect(inboxSearch(viewStateToInboxQuery(state, VIEW_ID))).not.toContain('q=');
  });
});

describe('allLeadsQuery', () => {
  it('is the default view state with no view id', () => {
    const query = allLeadsQuery();
    expect(query.view).toBeUndefined();
    expect(inboxSearch(query)).toBe('');
    expect(inboxQueryToViewState(query)).toEqual(DEFAULT_LEAD_VIEW_STATE);
  });
});

describe('isViewDirty', () => {
  it('is clean for equal states', () => {
    expect(isViewDirty(FULL_STATE, { ...FULL_STATE })).toBe(false);
    expect(isViewDirty(DEFAULT_LEAD_VIEW_STATE, DEFAULT_LEAD_VIEW_STATE)).toBe(false);
  });

  it('ignores the order of the hidden columns', () => {
    expect(isViewDirty(FULL_STATE, { ...FULL_STATE, hiddenColumns: ['created', 'source'] })).toBe(
      false,
    );
    expect(isViewDirty(FULL_STATE, { ...FULL_STATE, hiddenColumns: ['created'] })).toBe(true);
  });

  it('cares about the order of the property columns', () => {
    expect(isViewDirty(FULL_STATE, { ...FULL_STATE, columns: ['arrivalDate', 'permitType'] })).toBe(
      true,
    );
  });

  it('cares about the order of the filters', () => {
    expect(isViewDirty(FULL_STATE, { ...FULL_STATE, where: [...FULL_STATE.where].reverse() })).toBe(
      true,
    );
  });

  it('notices a changed filter value, sort, stage, assignee, layout, due, trash and type', () => {
    const [first, second] = FULL_STATE.where;
    if (!first || !second) throw new Error('fixture');
    expect(
      isViewDirty(FULL_STATE, {
        ...FULL_STATE,
        where: [{ key: 'permitType', op: 'eq', value: 'work' }, second],
      }),
    ).toBe(true);
    expect(isViewDirty(FULL_STATE, { ...FULL_STATE, sort: 'createdAt:desc' })).toBe(true);
    expect(isViewDirty(FULL_STATE, { ...FULL_STATE, stage: 'won' })).toBe(true);
    expect(isViewDirty(FULL_STATE, { ...FULL_STATE, assignee: 'none' })).toBe(true);
    expect(isViewDirty(FULL_STATE, { ...FULL_STATE, layout: 'board' })).toBe(true);
    expect(isViewDirty(FULL_STATE, { ...FULL_STATE, due: true })).toBe(true);
    expect(isViewDirty(FULL_STATE, { ...FULL_STATE, trash: true })).toBe(true);
    expect(isViewDirty(FULL_STATE, { ...FULL_STATE, leadType: 'mobility' })).toBe(true);
  });

  it('treats a missing optional field and an explicitly undefined one alike', () => {
    expect(
      isViewDirty(DEFAULT_LEAD_VIEW_STATE, { ...DEFAULT_LEAD_VIEW_STATE, sort: undefined }),
    ).toBe(false);
  });

  it('compares list values of filters by content', () => {
    const base: SavedViewState = {
      ...DEFAULT_LEAD_VIEW_STATE,
      where: [{ key: 'permitType', op: 'in', value: ['student', 'work'] }],
    };
    const same: SavedViewState = {
      ...DEFAULT_LEAD_VIEW_STATE,
      where: [{ key: 'permitType', op: 'in', value: ['student', 'work'] }],
    };
    expect(isViewDirty(base, same)).toBe(false);
    expect(
      isViewDirty(base, {
        ...DEFAULT_LEAD_VIEW_STATE,
        where: [{ key: 'permitType', op: 'in', value: ['student'] }],
      }),
    ).toBe(true);
  });
});
