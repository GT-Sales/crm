import { describe, expect, it } from 'vitest';

import {
  SIM_ORDER_DELIVERIES,
  SIM_ORDER_PERMIT_TYPES,
  SIM_ORDER_REF_PREFIX,
  leadTypeProperties,
  parseSimOrderRef,
  simOrderLeadPayloadSchema,
  simOrderRef,
} from './index';

const complete = {
  planId: 'unlimited-data-rogers',
  delivery: 'pickup',
  shippingAddress: '12 King St W, Toronto ON',
  arrivalDate: '2026-11-20',
  permitType: 'student',
  gotVisa: true,
  flightBooked: false,
  reference: 'agent@example.com',
};

const optionValues = (key: string): string[] =>
  (leadTypeProperties['sim_order'] ?? [])
    .find((use) => use.key === key)
    ?.options?.map((option) => option.value) ?? [];

describe('the SIM order payload', () => {
  it('accepts an empty draft and a complete order', () => {
    expect(simOrderLeadPayloadSchema.parse({})).toEqual({});
    expect(simOrderLeadPayloadSchema.parse(complete)).toEqual(complete);
  });

  it.each([
    ['a SIM number (staff only)', { simNumber: '+16475550123' }],
    ['an email (it travels in contact)', { email: 'nadia@example.com' }],
    ['a delivery it does not offer', { delivery: 'airport' }],
    ['a permit type it does not list', { permitType: 'visitor' }],
    ['a date not shaped YYYY-MM-DD', { arrivalDate: '20-11-2026' }],
    ['a 401-character shipping address', { shippingAddress: 'a'.repeat(401) }],
  ])('refuses %s', (_name, payload) => {
    expect(simOrderLeadPayloadSchema.safeParse({ ...complete, ...payload }).success).toBe(false);
  });

  it('offers exactly the deliveries and permit types the lead record lists', () => {
    expect([...SIM_ORDER_DELIVERIES]).toEqual(optionValues('delivery'));
    expect([...SIM_ORDER_PERMIT_TYPES]).toEqual(optionValues('permitType'));
  });
});

describe('order references', () => {
  it('writes MS-<n>', () => {
    expect(SIM_ORDER_REF_PREFIX).toBe('MS-');
    expect(simOrderRef(153)).toBe('MS-153');
    expect(simOrderRef(1)).toBe('MS-1');
  });

  it('refuses a number below 1 or not whole', () => {
    expect(() => simOrderRef(0)).toThrow();
    expect(() => simOrderRef(-4)).toThrow();
    expect(() => simOrderRef(1.5)).toThrow();
  });

  it('reads MS-<n> back and nothing else', () => {
    expect(parseSimOrderRef('MS-153')).toBe(153);
    expect(parseSimOrderRef('MS-999999999')).toBe(999999999);
    for (const ref of ['MS-0', 'PT-5', 'MS-12a', 'MS-', 'MS-0153', 'ms-153', 'MS-1234567890']) {
      expect(parseSimOrderRef(ref), ref).toBeUndefined();
    }
  });
});
