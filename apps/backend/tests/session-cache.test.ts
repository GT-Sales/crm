import { describe, expect, it, vi } from 'vitest';

import {
  CachedStaffSessionVerifier,
  STAFF_SESSION_CACHE_SECONDS,
  type StaffSessionVerifier,
  type VerifiedStaffSession,
} from '../src/auth/session.js';

const SESSION: VerifiedStaffSession = {
  actorId: '20000000-0000-4000-8000-000000000001',
  verifiedEmail: 'owner@example.test',
};
const START = Date.parse('2026-10-27T05:00:00.000Z');

/** A JWT-shaped token whose payload carries `exp` (seconds); the signature is never checked here. */
function token(expSeconds: number, nonce = 'a'): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'HS256' })}.${part({ exp: expSeconds, n: nonce })}.c2ln`;
}

function setup({ refuse = false } = {}) {
  let now = START;
  const inner = {
    verify: vi.fn<StaffSessionVerifier['verify']>(async () => (refuse ? undefined : SESSION)),
  };
  const verifier = new CachedStaffSessionVerifier(inner, () => now);
  return {
    inner,
    verifier,
    advance(ms: number) {
      now += ms;
    },
  };
}

const HOUR_AHEAD = START / 1000 + 3600;

describe('CachedStaffSessionVerifier', () => {
  it('asks Auth once a minute per token, not once per request', async () => {
    const { inner, verifier, advance } = setup();
    const bearer = token(HOUR_AHEAD);
    await expect(verifier.verify(bearer)).resolves.toEqual(SESSION);
    advance(59_000);
    await expect(verifier.verify(bearer)).resolves.toEqual(SESSION);
    expect(inner.verify).toHaveBeenCalledTimes(1);

    advance(1_000);
    await expect(verifier.verify(bearer)).resolves.toEqual(SESSION);
    expect(inner.verify).toHaveBeenCalledTimes(2);
    expect(STAFF_SESSION_CACHE_SECONDS).toBe(60);
  });

  it('never trusts a token past its own expiry', async () => {
    const { inner, verifier, advance } = setup();
    const bearer = token(START / 1000 + 10);
    await verifier.verify(bearer);
    advance(10_000);
    await verifier.verify(bearer);
    expect(inner.verify).toHaveBeenCalledTimes(2);
  });

  it('remembers nothing about a token Auth refused, or a failed call', async () => {
    const refused = setup({ refuse: true });
    const bearer = token(HOUR_AHEAD);
    await expect(refused.verifier.verify(bearer)).resolves.toBeUndefined();
    await expect(refused.verifier.verify(bearer)).resolves.toBeUndefined();
    expect(refused.inner.verify).toHaveBeenCalledTimes(2);

    const failing = setup();
    failing.inner.verify.mockRejectedValueOnce(new Error('auth unreachable'));
    await expect(failing.verifier.verify(bearer)).rejects.toThrow('auth unreachable');
    await expect(failing.verifier.verify(bearer)).resolves.toEqual(SESSION);
    expect(failing.inner.verify).toHaveBeenCalledTimes(2);
  });

  it('lets concurrent requests with one token share a single Auth call', async () => {
    const { inner, verifier } = setup();
    const bearer = token(HOUR_AHEAD);
    const results = await Promise.all([1, 2, 3].map(() => verifier.verify(bearer)));
    expect(results).toEqual([SESSION, SESSION, SESSION]);
    expect(inner.verify).toHaveBeenCalledTimes(1);
  });

  it('keeps tokens apart', async () => {
    const { inner, verifier } = setup();
    await verifier.verify(token(HOUR_AHEAD, 'one'));
    await verifier.verify(token(HOUR_AHEAD, 'two'));
    expect(inner.verify).toHaveBeenCalledTimes(2);
  });
});
