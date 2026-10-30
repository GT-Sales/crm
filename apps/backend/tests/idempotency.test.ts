import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  IDEMPOTENCY_REPLAY_WINDOW_MS,
  IdempotencyError,
  idempotencyKeyHash,
  requestFingerprint,
} from '../src/leads/idempotency.js';

describe('requestFingerprint', () => {
  it('is a sha256 over the canonical JSON', () => {
    expect(requestFingerprint({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('ignores key order at every depth', () => {
    expect(requestFingerprint({ a: 1, b: { c: [1, { d: 2, e: 3 }], f: 'x' } })).toBe(
      requestFingerprint({ b: { f: 'x', c: [1, { e: 3, d: 2 }] }, a: 1 }),
    );
  });

  it('sorts keys by code unit, never by locale', () => {
    // Code-unit order puts `B` (66) before `_` (95) before `a` (97); a
    // locale-aware sort would not, and would vary with the runtime's ICU.
    const canonical = '{"B":2,"_":3,"a":{"Z":5,"b":4}}';
    const expected = `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
    expect(requestFingerprint({ a: { b: 4, Z: 5 }, _: 3, B: 2 })).toBe(expected);
  });

  it('drops undefined members', () => {
    expect(requestFingerprint({ a: 1, b: undefined, c: { d: undefined } })).toBe(
      requestFingerprint({ a: 1, c: {} }),
    );
  });

  it('tells a changed body apart', () => {
    expect(requestFingerprint({ a: 1 })).not.toBe(requestFingerprint({ a: 2 }));
    expect(requestFingerprint([1, 2])).not.toBe(requestFingerprint([2, 1]));
    expect(requestFingerprint({ a: null })).not.toBe(requestFingerprint({}));
  });

  it('refuses values JSON cannot carry faithfully', () => {
    expect(() => requestFingerprint({ a: Number.NaN })).toThrow('invalid_request_fingerprint');
    expect(() => requestFingerprint({ a: Number.POSITIVE_INFINITY })).toThrow(
      'invalid_request_fingerprint',
    );
    expect(() => requestFingerprint({ a: () => 1 })).toThrow('invalid_request_fingerprint');
  });
});

describe('idempotencyKeyHash', () => {
  it('is 64 lower-case hex and never the key itself', () => {
    const hash = idempotencyKeyHash('retry-key-0001');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('retry-key-0001');
    expect(idempotencyKeyHash('retry-key-0001')).toBe(hash);
    expect(idempotencyKeyHash('retry-key-0002')).not.toBe(hash);
  });
});

describe('idempotency constants and errors', () => {
  it('replays for 24 hours', () => {
    expect(IDEMPOTENCY_REPLAY_WINDOW_MS).toBe(86_400_000);
  });

  it('carries its code', () => {
    const error = new IdempotencyError('idempotency_conflict');
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('idempotency_conflict');
    expect(error.name).toBe('IdempotencyError');
  });
});
