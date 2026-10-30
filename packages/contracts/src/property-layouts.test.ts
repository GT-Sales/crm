import { describe, expect, it } from 'vitest';

import {
  buildPropertyCatalog,
  codePropertyCatalog,
  defaultPropertyLayout,
  deletePropertyResponseSchema,
  leadTypeCatalog,
  propertyLayoutResponseSchema,
  propertyLayoutRowSchema,
  propertyLayoutSchema,
  propertyModelResponseSchema,
  propertyResponseSchema,
  propertyRowSchema,
  renderPropertyLayout,
  savePropertyLayoutRequestSchema,
  sitePropertySchema,
  type PropertyLayout,
  type PropertyRow,
} from './index';

const STAMP = '2026-10-29T12:00:00.000Z';
const REQUEST_ID = '3f0c6a52-1f0e-4b6e-9d0e-6f2a7f5f1c11';

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

describe('property layout schema', () => {
  it('accepts a layout and the request that saves it', () => {
    const layout: PropertyLayout = {
      sections: [{ id: 'request', label: 'Request', keys: ['city'] }],
    };
    expect(propertyLayoutSchema.safeParse(layout).success).toBe(true);
    expect(savePropertyLayoutRequestSchema.safeParse({ layout }).success).toBe(true);
    expect(savePropertyLayoutRequestSchema.safeParse({ layout, expectedVersion: 2 }).success).toBe(
      true,
    );
    expect(savePropertyLayoutRequestSchema.safeParse({ layout, extra: 1 }).success).toBe(false);
  });

  it('refuses duplicate section ids and duplicate keys', () => {
    const section = (id: string, keys: string[]) => ({ id, label: id, keys });
    expect(
      propertyLayoutSchema.safeParse({ sections: [section('a', ['city']), section('a', [])] })
        .success,
    ).toBe(false);
    expect(
      propertyLayoutSchema.safeParse({
        sections: [section('a', ['city']), section('b', ['city'])],
      }).success,
    ).toBe(false);
    expect(
      propertyLayoutSchema.safeParse({ sections: [section('a', ['city', 'city'])] }).success,
    ).toBe(false);
  });

  it('bounds sections, ids and total keys', () => {
    expect(propertyLayoutSchema.safeParse({ sections: [] }).success).toBe(false);
    expect(
      propertyLayoutSchema.safeParse({ sections: [{ id: 'Bad Id', label: 'x', keys: [] }] })
        .success,
    ).toBe(false);
    expect(
      propertyLayoutSchema.safeParse({ sections: [{ id: 'a', label: '  ', keys: [] }] }).success,
    ).toBe(false);
    const twentyOne = Array.from({ length: 21 }, (_, index) => ({
      id: `s${index}`,
      label: 'S',
      keys: [],
    }));
    expect(propertyLayoutSchema.safeParse({ sections: twentyOne }).success).toBe(false);
    const manyKeys = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) => `k${from + index}`);
    expect(
      propertyLayoutSchema.safeParse({
        sections: [
          { id: 'a', label: 'A', keys: manyKeys(0, 200) },
          { id: 'b', label: 'B', keys: manyKeys(200, 1) },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('defaultPropertyLayout', () => {
  it('puts order, form, staff-only and custom properties in their sections and drops empty ones', () => {
    const layout = defaultPropertyLayout('sim_order', codePropertyCatalog);
    expect(layout.sections.map((s) => s.id)).toEqual(['order', 'request', 'staff']);
    expect(layout.sections.map((s) => s.label)).toEqual(['Order', 'Request', 'Staff details']);
    expect(layout.sections[0]?.keys).toEqual([
      'plan',
      'quantity',
      'paymentStatus',
      'carrierCommission',
    ]);
    expect(layout.sections[1]?.keys).toContain('planId');
    expect(propertyLayoutSchema.safeParse(layout).success).toBe(true);
  });

  it('gives every order type an Order section first and other types none', () => {
    for (const leadType of ['internet', 'mobility']) {
      const layout = defaultPropertyLayout(leadType, codePropertyCatalog);
      expect(layout.sections.map((s) => s.id)).toEqual(['order', 'request']);
      expect(propertyLayoutSchema.safeParse(layout).success, leadType).toBe(true);
    }
    const partner = defaultPropertyLayout('partner_application', codePropertyCatalog);
    expect(partner.sections.map((s) => s.id)).toEqual(['request']);
  });

  it('leaves a hidden order property out of the Order section', () => {
    const catalog = buildPropertyCatalog([
      row({ key: 'quantity', origin: 'builtin', label: 'Quantity', kind: 'count', hidden: true }),
    ]);
    const layout = defaultPropertyLayout('sim_order', catalog);
    expect(layout.sections[0]).toEqual({
      id: 'order',
      label: 'Order',
      keys: ['plan', 'paymentStatus', 'carrierCommission'],
    });
  });

  it('adds a Custom section for custom properties of the type', () => {
    const catalog = buildPropertyCatalog([
      row({ key: 'custom_referral', origin: 'custom', label: 'Referral' }),
      row({ key: 'custom_other_type', origin: 'custom', leadTypes: ['internet'] }),
    ]);
    const layout = defaultPropertyLayout('sim_order', catalog);
    expect(layout.sections.map((s) => s.id)).toEqual(['order', 'request', 'staff', 'custom']);
    expect(layout.sections[3]).toEqual({
      id: 'custom',
      label: 'Custom',
      keys: ['custom_referral'],
    });
  });

  it('puts every custom property in Custom, staff-only ones included, and keeps each key once', () => {
    const catalog = buildPropertyCatalog([
      row({ key: 'custom_internal', origin: 'custom', staffOnly: true }),
    ]);
    const layout = defaultPropertyLayout('sim_order', catalog);
    const keys = layout.sections.flatMap((s) => s.keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(layout.sections.find((s) => s.id === 'custom')?.keys).toEqual(['custom_internal']);
  });

  it('gives a type with no properties one empty Request section that the schema accepts', () => {
    expect(codePropertyCatalog.forType('contact_message')).toEqual([]);
    const layout = defaultPropertyLayout('contact_message', codePropertyCatalog);
    expect(layout).toEqual({ sections: [{ id: 'request', label: 'Request', keys: [] }] });
    expect(propertyLayoutSchema.safeParse(layout).success).toBe(true);
  });

  it('gives every lead type a default layout the schema accepts', () => {
    for (const leadType of Object.keys(leadTypeCatalog)) {
      const layout = defaultPropertyLayout(leadType, codePropertyCatalog);
      expect(propertyLayoutSchema.safeParse(layout).success, leadType).toBe(true);
    }
  });
});

describe('renderPropertyLayout', () => {
  it('skips unknown and hidden keys and appends unplaced ones under "Other"', () => {
    const catalog = buildPropertyCatalog([row({ key: 'city', origin: 'builtin', hidden: true })]);
    const visible = catalog.forType('internet').map((p) => p.key);
    const first = visible.find((key) => key !== 'city');
    expect(first).toBeDefined();
    const layout: PropertyLayout = {
      sections: [{ id: 'main', label: 'Main', keys: ['city', 'nope', ...(first ? [first] : [])] }],
    };
    const rendered = renderPropertyLayout(layout, 'internet', catalog);
    expect(rendered[0]?.id).toBe('main');
    expect(rendered[0]?.properties.map((p) => p.key)).toEqual(first ? [first] : []);
    const other = rendered[rendered.length - 1];
    expect(other?.id).toBe('other');
    expect(other?.label).toBe('Other');
    const placed = rendered.flatMap((s) => s.properties.map((p) => p.key));
    expect(placed.sort()).toEqual([...visible].sort());
    expect(placed).not.toContain('city');
  });

  it('adds no Other section when every visible property is placed', () => {
    const catalog = codePropertyCatalog;
    const layout = defaultPropertyLayout('sim_order', catalog);
    const rendered = renderPropertyLayout(layout, 'sim_order', catalog);
    expect(rendered.map((s) => s.id)).toEqual(['order', 'request', 'staff']);
  });

  it('puts the order properties under Other in a layout saved before they existed', () => {
    const saved: PropertyLayout = {
      sections: [{ id: 'request', label: 'Request', keys: ['planId'] }],
    };
    const rendered = renderPropertyLayout(saved, 'sim_order', codePropertyCatalog);
    expect(rendered.at(-1)?.id).toBe('other');
    expect(rendered.at(-1)?.properties.map((p) => p.key)).toEqual(
      expect.arrayContaining(['plan', 'quantity', 'paymentStatus', 'carrierCommission']),
    );
  });

  it('keeps an empty section of the layout', () => {
    const rendered = renderPropertyLayout(
      { sections: [{ id: 'empty', label: 'Empty', keys: [] }] },
      'sim_order',
      codePropertyCatalog,
    );
    expect(rendered[0]).toMatchObject({ id: 'empty', properties: [] });
  });
});

describe('property model responses', () => {
  const layout: PropertyLayout = {
    sections: [{ id: 'request', label: 'Request', keys: ['city'] }],
  };
  const layoutRow = {
    object: 'lead',
    leadType: 'internet',
    layout,
    version: 1,
    updatedAt: STAMP,
  };

  it('parses layout rows, null updatedAt for the default, and each response', () => {
    expect(propertyLayoutRowSchema.safeParse(layoutRow).success).toBe(true);
    expect(
      propertyLayoutRowSchema.safeParse({ ...layoutRow, version: 0, updatedAt: null }).success,
    ).toBe(true);
    expect(propertyLayoutRowSchema.safeParse({ ...layoutRow, version: -1 }).success).toBe(false);
    expect(
      propertyLayoutResponseSchema.safeParse({ layout: layoutRow, requestId: REQUEST_ID }).success,
    ).toBe(true);
    const property = codePropertyCatalog.all[0];
    expect(property).toBeDefined();
    const wire = sitePropertySchema.parse(property);
    expect(
      propertyModelResponseSchema.safeParse({
        properties: [wire],
        layouts: { internet: layoutRow },
        capabilities: { canManage: true },
        requestId: REQUEST_ID,
      }).success,
    ).toBe(true);
    expect(
      propertyResponseSchema.safeParse({ property: wire, requestId: REQUEST_ID }).success,
    ).toBe(true);
    expect(
      deletePropertyResponseSchema.safeParse({ key: 'custom_x', requestId: REQUEST_ID }).success,
    ).toBe(true);
  });
});
