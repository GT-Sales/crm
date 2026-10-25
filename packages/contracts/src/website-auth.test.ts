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
    expect(
      createServiceCredentialRequestSchema.safeParse({ scopes: ['leads:write'] }).success,
    ).toBe(true);
    expect(createServiceCredentialRequestSchema.safeParse({ scopes: [] }).success).toBe(false);
    expect(
      createServiceCredentialRequestSchema.safeParse({ scopes: ['staff:everything'] }).success,
    ).toBe(false);
  });

  it('round-trips a create response with a one-time secret', () => {
    const value = {
      credential: {
        id: '80000000-0000-4000-8000-000000000101',
        scopes: ['leads:write', 'orders:create'],
        createdAt: '2026-09-14T00:00:00.000Z',
        revokedAt: null,
      },
      secret: 'cplsk_example_secret',
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
