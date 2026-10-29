import { describe, expect, it } from 'vitest';

import {
  applyCustomValueEdits,
  buildPropertyCatalog,
  leadActivitySchema,
  propertyRowSchema,
  type PropertyRow,
  type SiteProperty,
} from './index';

const STAMP = '2026-10-29T12:00:00.000Z';

function custom(overrides: Partial<PropertyRow> & Pick<PropertyRow, 'key'>): PropertyRow {
  return propertyRowSchema.parse({
    object: 'lead',
    origin: 'custom',
    label: 'X',
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

const catalog = buildPropertyCatalog([
  custom({ key: 'custom_ref', kind: 'text', position: 0 }),
  custom({ key: 'custom_amount', kind: 'money', position: 1 }),
  custom({ key: 'custom_score', kind: 'number', position: 2 }),
  custom({ key: 'custom_paid', kind: 'yesNo', position: 3 }),
  custom({
    key: 'custom_tier',
    kind: 'choice',
    position: 4,
    options: [
      { value: 'gold', label: 'Gold', hidden: false },
      { value: 'silver', label: 'Silver', hidden: false },
      { value: 'bronze', label: 'Bronze', hidden: true },
    ],
  }),
  custom({ key: 'custom_gone', kind: 'text', position: 5, hidden: true }),
  custom({ key: 'custom_net', kind: 'text', position: 6, leadTypes: ['internet'] }),
]);

const simProperties: readonly SiteProperty[] = catalog.forType('sim_order');

describe('applyCustomValueEdits', () => {
  it('sets values in their stored form and names only the keys that changed', () => {
    const result = applyCustomValueEdits({
      properties: simProperties,
      current: { custom_ref: 'A-1', custom_paid: true },
      edits: { custom_ref: '  B-2  ', custom_amount: 1999, custom_paid: true },
    });
    expect(result).toEqual({
      ok: true,
      values: { custom_ref: 'B-2', custom_amount: 1999, custom_paid: true },
      changedKeys: ['custom_ref', 'custom_amount'],
    });
  });

  it('clears a value with null, removing the key, and ignores clearing what is not there', () => {
    const result = applyCustomValueEdits({
      properties: simProperties,
      current: { custom_ref: 'A-1', custom_score: 3 },
      edits: { custom_ref: null, custom_amount: null },
    });
    expect(result).toEqual({ ok: true, values: { custom_score: 3 }, changedKeys: ['custom_ref'] });
  });

  it('refuses an empty string, which is not a way to clear', () => {
    expect(
      applyCustomValueEdits({
        properties: simProperties,
        current: { custom_ref: 'A-1' },
        edits: { custom_ref: '' },
      }),
    ).toEqual({ ok: false, field: 'custom_ref' });
    expect(
      applyCustomValueEdits({
        properties: simProperties,
        current: {},
        edits: { custom_ref: '   ' },
      }),
    ).toEqual({ ok: false, field: 'custom_ref' });
  });

  it('keeps a hidden choice option only when it is the unchanged current value', () => {
    expect(
      applyCustomValueEdits({
        properties: simProperties,
        current: { custom_tier: 'bronze' },
        edits: { custom_tier: 'bronze' },
      }),
    ).toEqual({ ok: true, values: { custom_tier: 'bronze' }, changedKeys: [] });
    expect(
      applyCustomValueEdits({
        properties: simProperties,
        current: { custom_tier: 'gold' },
        edits: { custom_tier: 'bronze' },
      }),
    ).toEqual({ ok: false, field: 'custom_tier' });
    expect(
      applyCustomValueEdits({
        properties: simProperties,
        current: { custom_tier: 'bronze' },
        edits: { custom_tier: 'silver' },
      }),
    ).toEqual({ ok: true, values: { custom_tier: 'silver' }, changedKeys: ['custom_tier'] });
  });

  it('refuses a value of the wrong kind, naming the field and never the value', () => {
    for (const [key, value] of [
      ['custom_amount', 19.99],
      ['custom_amount', '1999'],
      ['custom_score', 1e13],
      ['custom_paid', 'yes'],
      ['custom_tier', 'platinum'],
      ['custom_ref', 5],
    ] as const) {
      const result = applyCustomValueEdits({
        properties: simProperties,
        current: {},
        edits: { [key]: value },
      });
      expect(result).toEqual({ ok: false, field: key });
      expect(JSON.stringify(result)).not.toContain(String(value));
    }
  });

  it('refuses unknown keys, built-in keys, hidden properties and those of another type', () => {
    for (const key of ['custom_nope', 'planId', 'custom_gone', 'custom_net']) {
      expect(
        applyCustomValueEdits({ properties: simProperties, current: {}, edits: { [key]: 'x' } }),
      ).toEqual({ ok: false, field: key });
    }
    expect(
      applyCustomValueEdits({
        properties: catalog.forType('internet'),
        current: {},
        edits: { custom_net: 'x' },
      }),
    ).toEqual({ ok: true, values: { custom_net: 'x' }, changedKeys: ['custom_net'] });
  });

  it('leaves other stored values alone and drops none of the edits on refusal', () => {
    const current = { custom_ref: 'A-1', custom_gone: 'kept' };
    const result = applyCustomValueEdits({
      properties: simProperties,
      current,
      edits: { custom_score: 2.5 },
    });
    expect(result).toEqual({
      ok: true,
      values: { custom_ref: 'A-1', custom_gone: 'kept', custom_score: 2.5 },
      changedKeys: ['custom_score'],
    });
    expect(current).toEqual({ custom_ref: 'A-1', custom_gone: 'kept' });
  });
});

describe('the edit timeline entry', () => {
  it('names custom keys beside built-in ones', () => {
    const entry = {
      id: '00000000-0000-4000-8000-000000000001',
      actorId: '00000000-0000-4000-8000-000000000002',
      createdAt: STAMP,
      kind: 'edit',
      fields: ['phone', 'arrivalDate', 'custom_referral_code'],
    };
    expect(leadActivitySchema.parse(entry)).toEqual(entry);
    expect(
      leadActivitySchema.safeParse({
        ...entry,
        fields: Array.from({ length: 110 }, (_, index) => `custom_k${index}`),
      }).success,
    ).toBe(true);
    expect(leadActivitySchema.safeParse({ ...entry, fields: ['Not a key'] }).success).toBe(false);
  });
});
