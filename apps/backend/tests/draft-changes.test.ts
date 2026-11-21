import { describe, expect, it } from 'vitest';

import {
  DRAFT_VALUE_MAX,
  draftSaveBody,
  draftSaveChanges,
  draftSaveValuesOf,
  shownDraftValues,
} from '../src/leads/draft-changes.js';
import { buildPropertyCatalog, codePropertyCatalog } from '@gt-sales/contracts';

const before = {
  contact: { fullName: 'Ada Example', email: 'ada@example.test', phone: null, countryCode: null },
  payload: { delivery: 'pickup', shippingAddress: '1 First Street', flightBooked: false },
  planId: 'plan-a',
  quantity: 1,
};

// Issue #87: what a customer's draft save really changed, for the staff timeline.
describe('draftSaveChanges', () => {
  it('lists only what differs, with the new values as a person reads them', () => {
    const changes = draftSaveChanges({
      leadType: 'sim_order',
      before,
      contact: { fullName: 'Ada Example', phone: '+1 403 555 0100' },
      form: {
        schemaVersion: 1,
        payload: { delivery: 'pickup', shippingAddress: '22 Second Avenue', flightBooked: true },
      },
      order: { planId: 'plan-b', quantity: 1 },
      planName: 'Rogers 60GB',
    });
    expect(changes.fields).toEqual(['phone', 'shippingAddress', 'flightBooked', 'plan']);
    expect(changes.values).toEqual([
      { key: 'phone', value: '+1 403 555 0100' },
      { key: 'shippingAddress', value: '22 Second Avenue' },
      { key: 'flightBooked', value: 'Yes' },
      { key: 'plan', value: 'Rogers 60GB' },
    ]);
  });

  it('finds nothing in a save that repeats what the draft already holds', () => {
    const changes = draftSaveChanges({
      leadType: 'sim_order',
      before,
      contact: { fullName: 'Ada Example', email: 'ada@example.test' },
      form: { schemaVersion: 2, payload: { ...before.payload } },
      order: { planId: 'plan-a', quantity: 1 },
      planName: 'Rogers 30GB',
    });
    expect(changes).toEqual({ fields: [], values: [] });
  });

  it('shows an answer taken away as cleared, and a quantity by its number', () => {
    const changes = draftSaveChanges({
      leadType: 'sim_order',
      before,
      form: { schemaVersion: 1, payload: { delivery: 'esim', flightBooked: false } },
      order: { quantity: 3 },
    });
    expect(changes.values).toEqual([
      { key: 'delivery', value: 'esim' },
      { key: 'shippingAddress', value: '' },
      { key: 'quantity', value: '3' },
    ]);
  });

  it('names a sensitive or unmodelled field without ever keeping its value', () => {
    const internet = draftSaveChanges({
      leadType: 'internet',
      before: { ...before, payload: {} },
      form: { schemaVersion: 1, payload: { dateOfBirth: '1990-01-31', city: 'Calgary' } },
    });
    expect(internet.fields).toEqual(['dateOfBirth', 'city']);
    expect(internet.values).toEqual([{ key: 'city', value: 'Calgary' }]);

    // A type with no modelled form takes any object: its keys are named, its values are not kept.
    const message = draftSaveChanges({
      leadType: 'contact_message',
      before: { ...before, payload: null },
      form: {
        schemaVersion: 1,
        payload: { message: 'Call me', uploadToken: 'gtdg_secret', 'not a key': 1 },
      },
    });
    expect(message.fields).toEqual(['message', 'uploadToken']);
    expect(message.values).toEqual([]);
  });

  it('cuts a long value with care and marks it', () => {
    const long = `${'a'.repeat(DRAFT_VALUE_MAX - 1)}😀 and more`;
    const [value] = draftSaveChanges({
      leadType: 'sim_order',
      before,
      form: { schemaVersion: 1, payload: { ...before.payload, shippingAddress: long } },
    }).values;
    expect(value).toEqual({
      key: 'shippingAddress',
      value: 'a'.repeat(DRAFT_VALUE_MAX - 1),
      cut: true,
    });
  });
});

describe('the stored body', () => {
  it('round-trips the values, and is nothing when there are none or it was erased', () => {
    const values = [
      { key: 'phone', value: '+1 403 555 0100' },
      { key: 'shippingAddress', value: 'x'.repeat(300), cut: true as const },
    ];
    const body = draftSaveBody(values);
    expect(body).not.toBeNull();
    expect(draftSaveValuesOf(body)).toEqual(values);
    expect(draftSaveBody([])).toBeNull();
    expect(draftSaveValuesOf(null)).toBeUndefined();
    expect(draftSaveValuesOf('not json')).toBeUndefined();
    expect(draftSaveValuesOf('{"v":1,"values":[{"key":"phone","value":7}]}')).toBeUndefined();
  });

  it('never exceeds what a timeline body may hold: the last values are left out, not cut', () => {
    const values = Array.from({ length: 40 }, (_, index) => ({
      key: `field${String.fromCharCode(97 + (index % 26))}${index}`,
      value: 'é'.repeat(300),
    }));
    const body = draftSaveBody(values);
    expect(body?.length).toBeLessThanOrEqual(4000);
    const kept = draftSaveValuesOf(body) ?? [];
    expect(kept.length).toBeGreaterThan(5);
    expect(kept.length).toBeLessThan(values.length);
    expect(kept).toEqual(values.slice(0, kept.length));
  });
});

describe('shownDraftValues', () => {
  const values = [
    { key: 'fullName', value: 'Ada Example' },
    { key: 'plan', value: 'Rogers 60GB' },
    { key: 'shippingAddress', value: '22 Second Avenue' },
    { key: 'dateOfBirth', value: '1990-01-31' },
    { key: 'somethingElse', value: 'x' },
  ];

  it('keeps contact, order and visible form values; drops sensitive and unknown ones', () => {
    expect(shownDraftValues(values, 'sim_order', codePropertyCatalog)).toEqual(values.slice(0, 3));
  });

  it('drops the value of a property the site has hidden since', () => {
    const catalog = buildPropertyCatalog([
      {
        object: 'lead',
        key: 'shippingAddress',
        origin: 'builtin',
        label: 'Shipping address',
        kind: 'longText',
        options: [],
        staffOnly: false,
        sensitive: false,
        hidden: true,
        leadTypes: [],
        websiteVisible: false,
        position: 0,
        version: 1,
        createdAt: '2026-11-21T00:00:00.000Z',
        updatedAt: '2026-11-21T00:00:00.000Z',
      },
    ]);
    expect(shownDraftValues(values, 'sim_order', catalog).map((entry) => entry.key)).toEqual([
      'fullName',
      'plan',
    ]);
  });
});
