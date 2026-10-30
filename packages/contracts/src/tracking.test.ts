import { describe, expect, it } from 'vitest';

import {
  CHANGEABLE_FIELD_KEYS,
  CHANGE_REQUEST_DOCUMENTS,
  CHANGE_REQUEST_STAGES,
  MAX_TRACKED_ORDERS,
  TRACKING_CODE_REQUESTS_PER_EMAIL,
  TRACKING_CODE_TTL_MS,
  TRACKING_EMAIL_WINDOW_SECONDS,
  TRACKING_GRANT_HEADER,
  TRACKING_GRANT_TTL_MS,
  TRACKING_MAX_ATTEMPTS,
  TRACKING_MIN_LATENCY_MS,
  TRACKING_STAGE_WORDS,
  TRACKING_VERIFICATIONS_PER_EMAIL,
  TRACKING_WRITES_PER_EMAIL,
  changeRequestFieldsSchema,
  isLeadStage,
  leadTypeCatalog,
  trackingDocumentStateSchema,
  trackingOrderSchema,
  trackingPendingChangeSchema,
  trackingStageWord,
} from './index';

const UUID_A = '00000000-0000-4000-8000-000000000001';
const NOW = '2026-10-30T12:00:00.000Z';

describe('tracking limits', () => {
  it('are the spec’s values', () => {
    expect(TRACKING_CODE_TTL_MS).toBe(600_000);
    expect(TRACKING_MAX_ATTEMPTS).toBe(5);
    expect(TRACKING_EMAIL_WINDOW_SECONDS).toBe(600);
    expect(TRACKING_CODE_REQUESTS_PER_EMAIL).toBe(5);
    expect(TRACKING_VERIFICATIONS_PER_EMAIL).toBe(10);
    expect(TRACKING_WRITES_PER_EMAIL).toBe(30);
    expect(TRACKING_MIN_LATENCY_MS).toBe(500);
    expect(TRACKING_GRANT_TTL_MS).toBe(1_800_000);
    expect(MAX_TRACKED_ORDERS).toBe(50);
    expect(TRACKING_GRANT_HEADER).toBe('X-Customer-Grant');
    expect(CHANGE_REQUEST_DOCUMENTS).toEqual(['passport', 'visa']);
    expect(CHANGEABLE_FIELD_KEYS).toEqual([
      'fullName',
      'phone',
      'planId',
      'delivery',
      'arrivalDate',
      'permitType',
      'canadaAddress',
      'shippingAddress',
      'flightBooked',
    ]);
  });
});

describe('the fields a customer may change', () => {
  it('accepts a phone and an arrival date', () => {
    const fields = { phone: '+1 647 555 0123', arrivalDate: '2026-11-20' };
    expect(changeRequestFieldsSchema.parse(fields)).toEqual(fields);
  });

  it('trims, and clears an address with null', () => {
    expect(
      changeRequestFieldsSchema.parse({ fullName: '  Nadia Khan ', canadaAddress: null }),
    ).toEqual({ fullName: 'Nadia Khan', canadaAddress: null });
  });

  it('accepts every changeable field at once and nothing else', () => {
    const all = {
      fullName: 'Nadia Khan',
      phone: '647-555-0123',
      planId: UUID_A,
      delivery: 'pickup',
      arrivalDate: '2026-11-20',
      permitType: 'student',
      canadaAddress: '1 Front St W, Toronto',
      shippingAddress: '1 Front St W, Toronto ON M5J 2X6',
      flightBooked: true,
    };
    expect(Object.keys(changeRequestFieldsSchema.parse(all))).toEqual([...CHANGEABLE_FIELD_KEYS]);
  });

  it.each([
    ['an email', { email: 'nadia@example.com' }],
    ['a website plan slug', { planId: 'unlimited-data-rogers' }],
    ['a date that is not on the calendar', { arrivalDate: '2026-02-30' }],
    ['an unknown delivery', { delivery: 'airport' }],
    ['a one-letter shipping address', { shippingAddress: 'x' }],
    ['a phone with six digits', { phone: '123-456' }],
    ['a one-letter name', { fullName: 'N' }],
    ['an unknown permit type', { permitType: 'visitor' }],
  ])('refuses %s', (_label, fields) => {
    expect(changeRequestFieldsSchema.safeParse(fields).success).toBe(false);
  });
});

describe('the customer’s words for a stage', () => {
  it('reads a SIM order’s stages as the customer would', () => {
    expect(trackingStageWord('sim_order', 'on_hold')).toBe('Waiting on you');
    expect(trackingStageWord('sim_order', 'cancelled')).toBe('Cancelled');
    expect(trackingStageWord('sim_order', 'pending')).toBe('Received');
    expect(trackingStageWord('internet', 'non_serviceable_address')).toBe('Closed');
    expect(trackingStageWord('mobility', 'activated')).toBe('Active');
  });

  it('falls back to "In progress" for a stage it does not list', () => {
    expect(trackingStageWord('sim_order', 'paid')).toBe('In progress');
    expect(trackingStageWord('contact_message', 'new')).toBe('In progress');
  });

  it('has a word for every stage of the three order types, except a checkout never finished', () => {
    for (const leadType of ['sim_order', 'internet', 'mobility'] as const) {
      for (const { key } of leadTypeCatalog[leadType].stages) {
        if (leadType === 'sim_order' && key === 'incomplete') continue;
        expect(TRACKING_STAGE_WORDS[leadType][key], `${leadType} ${key}`).toBeDefined();
      }
      for (const key of Object.keys(TRACKING_STAGE_WORDS[leadType])) {
        expect(isLeadStage(leadType, key), `${leadType} ${key}`).toBe(true);
      }
    }
  });

  it('allows a change request only at SIM order stages', () => {
    expect(CHANGE_REQUEST_STAGES).toEqual(['pending', 'verified', 'on_hold']);
    for (const stage of CHANGE_REQUEST_STAGES) expect(isLeadStage('sim_order', stage)).toBe(true);
  });
});

describe('a tracked order', () => {
  const order = {
    reference: 'MS-153',
    leadType: 'sim_order',
    stage: 'pending',
    stageLabel: 'Received',
    submittedAt: NOW,
    plan: { id: UUID_A, name: 'Unlimited data', priceMinor: 4000, billingPeriod: '30_days' },
    quantity: 1,
    delivery: 'esim',
    courier: null,
    trackingNumber: null,
    dispatchedAt: null,
    simNumber: null,
    details: {
      fullName: 'Nadia Khan',
      phone: null,
      arrivalDate: '2026-11-20',
      permitType: 'student',
      canadaAddress: null,
      shippingAddress: null,
      flightBooked: false,
    },
    documents: [{ documentType: 'passport', state: 'missing' }],
    canRequestChange: true,
    pendingChange: {
      requestNo: 4,
      fields: { phone: '+1 647 555 0123' },
      documents: ['visa'],
      createdAt: NOW,
      updatedAt: NOW,
    },
  };

  it('parses, its pending change included', () => {
    expect(trackingOrderSchema.parse(order)).toEqual(order);
    expect(trackingPendingChangeSchema.parse(order.pendingChange)).toEqual(order.pendingChange);
  });

  it('carries no payment, commission, notes or assignee', () => {
    expect(trackingOrderSchema.safeParse({ ...order, paymentStatus: 'paid' }).success).toBe(false);
    expect(trackingOrderSchema.safeParse({ ...order, assignedActorId: UUID_A }).success).toBe(
      false,
    );
  });

  it('names a document’s state, never a link to it', () => {
    expect(trackingDocumentStateSchema.options).toEqual([
      'missing',
      'received',
      'approved',
      'needs_replacement',
    ]);
    expect(
      trackingOrderSchema.safeParse({
        ...order,
        documents: [{ documentType: 'passport', state: 'pending' }],
      }).success,
    ).toBe(false);
  });

  it('refuses a pending change with a document type the customer cannot send', () => {
    expect(
      trackingPendingChangeSchema.safeParse({ ...order.pendingChange, documents: ['selfie'] })
        .success,
    ).toBe(false);
  });
});
