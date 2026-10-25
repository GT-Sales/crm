import { describe, expect, it } from 'vitest';

import {
  generateServiceSecret,
  hashServiceSecret,
  parseCredentialSecret,
  secretsEqual,
} from '../src/website/credential.js';

describe('service credential secrets', () => {
  it('generates a prefixed secret whose stored hash is deterministic and hides the secret', () => {
    const { secret, secretHash } = generateServiceSecret();
    expect(secret.startsWith('cplsk_')).toBe(true);
    expect(secretHash).toBe(hashServiceSecret(secret));
    expect(secretHash).not.toContain(secret);
    expect(/^[0-9a-f]{64}$/.test(secretHash)).toBe(true);
  });

  it('produces distinct secrets each time', () => {
    expect(generateServiceSecret().secret).not.toBe(generateServiceSecret().secret);
  });

  it('parses only a well-formed bearer credential', () => {
    const { secret } = generateServiceSecret();
    expect(parseCredentialSecret(`Bearer ${secret}`)).toBe(secret);
    expect(parseCredentialSecret(undefined)).toBeUndefined();
    expect(parseCredentialSecret('Bearer not-our-prefix')).toBeUndefined();
    expect(parseCredentialSecret(secret)).toBeUndefined();
    expect(parseCredentialSecret('Bearer cplsk_short')).toBeUndefined();
  });

  it('compares secrets in constant time by value', () => {
    expect(secretsEqual('abc123', 'abc123')).toBe(true);
    expect(secretsEqual('abc123', 'abc124')).toBe(false);
    expect(secretsEqual('abc', 'abcd')).toBe(false);
  });
});
