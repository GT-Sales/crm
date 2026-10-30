import { describe, expect, it } from 'vitest';

import {
  applyLeadFormEdit,
  areValidLeadColumns,
  areValidLeadPropertyFilters,
  filterableLeadProperties,
  internetLeadPayloadSchema,
  isValidLeadSort,
  leadBoardQuerySchema,
  leadColumnsSchema,
  leadCountdownField,
  leadFieldCatalog,
  leadFields,
  leadFormEditSchema,
  leadProperty,
  leadPropertyCatalog,
  leadPropertyOperators,
  leadSortSchema,
  leadTypeCatalog,
  leadTypeProperties,
  leadTypePropertyKeys,
  leadWhereSchema,
  listWorkspaceLeadsQuerySchema,
  mobilityLeadPayloadSchema,
  resolveLeadTypeProperty,
  type LeadFieldDefinition,
  type LeadFieldOption,
} from './index';

const SIM_PLANS: readonly LeadFieldOption[] = [
  { value: 'unlimited-data-120gb-rogers', label: 'Unlimited Data · $50, Rogers' },
  { value: 'unlimited-data-rogers', label: 'Unlimited Data · $40, Rogers' },
  { value: '75gb-fido', label: '75GB · $35, Fido' },
  { value: '95gb-chatr', label: '90GB · $40, Chatr' },
  { value: '25gb-chatr', label: '50GB · $35, Chatr' },
  { value: '75gb-chatr', label: '75GB · $75, Chatr' },
];

const PERMIT_TYPES: readonly LeadFieldOption[] = [
  { value: 'newcomer', label: 'Newcomer / permanent resident' },
  { value: 'student', label: 'Study permit' },
  { value: 'worker', label: 'Work permit' },
  { value: 'tourist', label: 'Tourist / visitor' },
];

const expectedLeadFieldCatalog: Readonly<Record<string, readonly LeadFieldDefinition[]>> = {
  internet: [
    { key: 'planLabel', label: 'Plan', kind: 'text' },
    { key: 'planId', label: 'Plan id', kind: 'text' },
    { key: 'streetAddress', label: 'Street address', kind: 'text' },
    { key: 'aptUnit', label: 'Apt / unit', kind: 'text' },
    { key: 'city', label: 'City', kind: 'text' },
    { key: 'postalCode', label: 'Postal code', kind: 'text' },
    { key: 'landingCity', label: 'Landing city', kind: 'text' },
    { key: 'dateOfBirth', label: 'Date of birth', kind: 'date' },
    { key: 'currentProvider', label: 'Current provider', kind: 'text' },
    { key: 'preferredInstallationTime', label: 'Preferred installation', kind: 'text' },
    { key: 'consent', label: 'Contact consent', kind: 'yesNo' },
    { key: 'consentedAt', label: 'Consented at', kind: 'dateTime' },
  ],
  mobility: [
    { key: 'planLabel', label: 'Plan', kind: 'text' },
    { key: 'planId', label: 'Plan id', kind: 'text' },
    { key: 'lineCount', label: 'Lines', kind: 'count' },
    { key: 'firstName', label: 'First name', kind: 'text' },
    { key: 'lastName', label: 'Last name', kind: 'text' },
    {
      key: 'simType',
      label: 'SIM',
      kind: 'choice',
      options: [
        { value: 'esim', label: 'eSIM' },
        { value: 'physical', label: 'Physical SIM' },
      ],
    },
    { key: 'keepNumber', label: 'Keep current number', kind: 'yesNo' },
    { key: 'currentProvider', label: 'Current provider', kind: 'text' },
    { key: 'streetAddress', label: 'Street address', kind: 'text' },
    { key: 'aptUnit', label: 'Apt / unit', kind: 'text' },
    { key: 'city', label: 'City', kind: 'text' },
    { key: 'postalCode', label: 'Postal code', kind: 'text' },
  ],
  sim_order: [
    {
      key: 'planId',
      label: 'Plan (as submitted)',
      kind: 'choice',
      options: SIM_PLANS,
      labelKey: 'planLabel',
      editable: true,
    },
    {
      key: 'delivery',
      label: 'SIM type',
      kind: 'choice',
      options: [
        { value: 'esim', label: 'eSIM' },
        { value: 'pickup', label: 'Physical SIM (mailed)' },
      ],
      editable: true,
    },
    {
      key: 'arrivalDate',
      label: 'Arrival in Canada',
      kind: 'date',
      editable: true,
      countdown: true,
    },
    {
      key: 'permitType',
      label: 'Visa / permit type',
      kind: 'choice',
      options: PERMIT_TYPES,
      editable: true,
    },
    { key: 'gotVisa', label: 'Has the visa', kind: 'yesNo', editable: true },
    { key: 'flightBooked', label: 'Flight booked', kind: 'yesNo', editable: true },
    {
      key: 'shippingAddress',
      label: 'Shipping address',
      kind: 'longText',
      editable: true,
      maxLength: 400,
      requiredWhen: { key: 'delivery', value: 'pickup' },
    },
    {
      key: 'canadaAddress',
      label: 'Address in Canada / City',
      kind: 'text',
      editable: true,
      maxLength: 300,
    },
    { key: 'reference', label: 'Reference', kind: 'text', editable: true, maxLength: 120 },
    { key: 'customerNotes', label: 'Customer notes', kind: 'longText' },
    {
      key: 'simNumber',
      label: 'SIM number',
      kind: 'text',
      editable: true,
      staffOnly: true,
      maxLength: 40,
    },
  ],
  partner_application: [
    { key: 'company', label: 'Company', kind: 'text' },
    { key: 'businessType', label: 'Business type', kind: 'text' },
    { key: 'country', label: 'Country', kind: 'text' },
    { key: 'website', label: 'Website', kind: 'text' },
    { key: 'volume', label: 'Expected volume', kind: 'text' },
    { key: 'message', label: 'Message', kind: 'longText' },
  ],
};

const order = {
  planId: 'unlimited-data-rogers',
  planLabel: 'Unlimited Data · $40, Rogers',
  delivery: 'esim',
  arrivalDate: '2026-11-02',
  permitType: 'student',
  customerNotes: 'Please call after 6pm',
};

describe('lead field definitions and shared property catalogue', () => {
  it('keeps leadFieldCatalog and leadFields() byte-for-byte identical for the three unchanged types', () => {
    expect(Object.keys(leadFieldCatalog)).toEqual([
      'internet',
      'mobility',
      'sim_order',
      'partner_application',
    ]);
    for (const type of ['internet', 'mobility', 'partner_application']) {
      expect(leadFields(type)).toEqual(expectedLeadFieldCatalog[type]);
      expect(JSON.stringify(leadFields(type))).toBe(JSON.stringify(expectedLeadFieldCatalog[type]));
    }
  });

  it('lists the SIM order fields without the carrier commission, the old plan as submitted', () => {
    // Phase 3: the carrier commission is an order detail now, and the plan
    // a site manages replaces the form's plan slug, kept as the customer sent it.
    expect(leadFields('sim_order')).toEqual(expectedLeadFieldCatalog['sim_order']);
    expect(leadFields('sim_order').map((field) => field.key)).toEqual([
      'planId',
      'delivery',
      'arrivalDate',
      'permitType',
      'gotVisa',
      'flightBooked',
      'shippingAddress',
      'canadaAddress',
      'reference',
      'customerNotes',
      'simNumber',
    ]);
    expect(leadFields('sim_order').find((field) => field.key === 'planId')?.label).toBe(
      'Plan (as submitted)',
    );
    expect(leadProperty('commissionStatus')).toBeUndefined();
  });

  it('describes only catalogued types, each key once', () => {
    for (const [leadType, fields] of Object.entries(leadFieldCatalog)) {
      expect(Object.keys(leadTypeCatalog)).toContain(leadType);
      const keys = fields.map((entry) => entry.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
    expect(leadFields('unknown_type')).toEqual([]);
    expect(leadCountdownField('sim_order')?.key).toBe('arrivalDate');
    expect(leadCountdownField('internet')).toBeUndefined();
  });

  it('includes every intake payload schema key in leadPropertyCatalog and in that type’s uses', () => {
    const internetUsed = new Set(leadTypePropertyKeys('internet'));
    for (const key of Object.keys(internetLeadPayloadSchema.shape)) {
      expect(leadProperty(key)).toBeDefined();
      expect(internetUsed.has(key)).toBe(true);
    }

    const mobilityUsed = new Set(leadTypePropertyKeys('mobility'));
    for (const key of Object.keys(mobilityLeadPayloadSchema.shape)) {
      expect(leadProperty(key)).toBeDefined();
      expect(mobilityUsed.has(key)).toBe(true);
    }
  });

  it('validates leadPropertyCatalog keys and rejects any kind override other than text -> choice', () => {
    const keyPattern = /^[a-z][A-Za-z0-9]{0,63}$/;
    for (const [key, definition] of Object.entries(leadPropertyCatalog)) {
      expect(definition.key).toBe(key);
      expect(keyPattern.test(key)).toBe(true);
    }

    for (const uses of Object.values(leadTypeProperties)) {
      for (const use of uses) {
        const property = leadProperty(use.key);
        expect(property).toBeDefined();
        if (property && use.kind !== undefined && use.kind !== property.kind) {
          expect(property.kind).toBe('text');
          expect(use.kind).toBe('choice');
          expect(use.options?.length).toBeGreaterThan(0);
        }
      }
    }

    const textProp = leadPropertyCatalog['city'];
    const dateProp = leadPropertyCatalog['arrivalDate'];
    if (!textProp || !dateProp) throw new Error('expected properties missing');

    expect(() =>
      resolveLeadTypeProperty(textProp, {
        key: 'city',
        kind: 'choice',
        options: [{ value: 'toronto', label: 'Toronto' }],
      }),
    ).not.toThrow();

    expect(() => resolveLeadTypeProperty(textProp, { key: 'city', kind: 'date' })).toThrow();
    expect(() => resolveLeadTypeProperty(textProp, { key: 'city', kind: 'choice' })).toThrow();
    expect(() =>
      resolveLeadTypeProperty(dateProp, {
        key: 'arrivalDate',
        kind: 'choice',
        options: [{ value: '2026-01-01', label: 'Jan 1' }],
      }),
    ).toThrow();
  });

  it('returns non-sensitive filterable properties and resolves cross-type kind conflicts to text', () => {
    expect(leadProperty('dateOfBirth')?.sensitive).toBe(true);

    const internetFilterable = filterableLeadProperties('internet');
    expect(internetFilterable.some((entry) => entry.key === 'dateOfBirth')).toBe(false);
    expect(internetFilterable.find((entry) => entry.key === 'planId')?.kind).toBe('text');

    const simFilterable = filterableLeadProperties('sim_order');
    const simPlan = simFilterable.find((entry) => entry.key === 'planId');
    expect(simPlan?.kind).toBe('choice');
    expect(simPlan?.label).toBe('Plan (as submitted)');
    expect(simPlan?.options).toEqual(SIM_PLANS);

    const allFilterable = filterableLeadProperties();
    expect(allFilterable.some((entry) => entry.key === 'dateOfBirth')).toBe(false);
    const allPlan = allFilterable.find((entry) => entry.key === 'planId');
    expect(allPlan?.kind).toBe('text');
    expect(allPlan?.options).toBeUndefined();
    const allPermit = allFilterable.find((entry) => entry.key === 'permitType');
    expect(allPermit?.kind).toBe('choice');
    expect(allPermit?.options).toEqual(PERMIT_TYPES);

    expect(leadPropertyOperators('text')).toEqual(['eq', 'contains', 'empty', 'notEmpty']);
    expect(leadPropertyOperators('choice')).toEqual(['eq', 'in', 'empty', 'notEmpty']);
    expect(leadPropertyOperators('date')).toEqual(['eq', 'lte', 'gte', 'empty', 'notEmpty']);
    expect(leadPropertyOperators('dateTime')).toEqual(['lte', 'gte', 'empty', 'notEmpty']);
    expect(leadPropertyOperators('count')).toEqual(['eq', 'lte', 'gte', 'empty', 'notEmpty']);
    expect(leadPropertyOperators('yesNo')).toEqual(['eq', 'empty']);
  });

  it('accepts an edit only of keys shaped like fields, one to forty of them', () => {
    expect(leadFormEditSchema.safeParse({ arrivalDate: '2026-12-01' }).success).toBe(true);
    expect(leadFormEditSchema.safeParse({}).success).toBe(false);
    expect(leadFormEditSchema.safeParse({ 'not a key': 'x' }).success).toBe(false);
    expect(leadFormEditSchema.safeParse({ nested: { a: 1 } }).success).toBe(false);
  });
});

describe('where, sort and columns query schemas', () => {
  it('parses valid where, sort and columns parameters on list and board queries', () => {
    const whereJson = JSON.stringify([
      { key: 'city', op: 'eq', value: 'Calgary' },
      { key: 'permitType', op: 'in', value: ['student', 'worker'] },
      { key: 'arrivalDate', op: 'gte', value: '2026-11-01' },
      { key: 'lineCount', op: 'lte', value: 4 },
      { key: 'gotVisa', op: 'eq', value: true },
      { key: 'reference', op: 'empty' },
    ]);

    const parsedList = listWorkspaceLeadsQuerySchema.parse({
      type: 'sim_order',
      where: whereJson,
      sort: 'prop.arrivalDate:asc',
      columns: 'arrivalDate,permitType,city',
    });

    expect(parsedList.where).toHaveLength(6);
    expect(parsedList.sort).toBe('prop.arrivalDate:asc');
    expect(parsedList.columns).toEqual(['arrivalDate', 'permitType', 'city']);

    const parsedBoard = leadBoardQuerySchema.parse({
      type: 'sim_order',
      where: JSON.stringify([{ key: 'permitType', op: 'eq', value: 'student' }]),
    });
    expect(parsedBoard.where).toEqual([{ key: 'permitType', op: 'eq', value: 'student' }]);
  });

  it('rejects invalid JSON, more than 10 filters, unknown op, value on empty, more than 6 columns and bad sort field', () => {
    expect(leadWhereSchema.safeParse('not-json').success).toBe(false);

    const elevenFilters = JSON.stringify(
      Array.from({ length: 11 }, (_, idx) => ({
        key: 'city',
        op: 'eq',
        value: `City ${idx}`,
      })),
    );
    expect(leadWhereSchema.safeParse(elevenFilters).success).toBe(false);

    expect(
      leadWhereSchema.safeParse(JSON.stringify([{ key: 'city', op: 'regex', value: 'x' }])).success,
    ).toBe(false);

    expect(
      leadWhereSchema.safeParse(JSON.stringify([{ key: 'city', op: 'empty', value: 'x' }])).success,
    ).toBe(false);

    expect(
      leadWhereSchema.safeParse(JSON.stringify([{ key: 'city', op: 'notEmpty', value: 'x' }]))
        .success,
    ).toBe(false);

    expect(leadWhereSchema.safeParse(JSON.stringify([{ key: 'city', op: 'eq' }])).success).toBe(
      false,
    );

    expect(leadColumnsSchema.safeParse('a,b,c,d,e,f,g').success).toBe(false);
    expect(leadColumnsSchema.safeParse('').success).toBe(false);
    expect(leadColumnsSchema.safeParse('city,not a key').success).toBe(false);

    expect(leadSortSchema.safeParse('createdAt:asc').success).toBe(true);
    expect(leadSortSchema.safeParse('updatedAt:desc').success).toBe(true);
    expect(leadSortSchema.safeParse('fullName:asc').success).toBe(true);
    expect(leadSortSchema.safeParse('externalRef:desc').success).toBe(true);
    expect(leadSortSchema.safeParse('prop.city:asc').success).toBe(true);
    expect(leadSortSchema.safeParse('stage:asc').success).toBe(false);
    expect(leadSortSchema.safeParse('createdAt:sideways').success).toBe(false);
    expect(leadSortSchema.safeParse('prop.123bad:asc').success).toBe(false);
  });

  it('validates parsed filters, sorts and columns against the property catalogue and lead type', () => {
    expect(
      areValidLeadPropertyFilters([{ key: 'permitType', op: 'eq', value: 'student' }], 'sim_order'),
    ).toBe(true);
    expect(
      areValidLeadPropertyFilters([{ key: 'permitType', op: 'eq', value: 'unknown' }], 'sim_order'),
    ).toBe(false);
    expect(
      areValidLeadPropertyFilters([{ key: 'dateOfBirth', op: 'eq', value: '1990-01-01' }]),
    ).toBe(false);
    expect(
      areValidLeadPropertyFilters([{ key: 'arrivalDate', op: 'eq', value: '2026-02-30' }]),
    ).toBe(false);
    expect(
      areValidLeadPropertyFilters([{ key: 'permitType', op: 'eq', value: 'student' }], 'internet'),
    ).toBe(false);

    expect(isValidLeadSort('createdAt:asc')).toBe(true);
    expect(isValidLeadSort('prop.city:asc', 'internet')).toBe(true);
    expect(isValidLeadSort('prop.dateOfBirth:asc')).toBe(false);
    expect(isValidLeadSort('prop.permitType:asc', 'internet')).toBe(false);

    expect(areValidLeadColumns(['city', 'planId'], 'internet')).toBe(true);
    expect(areValidLeadColumns(['dateOfBirth'])).toBe(false);
    expect(areValidLeadColumns(['permitType'], 'internet')).toBe(false);
  });
});

describe('applyLeadFormEdit', () => {
  it('changes a field, keeps a chosen plan’s label beside it, and names only what changed', () => {
    expect(
      applyLeadFormEdit('sim_order', order, {
        planId: '75gb-fido',
        arrivalDate: '2026-11-02',
        gotVisa: true,
        reference: '  Batch 12  ',
      }),
    ).toEqual({
      ok: true,
      payload: {
        ...order,
        planId: '75gb-fido',
        planLabel: '75GB · $35, Fido',
        gotVisa: true,
        reference: 'Batch 12',
      },
      changed: ['planId', 'gotVisa', 'reference'],
    });
  });

  it('clears a field with null or an empty text', () => {
    const result = applyLeadFormEdit(
      'sim_order',
      { ...order, reference: 'x', gotVisa: false },
      { reference: '', gotVisa: null },
    );
    expect(result).toEqual({
      ok: true,
      payload: order,
      changed: ['reference', 'gotVisa'],
    });
  });

  it('refuses a field staff may not edit, an unknown one and a value of the wrong kind', () => {
    for (const edit of [
      { customerNotes: 'rewritten' },
      { somethingElse: 'x' },
      { planId: 'not-a-plan' },
      { delivery: 'courier' },
      { arrivalDate: '2026-02-30' },
      { gotVisa: 'yes' },
      { reference: 'r'.repeat(121) },
      { canadaAddress: 'two\nlines' },
      { simNumber: `416${String.fromCharCode(0)}555` },
    ]) {
      const [key] = Object.keys(edit);
      expect(applyLeadFormEdit('sim_order', order, edit)).toEqual({ ok: false, field: key });
    }
    expect(applyLeadFormEdit('internet', {}, { planLabel: 'x' })).toEqual({
      ok: false,
      field: 'planLabel',
    });
  });

  it('keeps a long text’s lines, and needs a shipping address for a mailed SIM', () => {
    expect(
      applyLeadFormEdit('sim_order', order, { shippingAddress: '1 Bay St\r\nToronto ON' }),
    ).toMatchObject({ ok: true, payload: { shippingAddress: '1 Bay St\nToronto ON' } });
    expect(applyLeadFormEdit('sim_order', order, { delivery: 'pickup' })).toEqual({
      ok: false,
      field: 'shippingAddress',
    });
    expect(
      applyLeadFormEdit('sim_order', order, { delivery: 'pickup', shippingAddress: '1 Bay St' }),
    ).toMatchObject({ ok: true, changed: ['delivery', 'shippingAddress'] });
    // An order that already lacked the address can still have its SIM number saved.
    expect(
      applyLeadFormEdit('sim_order', { ...order, delivery: 'pickup' }, { simNumber: '4165550104' }),
    ).toMatchObject({ ok: true, changed: ['simNumber'] });
  });

  it('no longer edits the carrier commission as a form field (it is an order detail)', () => {
    expect(applyLeadFormEdit('sim_order', order, { commissionStatus: 'invoiced' })).toEqual({
      ok: false,
      field: 'commissionStatus',
    });
  });
});
