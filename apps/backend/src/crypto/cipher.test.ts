import { describe, expect, it } from 'vitest';
import { openTrackingCode, sealTrackingCode } from './cipher.js';

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
