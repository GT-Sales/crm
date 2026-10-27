import { describe, expect, it } from 'vitest';
import {
  openSensitiveValue,
  openTrackingCode,
  sealSensitiveValue,
  sealTrackingCode,
  sensitiveFieldsKey,
} from './cipher.js';

const secret = 'a-long-enough-tracking-encryption-secret';
const binding = { workspaceId: 'workspace-a', orderId: 'order-a', challengeId: 'challenge-a' };
describe('encrypted tracking delivery code', () => {
  it('decrypts only with its secret and exact tenant/order/challenge binding', () => {
    const sealed = sealTrackingCode(secret, binding, '123456');
    expect(openTrackingCode(secret, binding, sealed)).toBe('123456');
    expect(openTrackingCode('other-key', binding, sealed)).toBeUndefined();
    for (const field of ['workspaceId', 'orderId', 'challengeId'] as const) {
      expect(openTrackingCode(secret, { ...binding, [field]: 'foreign' }, sealed)).toBeUndefined();
    }
    const tampered = (sealed[0] === 'A' ? 'B' : 'A') + sealed.slice(1);
    expect(openTrackingCode(secret, binding, tampered)).toBeUndefined();
    expect(openTrackingCode(secret, binding, 'malformed')).toBeUndefined();
    expect(sealTrackingCode(secret, binding, '123456')).not.toBe(sealed);
  });
});

describe('sealed sensitive fields (SIN)', () => {
  const key = 'k'.repeat(48);
  const row = {
    workspaceId: '10000000-0000-4000-8000-000000000102',
    recordId: '50000000-0000-4000-8000-000000000001',
    field: 'sin' as const,
  };

  it('opens only with its key and its exact row and field', () => {
    const sealed = sealSensitiveValue(key, row, '046454286');
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain('046454286');
    expect(openSensitiveValue(key, row, sealed)).toBe('046454286');
    expect(openSensitiveValue('j'.repeat(48), row, sealed)).toBeUndefined();
    expect(openSensitiveValue(key, { ...row, recordId: row.workspaceId }, sealed)).toBeUndefined();
    expect(openSensitiveValue(key, { ...row, workspaceId: row.recordId }, sealed)).toBeUndefined();
    // A fresh IV every time: the same SIN never seals to the same text.
    expect(sealSensitiveValue(key, row, '046454286')).not.toBe(sealed);
  });

  it('refuses anything tampered with or malformed', () => {
    const sealed = sealSensitiveValue(key, row, '046454286');
    const parts = sealed.split('.');
    const flipped = (part: string) => (part[0] === 'A' ? 'B' : 'A') + part.slice(1);
    for (const index of [1, 2, 3]) {
      const tampered = parts.map((part, at) => (at === index ? flipped(part) : part)).join('.');
      expect(openSensitiveValue(key, row, tampered)).toBeUndefined();
    }
    for (const bad of [
      '',
      'v2.' + parts.slice(1).join('.'),
      'malformed',
      parts.slice(0, 3).join('.'),
    ]) {
      expect(openSensitiveValue(key, row, bad)).toBeUndefined();
    }
    expect(() => sealSensitiveValue(key, row, '')).toThrow('empty_sensitive_value');
  });

  it('takes its key from SENSITIVE_FIELDS_KEY only when it is long enough to be one', () => {
    expect(sensitiveFieldsKey({})).toBeUndefined();
    expect(sensitiveFieldsKey({ SENSITIVE_FIELDS_KEY: 'short' })).toBeUndefined();
    expect(sensitiveFieldsKey({ SENSITIVE_FIELDS_KEY: ` ${key} ` })).toBe(key);
  });
});
