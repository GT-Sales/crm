import { describe, expect, it } from 'vitest';

import {
  areValidLeadColumns,
  areValidLeadPropertyFilters,
  buildPropertyCatalog,
  codePropertyCatalog,
  createCustomPropertySchema,
  filterableLeadProperties,
  formatPropertyValue,
  generatePropertyKey,
  isValidLeadPropertyFilter,
  isValidLeadSort,
  leadFields,
  leadPropertyCatalog,
  leadPropertyFilterValueSchema,
  leadPropertyOperators,
  leadTypeProperties,
  leadTypePropertyKeys,
  parsePropertyValue,
  propertyKeySchema,
  propertyRowSchema,
  sitePropertySchema,
  updatePropertySchema,
  type ParsePropertyValueResult,
  type PropertyKind,
  type PropertyRow,
} from './index';

const STAMP = '2026-10-29T12:00:00.000Z';

function row(overrides: Partial<PropertyRow> & Pick<PropertyRow, 'key' | 'origin'>): PropertyRow {
  return propertyRowSchema.parse({
    object: 'lead',
    label:
      overrides.origin === 'builtin' ? (leadPropertyCatalog[overrides.key]?.label ?? 'X') : 'X',
    kind:
      overrides.origin === 'builtin'
        ? (leadPropertyCatalog[overrides.key]?.kind ?? 'text')
        : 'text',
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

const custom = (key: string, overrides: Partial<PropertyRow> = {}): PropertyRow =>
  row({ key, origin: 'custom', label: key, ...overrides });

describe('buildPropertyCatalog', () => {
  it('with no rows resolves exactly the code catalogue', () => {
    expect(codePropertyCatalog.filterable('sim_order')).toEqual(
      filterableLeadProperties('sim_order'),
    );
    expect(codePropertyCatalog.forType('internet').map((p) => p.key)).toEqual(
      leadTypePropertyKeys('internet'),
    );
    expect(buildPropertyCatalog([]).filterable()).toEqual(filterableLeadProperties());
  });

  it('keeps PR #1 semantics: per type the non-sensitive fields, across types merged by first use', () => {
    for (const type of Object.keys(leadTypeProperties)) {
      const expected = leadFields(type)
        .filter((field) => !leadPropertyCatalog[field.key]?.sensitive)
        .map((field) => ({
          key: field.key,
          label: field.label,
          kind: field.kind,
          ...(field.options !== undefined ? { options: field.options } : {}),
          ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
        }));
      expect(JSON.stringify(codePropertyCatalog.filterable(type))).toBe(JSON.stringify(expected));
    }
    const firstUse = [
      ...new Set(Object.values(leadTypeProperties).flatMap((uses) => uses.map((use) => use.key))),
    ].filter((key) => !leadPropertyCatalog[key]?.sensitive);
    expect(codePropertyCatalog.filterable().map((p) => p.key)).toEqual(firstUse);
    expect(codePropertyCatalog.filterable('unknown_type')).toEqual([]);
  });

  it('lists every built-in in catalogue order, each a valid site property', () => {
    expect(codePropertyCatalog.object).toBe('lead');
    expect(codePropertyCatalog.all.map((p) => p.key)).toEqual(Object.keys(leadPropertyCatalog));
    for (const property of codePropertyCatalog.all) {
      expect(property).toMatchObject({ origin: 'builtin', storage: 'form', hidden: false });
      expect(sitePropertySchema.safeParse(property).success).toBe(true);
    }
    expect(codePropertyCatalog.get('dateOfBirth')?.sensitive).toBe(true);
    expect(codePropertyCatalog.get('simNumber')).toMatchObject({
      staffOnly: true,
      leadTypes: ['sim_order'],
    });
    expect(codePropertyCatalog.get('nope')).toBeUndefined();
  });

  it('resolves a type’s use as leadFields does', () => {
    const plan = codePropertyCatalog.forType('sim_order').find((p) => p.key === 'planId');
    const field = leadFields('sim_order').find((f) => f.key === 'planId');
    expect(plan).toMatchObject({
      label: 'Plan (as submitted)',
      kind: 'choice',
      labelKey: 'planLabel',
      editable: true,
      staffOnly: false,
    });
    expect(plan?.options?.map((o) => o.value)).toEqual(field?.options?.map((o) => o.value));
    expect(plan?.options?.every((o) => o.hidden === false)).toBe(true);
    expect(
      codePropertyCatalog.forType('sim_order').find((p) => p.key === 'simNumber'),
    ).toMatchObject({ editable: true, staffOnly: true, maxLength: 40 });
    for (const property of codePropertyCatalog.forType('sim_order')) {
      expect(sitePropertySchema.safeParse(property).success).toBe(true);
    }
  });

  it('a built-in override changes label and hidden and nothing else', () => {
    const c = buildPropertyCatalog([
      row({ key: 'city', origin: 'builtin', label: 'Town', hidden: false }),
    ]);
    expect(c.get('city')).toMatchObject({ label: 'Town', kind: 'text', storage: 'form' });
    const h = buildPropertyCatalog([row({ key: 'city', origin: 'builtin', hidden: true })]);
    expect(h.forType('internet').some((p) => p.key === 'city')).toBe(false);
    expect(h.filterable().some((p) => p.key === 'city')).toBe(false);
    expect(h.get('city')?.hidden).toBe(true);
  });

  it('an override row keeps the type’s own label until the site relabels it', () => {
    const untouched = buildPropertyCatalog([row({ key: 'planId', origin: 'builtin', version: 3 })]);
    const plan = untouched.forType('sim_order').find((p) => p.key === 'planId');
    expect(plan).toMatchObject({ label: 'Plan (as submitted)', version: 3 });
    const relabelled = buildPropertyCatalog([
      row({ key: 'planId', origin: 'builtin', label: 'Plan code' }),
    ]);
    expect(relabelled.forType('sim_order').find((p) => p.key === 'planId')?.label).toBe(
      'Plan code',
    );
    expect(relabelled.filterable('sim_order').find((p) => p.key === 'planId')?.label).toBe(
      'Plan code',
    );
    expect(relabelled.filterable().find((p) => p.key === 'planId')?.label).toBe('Plan code');
  });

  it('ignores rows of another object, unknown built-ins and custom rows reusing a built-in key', () => {
    const c = buildPropertyCatalog([
      row({ key: 'city', origin: 'builtin', label: 'Town', object: 'plan' }),
      row({ key: 'notAProperty', origin: 'builtin', label: 'Ghost' }),
      row({ key: 'city', origin: 'custom', label: 'Shadow', kind: 'number' }),
    ]);
    expect(c.get('city')).toMatchObject({ label: 'City', kind: 'text', origin: 'builtin' });
    expect(c.get('notAProperty')).toBeUndefined();
    expect(c.all).toHaveLength(Object.keys(leadPropertyCatalog).length);
  });

  it('a custom property applies to every type when leadTypes is empty and to listed types otherwise', () => {
    const everywhere = buildPropertyCatalog([custom('custom_ref')]);
    expect(everywhere.forType('internet').some((p) => p.key === 'custom_ref')).toBe(true);
    expect(everywhere.forType('sim_order').some((p) => p.key === 'custom_ref')).toBe(true);
    expect(everywhere.get('custom_ref')).toMatchObject({
      origin: 'custom',
      storage: 'custom',
      editable: true,
      version: 1,
    });

    const simOnly = buildPropertyCatalog([custom('custom_ref', { leadTypes: ['sim_order'] })]);
    expect(simOnly.forType('internet').some((p) => p.key === 'custom_ref')).toBe(false);
    expect(simOnly.forType('sim_order').some((p) => p.key === 'custom_ref')).toBe(true);
    expect(simOnly.filterable('internet').some((p) => p.key === 'custom_ref')).toBe(false);
    expect(simOnly.filterable('sim_order').some((p) => p.key === 'custom_ref')).toBe(true);
    expect(simOnly.filterable().some((p) => p.key === 'custom_ref')).toBe(true);
  });

  it('a sensitive custom property is never filterable but is in forType', () => {
    const c = buildPropertyCatalog([custom('custom_sin', { sensitive: true })]);
    expect(c.forType('internet').some((p) => p.key === 'custom_sin')).toBe(true);
    expect(c.filterable('internet').some((p) => p.key === 'custom_sin')).toBe(false);
    expect(c.filterable().some((p) => p.key === 'custom_sin')).toBe(false);
  });

  it('a hidden custom property stays in all and get but leaves forType and filterable', () => {
    const c = buildPropertyCatalog([custom('custom_old', { hidden: true })]);
    expect(c.get('custom_old')?.hidden).toBe(true);
    expect(c.all.some((p) => p.key === 'custom_old')).toBe(true);
    expect(c.forType('internet').some((p) => p.key === 'custom_old')).toBe(false);
    expect(c.filterable().some((p) => p.key === 'custom_old')).toBe(false);
  });

  it('custom properties come after built-ins, ordered by position then key', () => {
    const c = buildPropertyCatalog([
      custom('custom_c', { position: 1 }),
      custom('custom_b', { position: 0 }),
      custom('custom_a', { position: 1 }),
    ]);
    const builtInCount = leadTypePropertyKeys('internet').length;
    expect(
      c
        .forType('internet')
        .slice(builtInCount)
        .map((p) => p.key),
    ).toEqual(['custom_b', 'custom_a', 'custom_c']);
    expect(c.all.slice(-3).map((p) => p.key)).toEqual(['custom_b', 'custom_a', 'custom_c']);
    expect(
      c
        .filterable('internet')
        .slice(-3)
        .map((p) => p.key),
    ).toEqual(['custom_b', 'custom_a', 'custom_c']);
  });

  it('a custom choice is filterable with its options and kind', () => {
    const c = buildPropertyCatalog([
      custom('custom_tier', {
        kind: 'choice',
        options: [
          { value: 'gold', label: 'Gold', hidden: false },
          { value: 'old', label: 'Old', hidden: true },
        ],
      }),
    ]);
    expect(c.filterable('internet').find((p) => p.key === 'custom_tier')).toEqual({
      key: 'custom_tier',
      label: 'custom_tier',
      kind: 'choice',
      options: [
        { value: 'gold', label: 'Gold', hidden: false },
        { value: 'old', label: 'Old', hidden: true },
      ],
    });
  });
});

describe('generatePropertyKey', () => {
  it('snake-cases the label under the prefix and cuts at 64 characters', () => {
    expect(generatePropertyKey('Referral code!', new Set())).toBe('custom_referral_code');
    expect(generatePropertyKey('Référence #2', new Set())).toBe('custom_r_f_rence_2'); // non-ASCII letters become `_`, runs collapse, ends trimmed
    expect(generatePropertyKey('', new Set())).toBe('custom_property');
    expect(generatePropertyKey('!!!', new Set())).toBe('custom_property');
    const long = generatePropertyKey('a'.repeat(100), new Set());
    expect(long).toBe(`custom_${'a'.repeat(57)}`);
    expect(propertyKeySchema.safeParse(long).success).toBe(true);
    expect(generatePropertyKey(`${'a'.repeat(56)} b`, new Set())).toBe(`custom_${'a'.repeat(56)}`);
  });

  it('appends _2, _3 while the key is reserved', () => {
    expect(generatePropertyKey('City', new Set(['custom_city', 'custom_city_2']))).toBe(
      'custom_city_3',
    );
    const base = `custom_${'a'.repeat(57)}`;
    const next = generatePropertyKey('a'.repeat(100), new Set([base]));
    expect(next).toBe(`custom_${'a'.repeat(55)}_2`);
    expect(next.length).toBe(64);
  });
});

describe('parsePropertyValue', () => {
  it.each<[PropertyKind, unknown, ParsePropertyValueResult]>([
    ['money', 1999, { ok: true, value: 1999 }],
    ['money', 19.99, { ok: false }],
    ['money', -1e12, { ok: true, value: -1e12 }],
    ['money', '1999', { ok: false }],
    ['number', 1e13, { ok: false }],
    ['number', 12.5, { ok: true, value: 12.5 }],
    ['number', Number.NaN, { ok: false }],
    ['number', Number.POSITIVE_INFINITY, { ok: false }],
    ['count', 3, { ok: true, value: 3 }],
    ['count', 10_001, { ok: false }],
    ['count', -1, { ok: false }],
    ['email', 'A@B.ca', { ok: true, value: 'a@b.ca' }],
    ['email', 'not an email', { ok: false }],
    ['email', `${'a'.repeat(250)}@b.ca`, { ok: false }],
    ['phone', '+1 (613) 555-0100', { ok: true, value: '+16135550100' }],
    ['phone', 'call me', { ok: false }],
    ['phone', '1234', { ok: false }],
    ['url', 'ftp://x', { ok: false }],
    ['url', 'javascript:alert(1)', { ok: false }],
    ['url', 'https://x.ca/p', { ok: true, value: 'https://x.ca/p' }],
    ['url', `https://x.ca/${'p'.repeat(2048)}`, { ok: false }],
    ['date', '2026-02-30', { ok: false }],
    ['date', '2026-02-28', { ok: true, value: '2026-02-28' }],
    ['dateTime', '2026-10-29T12:00:00Z', { ok: true, value: '2026-10-29T12:00:00Z' }],
    ['dateTime', '2026-10-29', { ok: false }],
    ['yesNo', 'true', { ok: false }],
    ['yesNo', false, { ok: true, value: false }],
    ['text', '', { ok: false }],
    ['text', '   ', { ok: false }],
    ['text', '  Ottawa ', { ok: true, value: 'Ottawa' }],
    ['text', 'a'.repeat(201), { ok: false }],
    ['text', 'line\nbreak', { ok: false }],
    ['text', 'bidi‮override', { ok: false }],
    ['longText', 'line\r\nbreak', { ok: true, value: 'line\nbreak' }],
    ['longText', 'a'.repeat(4000), { ok: true, value: 'a'.repeat(4000) }],
    ['longText', 'a'.repeat(4001), { ok: false }],
    ['choice', 'x', { ok: false }],
  ])('%s %j', (kind, input, expected) => {
    expect(parsePropertyValue({ kind }, input)).toEqual(expected);
  });

  it('text honours the property’s maxLength', () => {
    expect(parsePropertyValue({ kind: 'text', maxLength: 3 }, 'abcd')).toEqual({ ok: false });
    expect(parsePropertyValue({ kind: 'text', maxLength: 300 }, 'a'.repeat(300)).ok).toBe(true);
  });

  it('choice accepts a visible option only', () => {
    const property = {
      kind: 'choice' as const,
      options: [
        { value: 'gold', label: 'Gold', hidden: false },
        { value: 'old', label: 'Old', hidden: true },
      ],
    };
    expect(parsePropertyValue(property, 'gold')).toEqual({ ok: true, value: 'gold' });
    expect(parsePropertyValue(property, 'old')).toEqual({ ok: false });
    expect(parsePropertyValue(property, 'silver')).toEqual({ ok: false });
    expect(parsePropertyValue(property, '')).toEqual({ ok: false });
  });
});

describe('formatPropertyValue', () => {
  it('reads each kind as staff see it', () => {
    expect(formatPropertyValue({ kind: 'money' }, 199_999)).toBe('$1,999.99');
    expect(formatPropertyValue({ kind: 'yesNo' }, true)).toBe('Yes');
    expect(formatPropertyValue({ kind: 'yesNo' }, false)).toBe('No');
    expect(
      formatPropertyValue(
        { kind: 'choice', options: [{ value: 'gold', label: 'Gold', hidden: true }] },
        'gold',
      ),
    ).toBe('Gold');
    expect(formatPropertyValue({ kind: 'choice', options: [] }, 'retired')).toBe('retired');
    expect(formatPropertyValue({ kind: 'date' }, '2026-02-03')).toBe('Feb 3, 2026');
    // A moment reads with its time, in UTC (ICU may space "p.m." with a narrow no-break space).
    expect(
      formatPropertyValue({ kind: 'dateTime' }, '2026-02-03T23:05:00Z').replace(/\s/g, ' '),
    ).toBe('Feb 3, 2026, 11:05 p.m.');
    expect(formatPropertyValue({ kind: 'number' }, 12.5)).toBe('12.5');
    expect(formatPropertyValue({ kind: 'text' }, 'Ottawa')).toBe('Ottawa');
    expect(formatPropertyValue({ kind: 'text' }, null)).toBe('');
    expect(formatPropertyValue({ kind: 'date' }, 'soon')).toBe('soon');
  });
});

describe('createCustomPropertySchema', () => {
  it('needs options for choice and refuses them for other kinds', () => {
    const gold = { value: 'gold', label: 'Gold' };
    expect(createCustomPropertySchema.safeParse({ label: 'Tier', kind: 'choice' }).success).toBe(
      false,
    );
    const choice = createCustomPropertySchema.parse({
      label: ' Tier ',
      kind: 'choice',
      options: [gold],
    });
    expect(choice).toEqual({
      label: 'Tier',
      kind: 'choice',
      options: [{ value: 'gold', label: 'Gold', hidden: false }],
      staffOnly: false,
      sensitive: false,
      leadTypes: [],
    });
    expect(
      createCustomPropertySchema.safeParse({ label: 'Ref', kind: 'text', options: [gold] }).success,
    ).toBe(false);
    expect(
      createCustomPropertySchema.safeParse({ label: 'Tier', kind: 'choice', options: [gold, gold] })
        .success,
    ).toBe(false);
    expect(
      createCustomPropertySchema.safeParse({
        label: 'Ref',
        kind: 'text',
        leadTypes: ['internet', 'internet'],
      }).success,
    ).toBe(false);
    expect(createCustomPropertySchema.safeParse({ label: '', kind: 'text' }).success).toBe(false);
    expect(
      createCustomPropertySchema.safeParse({ label: 'Ref', kind: 'text', key: 'custom_x' }).success,
    ).toBe(false);
  });

  it('refuses dateTime and count', () => {
    expect(createCustomPropertySchema.safeParse({ label: 'At', kind: 'dateTime' }).success).toBe(
      false,
    );
    expect(createCustomPropertySchema.safeParse({ label: 'N', kind: 'count' }).success).toBe(false);
    expect(createCustomPropertySchema.safeParse({ label: 'Fee', kind: 'money' }).success).toBe(
      true,
    );
  });
});

describe('updatePropertySchema', () => {
  it('needs a change besides the expected version, with unique options and lead types', () => {
    expect(updatePropertySchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(updatePropertySchema.safeParse({ expectedVersion: 1, hidden: true }).success).toBe(true);
    expect(updatePropertySchema.safeParse({ hidden: true }).success).toBe(false);
    expect(
      updatePropertySchema.safeParse({
        expectedVersion: 2,
        options: [
          { value: 'a', label: 'A' },
          { value: 'a', label: 'B' },
        ],
      }).success,
    ).toBe(false);
    expect(
      updatePropertySchema.safeParse({ expectedVersion: 2, leadTypes: ['internet', 'internet'] })
        .success,
    ).toBe(false);
    expect(updatePropertySchema.safeParse({ expectedVersion: 2, kind: 'text' }).success).toBe(
      false,
    );
  });
});

it('propertyKeySchema accepts custom keys and still every PR #1 key', () => {
  expect(propertyKeySchema.safeParse('custom_referral_code').success).toBe(true);
  for (const key of Object.keys(leadPropertyCatalog))
    expect(propertyKeySchema.safeParse(key).success).toBe(true);
  expect(propertyKeySchema.safeParse('Custom').success).toBe(false);
  expect(propertyKeySchema.safeParse('_x').success).toBe(false);
  expect(propertyKeySchema.safeParse(`a${'b'.repeat(64)}`).success).toBe(false);
});

describe('filters, sorts and columns against a site catalogue', () => {
  const site = buildPropertyCatalog([
    row({ key: 'city', origin: 'builtin', hidden: true }),
    custom('custom_fee', { kind: 'money' }),
    custom('custom_score', { kind: 'number' }),
    custom('custom_mail', { kind: 'email' }),
    custom('custom_sin', { kind: 'text', sensitive: true }),
  ]);

  it('offers the count operators to number and money and the text ones to email, phone and url', () => {
    const countOps = leadPropertyOperators('count');
    const textOps = leadPropertyOperators('text');
    expect(leadPropertyOperators('number')).toEqual(countOps);
    expect(leadPropertyOperators('money')).toEqual(countOps);
    for (const kind of ['email', 'phone', 'url'] as const) {
      expect(leadPropertyOperators(kind)).toEqual(textOps);
    }
  });

  it('parses numbers within ±1e12 as filter values', () => {
    expect(leadPropertyFilterValueSchema.safeParse(-5.5).success).toBe(true);
    expect(leadPropertyFilterValueSchema.safeParse(1e12).success).toBe(true);
    expect(leadPropertyFilterValueSchema.safeParse(1e12 + 1).success).toBe(false);
    expect(leadPropertyFilterValueSchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
  });

  it('validates custom filters by kind and keeps count to whole numbers', () => {
    expect(
      isValidLeadPropertyFilter({ key: 'custom_fee', op: 'gte', value: 1999 }, 'internet', site),
    ).toBe(true);
    expect(
      isValidLeadPropertyFilter({ key: 'custom_fee', op: 'gte', value: 19.99 }, 'internet', site),
    ).toBe(false);
    expect(
      isValidLeadPropertyFilter({ key: 'custom_score', op: 'lte', value: -2.5 }, undefined, site),
    ).toBe(true);
    expect(
      isValidLeadPropertyFilter(
        { key: 'custom_mail', op: 'contains', value: '@x' },
        'internet',
        site,
      ),
    ).toBe(true);
    expect(
      isValidLeadPropertyFilter({ key: 'custom_mail', op: 'gte', value: 'a' }, 'internet', site),
    ).toBe(false);
    expect(
      isValidLeadPropertyFilter({ key: 'lineCount', op: 'gte', value: 1.5 }, 'mobility', site),
    ).toBe(false);
    expect(
      isValidLeadPropertyFilter({ key: 'lineCount', op: 'gte', value: 2 }, 'mobility', site),
    ).toBe(true);
    expect(
      areValidLeadPropertyFilters([{ key: 'custom_sin', op: 'empty' }], 'internet', site),
    ).toBe(false);
    expect(
      areValidLeadPropertyFilters([{ key: 'city', op: 'eq', value: 'Ottawa' }], 'internet', site),
    ).toBe(false);
    expect(areValidLeadPropertyFilters([{ key: 'custom_fee', op: 'empty' }], 'internet')).toBe(
      false,
    );
  });

  it('accepts custom sorts and columns and refuses hidden and sensitive ones', () => {
    expect(isValidLeadSort('prop.custom_fee:desc', 'internet', site)).toBe(true);
    expect(isValidLeadSort('prop.custom_sin:desc', 'internet', site)).toBe(false);
    expect(isValidLeadSort('prop.city:asc', 'internet', site)).toBe(false);
    expect(isValidLeadSort('prop.city:asc', 'internet')).toBe(true);
    expect(areValidLeadColumns(['custom_fee', 'postalCode'], 'internet', site)).toBe(true);
    expect(areValidLeadColumns(['city'], 'internet', site)).toBe(false);
    expect(areValidLeadColumns(['custom_fee'], 'internet')).toBe(false);
  });
});
