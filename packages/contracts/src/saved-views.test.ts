import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LEAD_VIEW_STATE,
  LEAD_TABLE_COLUMNS,
  SAVED_VIEW_LIMIT,
  buildPropertyCatalog,
  cleanSavedViewState,
  createSavedViewRequestSchema,
  listSavedViewsQuerySchema,
  propertyRowSchema,
  savedViewNameSchema,
  savedViewSchema,
  savedViewStateSchema,
  updateSavedViewRequestSchema,
  type PropertyRow,
  type SavedViewState,
} from './index';

const STAMP = '2026-10-29T12:00:00.000Z';

function row(overrides: Partial<PropertyRow> & Pick<PropertyRow, 'key' | 'origin'>): PropertyRow {
  return propertyRowSchema.parse({
    object: 'lead',
    label: 'City',
    kind: 'text',
    options: [],
    staffOnly: false,
    sensitive: false,
    hidden: false,
    leadTypes: [],
    position: 0,
    version: 1,
    createdAt: STAMP,
    updatedAt: STAMP,
    ...overrides,
  });
}

const VIEW_ID = '3f0c6a52-1f0e-4b6e-9d0e-6f2a7f5f1c11';

describe('saved view state', () => {
  it('accepts the default state and a full state', () => {
    expect(savedViewStateSchema.safeParse(DEFAULT_LEAD_VIEW_STATE).success).toBe(true);
    const full: SavedViewState = {
      layout: 'board',
      leadType: 'internet',
      archived: false,
      stage: 'contacted',
      assignee: 'me',
      due: true,
      where: [{ key: 'postalCode', op: 'notEmpty' }],
      sort: 'createdAt:desc',
      columns: ['postalCode'],
      hiddenColumns: ['source'],
    };
    expect(savedViewStateSchema.safeParse(full).success).toBe(true);
  });

  it('renames a stored legacy trash key to archived, never keeping both', () => {
    const { archived: _archived, ...legacy } = DEFAULT_LEAD_VIEW_STATE;
    const parsed = savedViewStateSchema.parse({ ...legacy, trash: true });
    expect(parsed.archived).toBe(true);
    expect(parsed).not.toHaveProperty('trash');
    expect(savedViewStateSchema.parse({ ...legacy, trash: false }).archived).toBe(false);
  });

  it('keeps archived when a state carries both keys, and still rejects unknown keys', () => {
    const both = savedViewStateSchema.parse({
      ...DEFAULT_LEAD_VIEW_STATE,
      archived: false,
      trash: true,
    });
    expect(both.archived).toBe(false);
    expect(both).not.toHaveProperty('trash');
    expect(savedViewStateSchema.safeParse({ ...DEFAULT_LEAD_VIEW_STATE, other: 1 }).success).toBe(
      false,
    );
  });

  it('never accepts free-text search or a page', () => {
    expect(savedViewStateSchema.safeParse({ ...DEFAULT_LEAD_VIEW_STATE, q: 'ann' }).success).toBe(
      false,
    );
    expect(savedViewStateSchema.safeParse({ ...DEFAULT_LEAD_VIEW_STATE, page: 2 }).success).toBe(
      false,
    );
  });

  it('limits columns to six and hidden columns to the table columns', () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f'];
    expect(
      savedViewStateSchema.safeParse({ ...DEFAULT_LEAD_VIEW_STATE, columns: six }).success,
    ).toBe(true);
    expect(
      savedViewStateSchema.safeParse({ ...DEFAULT_LEAD_VIEW_STATE, columns: [...six, 'g'] })
        .success,
    ).toBe(false);
    expect(
      savedViewStateSchema.safeParse({ ...DEFAULT_LEAD_VIEW_STATE, hiddenColumns: ['nope'] })
        .success,
    ).toBe(false);
  });

  it('lists the table columns the admin shows', () => {
    expect([...LEAD_TABLE_COLUMNS]).toEqual([
      'type',
      'stage',
      'assignee',
      'nextTask',
      'countdown',
      'source',
      'created',
      'activity',
    ]);
  });
});

describe('saved view requests', () => {
  it('defaults the object to lead and trims the name', () => {
    expect(listSavedViewsQuerySchema.parse({}).object).toBe('lead');
    const created = createSavedViewRequestSchema.parse({
      name: '  Hot leads  ',
      state: DEFAULT_LEAD_VIEW_STATE,
    });
    expect(created.object).toBe('lead');
    expect(created.name).toBe('Hot leads');
    expect(savedViewNameSchema.safeParse('   ').success).toBe(false);
    expect(savedViewNameSchema.safeParse('x'.repeat(61)).success).toBe(false);
  });

  it('an update must change the name or the state', () => {
    expect(updateSavedViewRequestSchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(updateSavedViewRequestSchema.safeParse({ expectedVersion: 1, name: 'A' }).success).toBe(
      true,
    );
    expect(
      updateSavedViewRequestSchema.safeParse({
        expectedVersion: 1,
        state: DEFAULT_LEAD_VIEW_STATE,
      }).success,
    ).toBe(true);
    expect(updateSavedViewRequestSchema.safeParse({ name: 'A' }).success).toBe(false);
  });

  it('parses a stored view and exposes the per-user limit', () => {
    expect(SAVED_VIEW_LIMIT).toBe(30);
    expect(
      savedViewSchema.safeParse({
        id: VIEW_ID,
        object: 'lead',
        name: 'Hot',
        state: DEFAULT_LEAD_VIEW_STATE,
        version: 1,
        updatedAt: STAMP,
      }).success,
    ).toBe(true);
  });
});

describe('cleanSavedViewState', () => {
  it('drops unknown, hidden and sensitive keys and keeps the rest', () => {
    const catalog = buildPropertyCatalog([row({ key: 'city', origin: 'builtin', hidden: true })]);
    const cleaned = cleanSavedViewState(
      {
        ...DEFAULT_LEAD_VIEW_STATE,
        leadType: 'internet',
        where: [
          { key: 'city', op: 'eq', value: 'Ottawa' },
          { key: 'postalCode', op: 'notEmpty' },
        ],
        columns: ['dateOfBirth', 'postalCode', 'nope'],
        sort: 'prop.city:asc',
      },
      catalog,
    );
    expect(cleaned.where).toEqual([{ key: 'postalCode', op: 'notEmpty' }]);
    expect(cleaned.columns).toEqual(['postalCode']);
    expect(cleaned.sort).toBeUndefined();
  });

  it('keeps a built-in sort and a sort on a known property', () => {
    const catalog = buildPropertyCatalog([]);
    const builtin = cleanSavedViewState(
      { ...DEFAULT_LEAD_VIEW_STATE, sort: 'createdAt:desc' },
      catalog,
    );
    expect(builtin.sort).toBe('createdAt:desc');
    const known = cleanSavedViewState(
      { ...DEFAULT_LEAD_VIEW_STATE, leadType: 'internet', sort: 'prop.postalCode:asc' },
      catalog,
    );
    expect(known.sort).toBe('prop.postalCode:asc');
  });

  it('drops a stage the lead type does not have and leaves assignee, due, archived and layout alone', () => {
    const catalog = buildPropertyCatalog([]);
    const state: SavedViewState = {
      ...DEFAULT_LEAD_VIEW_STATE,
      layout: 'board',
      leadType: 'internet',
      stage: 'not_a_stage',
      assignee: 'none',
      due: true,
      archived: true,
    };
    const cleaned = cleanSavedViewState(state, catalog);
    expect(cleaned.stage).toBeUndefined();
    expect(cleaned).toMatchObject({ layout: 'board', assignee: 'none', due: true, archived: true });
    expect(cleanSavedViewState({ ...state, stage: 'contacted' }, catalog).stage).toBe('contacted');
  });

  it('is pure: the input is not changed', () => {
    const catalog = buildPropertyCatalog([]);
    const state: SavedViewState = { ...DEFAULT_LEAD_VIEW_STATE, columns: ['nope'] };
    cleanSavedViewState(state, catalog);
    expect(state.columns).toEqual(['nope']);
  });
});
