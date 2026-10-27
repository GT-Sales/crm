import { describe, expect, it } from 'vitest';

import {
  applyLeadFormEdit,
  leadCountdownField,
  leadFieldCatalog,
  leadFields,
  leadFormEditSchema,
  leadTypeCatalog,
} from './index';

const order = {
  planId: 'unlimited-data-rogers',
  planLabel: 'Unlimited Data · $40, Rogers',
  delivery: 'esim',
  arrivalDate: '2026-11-02',
  permitType: 'student',
  customerNotes: 'Please call after 6pm',
};

describe('lead field definitions', () => {
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

  it('accepts an edit only of keys shaped like fields, one to forty of them', () => {
    expect(leadFormEditSchema.safeParse({ arrivalDate: '2026-12-01' }).success).toBe(true);
    expect(leadFormEditSchema.safeParse({}).success).toBe(false);
    expect(leadFormEditSchema.safeParse({ 'not a key': 'x' }).success).toBe(false);
    expect(leadFormEditSchema.safeParse({ nested: { a: 1 } }).success).toBe(false);
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

  it('tracks the carrier commission by its states, and clears it', () => {
    const invoiced = applyLeadFormEdit('sim_order', order, { commissionStatus: 'invoiced' });
    expect(invoiced).toMatchObject({ ok: true, payload: { commissionStatus: 'invoiced' } });
    expect(applyLeadFormEdit('sim_order', order, { commissionStatus: 'paid' })).toEqual({
      ok: false,
      field: 'commissionStatus',
    });
    if (!invoiced.ok) throw new Error('unreachable');
    const cleared = applyLeadFormEdit('sim_order', invoiced.payload, { commissionStatus: null });
    expect(cleared).toMatchObject({ ok: true, changed: ['commissionStatus'] });
    expect(cleared.ok && 'commissionStatus' in cleared.payload).toBe(false);
  });
});
