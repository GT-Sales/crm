import { describe, expect, it } from 'vitest';

import { hashContact, normalizeEmail, requireContactHashSecret } from './hash.js';

describe('hashContact', () => {
  it('is stable for the same address and secret', () => {
    const a = hashContact('Person@Example.com', 'a-long-enough-secret-value');
    const b = hashContact('person@example.com ', 'a-long-enough-secret-value');
    expect(a).toBe(b);
  });

  it('differs across secrets so it cannot be matched cross-environment', () => {
    const a = hashContact('person@example.com', 'secret-one-long-enough');
    const b = hashContact('person@example.com', 'secret-two-long-enough');
    expect(a).not.toBe(b);
  });

  it('normalizes case and surrounding whitespace before hashing', () => {
    expect(normalizeEmail(' Foo@Bar.COM ')).toBe('foo@bar.com');
  });
});

describe('requireContactHashSecret', () => {
  it('throws when unset', () => {
    expect(() => requireContactHashSecret({})).toThrow();
  });

  it('throws when too short', () => {
    expect(() => requireContactHashSecret({ EMAIL_CONTACT_HASH_SECRET: 'short' })).toThrow();
  });

  it('returns the configured secret when valid', () => {
    expect(
      requireContactHashSecret({ EMAIL_CONTACT_HASH_SECRET: 'a-sufficiently-long-secret' }),
    ).toBe('a-sufficiently-long-secret');
  });
});
