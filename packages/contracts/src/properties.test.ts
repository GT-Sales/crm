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
  ORDER_PROPERTY_KEYS,
  orderPropertyCatalog,
  parsePropertyValue,
  propertyKeySchema,
  propertyRowSchema,
  sitePropertySchema,
  updatePropertySchema,
  type ParsePropertyValueResult,
  type PropertyKind,
  type PlanOption,
  type PropertyRow,
} from './index';

const STAMP = '2026-10-29T12:00:00.000Z';

const ORDER_TYPES = ['sim_order', 'internet', 'mobility'] as const;

const builtinDefinition = (key: string) => leadPropertyCatalog[key] ?? orderPropertyCatalog[key];

function row(overrides: Partial<PropertyRow> & Pick<PropertyRow, 'key' | 'origin'>): PropertyRow {
  return propertyRowSchema.parse({
    object: 'lead',
    label: overrides.origin === 'builtin' ? (builtinDefinition(overrides.key)?.label ?? 'X') : 'X',
    kind:
      overrides.origin === 'builtin' ? (builtinDefinition(overrides.key)?.kind ?? 'text') : 'text',
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
    expect(codePropertyCatalog.forType('internet').map((p) => p.key)).toEqual([
      ...leadTypePropertyKeys('internet'),
      ...ORDER_PROPERTY_KEYS,
    ]);
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
      // Order types add the order properties after the form ones.
      const form = codePropertyCatalog.filterable(type).slice(0, expected.length);
      expect(JSON.stringify(form)).toBe(JSON.stringify(expected));
    }
    const firstUse = [
      ...new Set(Object.values(leadTypeProperties).flatMap((uses) => uses.map((use) => use.key))),
    ].filter((key) => !leadPropertyCatalog[key]?.sensitive);
    expect(codePropertyCatalog.filterable().map((p) => p.key)).toEqual([
      ...firstUse,
      ...ORDER_PROPERTY_KEYS,
    ]);
    expect(codePropertyCatalog.filterable('unknown_type')).toEqual([]);
  });

  it('lists every built-in in catalogue order, each a valid site property', () => {
    expect(codePropertyCatalog.object).toBe('lead');
    expect(codePropertyCatalog.all.map((p) => p.key)).toEqual([
      ...Object.keys(leadPropertyCatalog),
      ...ORDER_PROPERTY_KEYS,
    ]);
    for (const property of codePropertyCatalog.all) {
      expect(property).toMatchObject({
        origin: 'builtin',
        storage: Object.hasOwn(leadPropertyCatalog, property.key) ? 'form' : 'order',
        hidden: false,
        websiteVisible: false,
      });
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
    expect(c.all).toHaveLength(
      Object.keys(leadPropertyCatalog).length + ORDER_PROPERTY_KEYS.length,
    );
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
    const builtInCount = leadTypePropertyKeys('internet').length + ORDER_PROPERTY_KEYS.length;
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

const PLANS: readonly PlanOption[] = [
  { id: '0b9f3f5e-7c1a-4c2e-9a51-1d2e3f4a5b6c', name: 'Unlimited Data', active: true },
  { id: '5d6e7f80-1a2b-4c3d-8e9f-0a1b2c3d4e5f', name: 'Old 25GB', active: false },
];

describe('order properties', () => {
  it('are defined in code with the brief’s keys, labels and options', () => {
    expect(ORDER_PROPERTY_KEYS).toEqual(['plan', 'quantity', 'paymentStatus', 'carrierCommission']);
    expect(Object.keys(orderPropertyCatalog)).toEqual([...ORDER_PROPERTY_KEYS]);
    expect(orderPropertyCatalog.plan).toEqual({
      key: 'plan',
      label: 'Plan',
      kind: 'choice',
      options: [],
    });
    expect(orderPropertyCatalog.quantity).toEqual({
      key: 'quantity',
      label: 'Quantity',
      kind: 'count',
    });
    expect(orderPropertyCatalog.paymentStatus?.options).toEqual([
      { value: 'not_needed', label: 'Not needed' },
      { value: 'pending', label: 'Pending' },
      { value: 'paid', label: 'Paid' },
    ]);
    expect(orderPropertyCatalog.carrierCommission?.options).toEqual([
      { value: 'not_yet', label: 'Not yet' },
      { value: 'invoiced', label: 'Invoiced' },
      { value: 'received', label: 'Received' },
      { value: 'clawback', label: 'Clawback' },
    ]);
  });

  it('follow the form properties and precede custom ones on every order type, and only there', () => {
    const c = buildPropertyCatalog([custom('custom_ref')]);
    for (const type of ORDER_TYPES) {
      const keys = c.forType(type).map((p) => p.key);
      expect(keys).toEqual([...leadTypePropertyKeys(type), ...ORDER_PROPERTY_KEYS, 'custom_ref']);
      for (const property of c.forType(type).filter((p) => p.storage === 'order')) {
        expect(property).toMatchObject({
          origin: 'builtin',
          storage: 'order',
          editable: true,
          staffOnly: false,
          sensitive: false,
          hidden: false,
          websiteVisible: false,
        });
        expect(sitePropertySchema.safeParse(property).success).toBe(true);
      }
    }
    const partner = c.forType('partner_application').map((p) => p.key);
    expect(partner).toEqual([...leadTypePropertyKeys('partner_application'), 'custom_ref']);
    expect(c.filterable('partner_application').some((p) => p.key === 'paymentStatus')).toBe(false);
    expect(c.get('plan')?.leadTypes).toEqual([...ORDER_TYPES]);
  });

  it('read and write their order_details field: plan is stored as planId, the rest as themselves', () => {
    const storageKeys = Object.fromEntries(
      codePropertyCatalog
        .forType('sim_order')
        .filter((p) => p.storage === 'order')
        .map((p) => [p.key, p.storageKey]),
    );
    expect(storageKeys).toEqual({
      plan: 'planId',
      quantity: 'quantity',
      paymentStatus: 'paymentStatus',
      carrierCommission: 'carrierCommission',
    });
    expect(codePropertyCatalog.get('plan')?.storageKey).toBe('planId');
    expect(codePropertyCatalog.get('city')?.storageKey).toBeUndefined();
  });

  it('keep the submitted form plan beside the order plan, with no duplicate keys', () => {
    const properties = codePropertyCatalog.forType('sim_order');
    const keys = properties.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(properties.find((p) => p.key === 'planId')).toMatchObject({
      storage: 'form',
      label: 'Plan (as submitted)',
    });
    expect(properties.find((p) => p.key === 'plan')).toMatchObject({
      storage: 'order',
      label: 'Plan',
    });
    for (const type of ORDER_TYPES) {
      const across = codePropertyCatalog.forType(type).map((p) => p.key);
      expect(new Set(across).size, type).toBe(across.length);
    }
    const filterKeys = codePropertyCatalog.filterable().map((p) => p.key);
    expect(new Set(filterKeys).size).toBe(filterKeys.length);
  });

  it('take the plan options from the site’s plans, an inactive plan as a hidden option', () => {
    expect(codePropertyCatalog.get('plan')?.options ?? []).toEqual([]);
    const c = buildPropertyCatalog([], 'lead', { plans: PLANS });
    const expected = [
      { value: PLANS[0]?.id, label: 'Unlimited Data', hidden: false },
      { value: PLANS[1]?.id, label: 'Old 25GB', hidden: true },
    ];
    expect(c.get('plan')?.options).toEqual(expected);
    expect(c.forType('internet').find((p) => p.key === 'plan')?.options).toEqual(expected);
    expect(c.filterable('mobility').find((p) => p.key === 'plan')?.options).toEqual(expected);
    expect(c.filterable().find((p) => p.key === 'plan')?.options).toEqual(expected);
    // An old value still reads; nobody picks it anew.
    const plan = c.get('plan');
    if (!plan) throw new Error('plan property missing');
    expect(formatPropertyValue(plan, PLANS[1]?.id)).toBe('Old 25GB');
    expect(parsePropertyValue(plan, PLANS[1]?.id).ok).toBe(false);
    expect(parsePropertyValue(plan, PLANS[0]?.id).ok).toBe(true);
  });

  it('are filterable per order type and across types, with the choice operators', () => {
    const payment = codePropertyCatalog
      .filterable('sim_order')
      .find((p) => p.key === 'paymentStatus');
    expect(payment).toEqual({
      key: 'paymentStatus',
      label: 'Payment status',
      kind: 'choice',
      options: [
        { value: 'not_needed', label: 'Not needed', hidden: false },
        { value: 'pending', label: 'Pending', hidden: false },
        { value: 'paid', label: 'Paid', hidden: false },
      ],
    });
    expect(payment && leadPropertyOperators(payment.kind)).toEqual([
      'eq',
      'in',
      'empty',
      'notEmpty',
    ]);
    expect(codePropertyCatalog.filterable('sim_order').map((p) => p.key)).toEqual(
      expect.arrayContaining([...ORDER_PROPERTY_KEYS]),
    );
    expect(codePropertyCatalog.filterable().find((p) => p.key === 'quantity')).toMatchObject({
      kind: 'count',
      label: 'Quantity',
    });
    expect(
      isValidLeadPropertyFilter(
        { key: 'paymentStatus', op: 'in', value: ['paid', 'pending'] },
        'sim_order',
      ),
    ).toBe(true);
  });

  it('a built-in override relabels or hides them like any built-in', () => {
    const hidden = buildPropertyCatalog([
      row({ key: 'quantity', origin: 'builtin', hidden: true }),
    ]);
    expect(hidden.forType('sim_order').some((p) => p.key === 'quantity')).toBe(false);
    expect(hidden.filterable('sim_order').some((p) => p.key === 'quantity')).toBe(false);
    expect(hidden.filterable().some((p) => p.key === 'quantity')).toBe(false);
    expect(hidden.get('quantity')).toMatchObject({ hidden: true, version: 1 });

    const relabelled = buildPropertyCatalog([
      row({ key: 'paymentStatus', origin: 'builtin', label: 'Paid?', version: 4 }),
    ]);
    expect(relabelled.forType('internet').find((p) => p.key === 'paymentStatus')).toMatchObject({
      label: 'Paid?',
      version: 4,
      storage: 'order',
    });
    expect(relabelled.filterable('internet').find((p) => p.key === 'paymentStatus')?.label).toBe(
      'Paid?',
    );
    expect(relabelled.filterable().find((p) => p.key === 'paymentStatus')?.label).toBe('Paid?');

    const shadow = buildPropertyCatalog([row({ key: 'plan', origin: 'custom', label: 'Shadow' })]);
    expect(shadow.get('plan')).toMatchObject({
      origin: 'builtin',
      storage: 'order',
      label: 'Plan',
    });
  });

  it('do not exist for plans', () => {
    const plans = buildPropertyCatalog([], 'plan', { plans: PLANS });
    expect(plans.all).toEqual([]);
    expect(plans.forType('sim_order')).toEqual([]);
  });
});

describe('websiteVisible', () => {
  it('round-trips through propertyRowSchema and defaults to false', () => {
    expect(custom('custom_ref').websiteVisible).toBe(false);
    expect(
      propertyRowSchema.parse({ ...custom('custom_ref', { object: 'plan' }), websiteVisible: true })
        .websiteVisible,
    ).toBe(true);
    expect(
      propertyRowSchema.safeParse({ ...custom('custom_ref'), websiteVisible: 'yes' }).success,
    ).toBe(false);
  });

  it('is carried through the catalogue for a custom plan property, and false otherwise', () => {
    const plans = buildPropertyCatalog(
      [
        custom('custom_network', { object: 'plan', websiteVisible: true }),
        custom('custom_cost', { object: 'plan', position: 1 }),
      ],
      'plan',
    );
    expect(plans.get('custom_network')?.websiteVisible).toBe(true);
    expect(plans.get('custom_cost')?.websiteVisible).toBe(false);
    expect(sitePropertySchema.safeParse(plans.get('custom_network')).success).toBe(true);
    // A lead property is never shown on a website, whatever its row says.
    const leads = buildPropertyCatalog([custom('custom_ref', { websiteVisible: true })]);
    expect(leads.get('custom_ref')?.websiteVisible).toBe(false);
  });

  it('is accepted on create (default false) and update', () => {
    expect(
      createCustomPropertySchema.parse({ label: 'Network', kind: 'text', websiteVisible: true })
        .websiteVisible,
    ).toBe(true);
    expect(
      createCustomPropertySchema.parse({ label: 'Network', kind: 'text' }).websiteVisible,
    ).toBe(false);
    expect(updatePropertySchema.parse({ expectedVersion: 1, websiteVisible: true })).toEqual({
      expectedVersion: 1,
      websiteVisible: true,
    });
    expect(
      updatePropertySchema.safeParse({ expectedVersion: 1, websiteVisible: 'no' }).success,
    ).toBe(false);
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
      websiteVisible: false,
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
