import { describe, expect, it } from 'vitest';

import {
  authErrorCodeSchema,
  createServiceCredentialRequestSchema,
  createServiceCredentialResponseSchema,
  serviceCredentialSummarySchema,
  websiteAuthErrorCodeSchema,
} from './index';

describe('website auth contracts', () => {
  it('accepts a valid create request and rejects unknown scopes', () => {
    const leadTypes = ['sim_order'];
    expect(
      createServiceCredentialRequestSchema.safeParse({ scopes: ['leads:write'], leadTypes })
        .success,
    ).toBe(true);
    expect(createServiceCredentialRequestSchema.safeParse({ scopes: [], leadTypes }).success).toBe(
      false,
    );
    expect(
      createServiceCredentialRequestSchema.safeParse({ scopes: ['staff:everything'], leadTypes })
        .success,
    ).toBe(false);
  });

  // Issue #84: a key names the registered lead types it may send, each once, at least one.
  it('requires the lead types a key may send', () => {
    const scopes = ['leads:write'];
    const ok = (leadTypes: unknown) =>
      createServiceCredentialRequestSchema.safeParse({ scopes, leadTypes }).success;
    expect(
      ok(['internet', 'mobility', 'sim_order', 'partner_application', 'contact_message']),
    ).toBe(true);
    expect(ok(undefined)).toBe(false);
    expect(ok([])).toBe(false);
    expect(ok(['fax_order'])).toBe(false);
    expect(ok(['internet', 'internet'])).toBe(false);
  });

  it('reads a key with its lead types, with none (not limited) and from an older backend', () => {
    const base = {
      id: '80000000-0000-4000-8000-000000000101',
      scopes: ['leads:write'],
      createdAt: '2026-09-14T00:00:00.000Z',
      revokedAt: null,
    };
    expect(
      serviceCredentialSummarySchema.parse({ ...base, leadTypes: ['internet'] }).leadTypes,
    ).toEqual(['internet']);
    expect(serviceCredentialSummarySchema.parse({ ...base, leadTypes: null }).leadTypes).toBeNull();
    expect(serviceCredentialSummarySchema.parse(base).leadTypes).toBeUndefined();
  });

  it('round-trips a create response with a one-time secret', () => {
    const value = {
      credential: {
        id: '80000000-0000-4000-8000-000000000101',
        scopes: ['leads:write', 'uploads:customer'],
        createdAt: '2026-09-14T00:00:00.000Z',
        revokedAt: null,
      },
      secret: 'gtsk_example_secret',
      requestId: '70000000-0000-4000-8000-000000000101',
    };
    const parsed = createServiceCredentialResponseSchema.parse(value);
    expect(parsed).toEqual(value);
    expect(serviceCredentialSummarySchema.parse(value.credential).revokedAt).toBeNull();
  });

  it('exposes every website error code through the shared auth envelope', () => {
    for (const code of websiteAuthErrorCodeSchema.options) {
      expect(authErrorCodeSchema.safeParse(code).success).toBe(true);
    }
  });
});
