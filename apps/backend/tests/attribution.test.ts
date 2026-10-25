import { describe, expect, it } from 'vitest';

import { sanitizeAttribution } from '../src/leads/attribution.js';

describe('sanitizeAttribution', () => {
  it('keeps every allowlisted UTM field within bounds', () => {
    const result = sanitizeAttribution({
      utmSource: 'google',
      utmMedium: 'cpc',
      utmCampaign: 'sim-launch',
      utmTerm: 'canada sim',
      utmContent: 'ad-1',
    });
    expect(result).toEqual({
      utmSource: 'google',
      utmMedium: 'cpc',
      utmCampaign: 'sim-launch',
      utmTerm: 'canada sim',
      utmContent: 'ad-1',
    });
  });

  it('drops an unknown field entirely', () => {
    const result = sanitizeAttribution({
      utmSource: 'google',
      email: 'someone@example.test',
      sessionToken: 'abc123',
    });
    expect(result).toEqual({ utmSource: 'google' });
    expect('email' in result).toBe(false);
    expect('sessionToken' in result).toBe(false);
  });

  it('strips contact fields even when placed inside attribution', () => {
    const result = sanitizeAttribution({
      fullName: 'Jane Doe',
      phone: '+1 555 0100',
      utmSource: 'google',
    });
    expect(result).toEqual({ utmSource: 'google' });
  });

  it('drops a UTM value longer than 120 characters instead of failing', () => {
    const result = sanitizeAttribution({ utmSource: 'g'.repeat(121) });
    expect(result).toEqual({});
  });

  it('drops an empty or whitespace-only UTM value', () => {
    expect(sanitizeAttribution({ utmSource: '   ' })).toEqual({});
    expect(sanitizeAttribution({ utmSource: '' })).toEqual({});
  });

  it('drops a non-string UTM value', () => {
    expect(sanitizeAttribution({ utmSource: 12345 })).toEqual({});
    expect(sanitizeAttribution({ utmSource: { nested: true } })).toEqual({});
  });

  it('keeps an approved referrer host, case-insensitively', () => {
    expect(sanitizeAttribution({ referrerHost: 'Google.com' })).toEqual({
      referrerHost: 'google.com',
    });
    expect(sanitizeAttribution({ referrerHost: 'm.facebook.com' })).toEqual({
      referrerHost: 'm.facebook.com',
    });
  });

  it('drops a referrer host that is not on the approved allowlist', () => {
    expect(sanitizeAttribution({ referrerHost: 'some-random-tracker.example' })).toEqual({});
  });

  it('reduces an approved full referrer URL to its hostname', () => {
    expect(
      sanitizeAttribution({ referrerHost: 'https://google.com/search?q=x&token=abc' }),
    ).toEqual({ referrerHost: 'google.com' });
  });

  it('keeps a landing path that matches a known route template', () => {
    expect(sanitizeAttribution({ landingPath: '/' })).toEqual({ landingPath: '/' });
    expect(sanitizeAttribution({ landingPath: '/plans' })).toEqual({ landingPath: '/plans' });
    expect(sanitizeAttribution({ landingPath: '/plans/student-20gb' })).toEqual({
      landingPath: '/plans/student-20gb',
    });
  });

  it('strips a query string, fragment and any token from the landing path before storing it', () => {
    expect(sanitizeAttribution({ landingPath: '/plans?utm_source=x&token=secret' })).toEqual({
      landingPath: '/plans',
    });
    expect(sanitizeAttribution({ landingPath: '/plans#access_token=secret' })).toEqual({
      landingPath: '/plans',
    });
  });

  it('drops an arbitrary landing path that matches no known template', () => {
    expect(sanitizeAttribution({ landingPath: '/../../etc/passwd' })).toEqual({});
    expect(sanitizeAttribution({ landingPath: '/a/very/deep/unknown/route' })).toEqual({});
    expect(sanitizeAttribution({ landingPath: '/not-a-real-page' })).toEqual({});
    expect(sanitizeAttribution({ landingPath: '/countries/ca' })).toEqual({});
    expect(sanitizeAttribution({ landingPath: 'not-even-a-path' })).toEqual({});
  });

  it('drops overlong referrer and landing values', () => {
    expect(sanitizeAttribution({ referrerHost: 'x'.repeat(513) })).toEqual({});
    expect(sanitizeAttribution({ landingPath: `/${'x'.repeat(512)}` })).toEqual({});
  });

  it('drops contact data and token-like values hidden in allowlisted UTM fields', () => {
    expect(sanitizeAttribution({ utmSource: 'jane@example.test' })).toEqual({});
    expect(sanitizeAttribution({ utmTerm: '+1 555 123 4567' })).toEqual({});
    expect(sanitizeAttribution({ utmCampaign: 'access_token=secret-value' })).toEqual({});
  });

  it('keeps a bounded partner code verbatim without judging whether it is active', () => {
    expect(sanitizeAttribution({ partnerCode: 'MAPLE10' })).toEqual({ partnerCode: 'MAPLE10' });
  });

  it('drops a partner code longer than 64 characters', () => {
    expect(sanitizeAttribution({ partnerCode: 'X'.repeat(65) })).toEqual({});
  });

  it('returns an empty object for undefined input', () => {
    expect(sanitizeAttribution(undefined)).toEqual({});
  });

  it('never throws on a hostile payload', () => {
    expect(() =>
      sanitizeAttribution({
        utmSource: ['array', 'not', 'string'],
        referrerHost: { toString: () => 'evil' },
        landingPath: null,
        partnerCode: undefined,
      }),
    ).not.toThrow();
  });
});
