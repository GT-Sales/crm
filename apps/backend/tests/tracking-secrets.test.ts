import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TRACKING_GRANT_TTL_MS } from '@gt-sales/contracts';

import { openTrackingCode, sealTrackingCode, sealTrackingEmail } from '../src/crypto/cipher.js';
import {
  codeBindingHash,
  emailBindingHash,
  emailRateBucket,
  generateTrackingCode,
  hashesEqual,
  loadTrackingSecret,
  normalizeTrackingEmail,
  signTrackingGrant,
  verifyTrackingGrant,
} from '../src/tracking/secrets.js';

// Ported from Canadian Plans' tracking/secrets.test.ts and cipher.test.ts.
const SECRET = 'test-secret-value-that-is-long-enough-32';
const SITE_A = '00000000-0000-4000-8000-000000006401';
const SITE_B = '00000000-0000-4000-8000-000000006402';
const CHALLENGE_1 = '00000000-0000-4000-8000-000000006411';
const CHALLENGE_2 = '00000000-0000-4000-8000-000000006412';
const NADIA = 'nadia@example.com';

describe('tracking hashing', () => {
  it('binds the email hash to the site and the normalized email', () => {
    const a = emailBindingHash(SECRET, SITE_A, NADIA);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(emailBindingHash(SECRET, SITE_A, NADIA));
    expect(a).not.toBe(emailBindingHash(SECRET, SITE_A, 'omar@example.com'));
    expect(a).not.toBe(emailBindingHash(SECRET, SITE_B, NADIA));
    expect(a).not.toBe(emailBindingHash('another-secret-value-long-enough-00', SITE_A, NADIA));
    expect(a).toBe(
      createHmac('sha256', SECRET).update(`email:v1\n${SITE_A}\n${NADIA}`).digest('hex'),
    );
  });

  it('gives the same hash for an email typed with spaces and capitals', () => {
    expect(emailBindingHash(SECRET, SITE_A, normalizeTrackingEmail(' Nadia@Example.COM '))).toBe(
      emailBindingHash(SECRET, SITE_A, NADIA),
    );
  });

  it('normalizes as Postgres lower(btrim(...)) does: spaces only, then lower case', () => {
    expect(normalizeTrackingEmail('  Nadia@Example.COM  ')).toBe(NADIA);
    // btrim strips only spaces, so neither does this: a tab or a no-break space stays.
    expect(normalizeTrackingEmail('\tNadia@Example.com')).toBe('\tnadia@example.com');
    expect(normalizeTrackingEmail('nadia@example.com\u00a0')).toBe('nadia@example.com\u00a0');
    expect(normalizeTrackingEmail('   ')).toBe('');
  });

  it('binds the code hash to the site, the email and the code', () => {
    const code = codeBindingHash(SECRET, SITE_A, NADIA, '123456');
    expect(code).toMatch(/^[0-9a-f]{64}$/);
    expect(code).not.toBe(codeBindingHash(SECRET, SITE_A, NADIA, '654321'));
    expect(code).not.toBe(codeBindingHash(SECRET, SITE_B, NADIA, '123456'));
    expect(code).not.toBe(codeBindingHash(SECRET, SITE_A, 'omar@example.com', '123456'));
    // A code hash is never the email's hash.
    expect(code).not.toBe(emailBindingHash(SECRET, SITE_A, NADIA));
  });

  it('keeps the email out of the rate buckets, one counter per purpose and site', () => {
    const buckets = (['code', 'verify', 'write'] as const).map((purpose) =>
      emailRateBucket(SECRET, SITE_A, NADIA, purpose),
    );
    expect(buckets[0]).toMatch(/^tracking:code:[0-9a-f]{64}$/);
    expect(buckets[1]).toMatch(/^tracking:verify:[0-9a-f]{64}$/);
    expect(buckets[2]).toMatch(/^tracking:write:[0-9a-f]{64}$/);
    for (const bucket of buckets) {
      expect(bucket).not.toContain('nadia');
      expect(bucket).not.toContain('example');
    }
    expect(new Set(buckets.map((bucket) => bucket.split(':')[2])).size).toBe(3);
    expect(emailRateBucket(SECRET, SITE_A, NADIA, 'code')).not.toBe(
      emailRateBucket(SECRET, SITE_B, NADIA, 'code'),
    );
  });

  it('draws six-digit codes', () => {
    for (let draw = 0; draw < 1000; draw += 1) {
      expect(generateTrackingCode()).toMatch(/^\d{6}$/);
    }
  });

  it('compares hashes in constant time, never matching empty or unequal lengths', () => {
    const hash = codeBindingHash(SECRET, SITE_A, NADIA, '000000');
    expect(hashesEqual(hash, hash)).toBe(true);
    expect(hashesEqual(hash, codeBindingHash(SECRET, SITE_A, NADIA, '000001'))).toBe(false);
    expect(hashesEqual('', '')).toBe(false);
    expect(hashesEqual(hash, hash.slice(1))).toBe(false);
    expect(hashesEqual('zz', 'aa')).toBe(false);
  });
});

describe('the sealed code', () => {
  it('opens for its own challenge and site only', () => {
    const sealed = sealTrackingCode(
      SECRET,
      { workspaceId: SITE_A, challengeId: CHALLENGE_1 },
      '042137',
    );
    expect(
      openTrackingCode(SECRET, { workspaceId: SITE_A, challengeId: CHALLENGE_1 }, sealed),
    ).toBe('042137');
    expect(
      openTrackingCode(SECRET, { workspaceId: SITE_A, challengeId: CHALLENGE_2 }, sealed),
    ).toBeUndefined();
    expect(
      openTrackingCode(SECRET, { workspaceId: SITE_B, challengeId: CHALLENGE_1 }, sealed),
    ).toBeUndefined();
  });

  it('refuses a 101-character input', () => {
    expect(
      openTrackingCode(SECRET, { workspaceId: SITE_A, challengeId: CHALLENGE_1 }, 'A'.repeat(101)),
    ).toBeUndefined();
  });
});

describe('tracking grant', () => {
  const NOW = Date.parse('2026-10-30T12:00:00.000Z');
  const sign = () =>
    signTrackingGrant(SECRET, { workspaceId: SITE_A, normalizedEmail: NADIA }, NOW);

  /** Re-signs an edited body, as an attacker who somehow held the key would. */
  /** The grant's own signing key: derived from the secret for this purpose only. */
  const GRANT_KEY = createHmac('sha256', SECRET).update('gt-sales-crm:tracking-grant:v1').digest();

  function resign(body: Record<string, unknown>, key: Buffer | string = GRANT_KEY): string {
    const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
    return `${encoded}.${createHmac('sha256', key).update(encoded).digest('base64url')}`;
  }

  function bodyOf(token: string): Record<string, unknown> {
    return z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8')));
  }

  it('lasts 30 minutes and proves the site and the email, which it never shows', () => {
    const grant = sign();
    expect(Date.parse(grant.expiresAt) - NOW).toBe(TRACKING_GRANT_TTL_MS);
    expect(TRACKING_GRANT_TTL_MS).toBe(1_800_000);
    expect(
      Buffer.from(grant.token.split('.')[0] ?? '', 'base64url').toString('utf8'),
    ).not.toContain(NADIA);
    expect(Object.keys(bodyOf(grant.token)).sort()).toEqual(
      ['emailHash', 'exp', 'sealedEmail', 'v', 'workspaceId'].sort(),
    );
    expect(bodyOf(grant.token)['v']).toBe(1);

    const identity = {
      workspaceId: SITE_A,
      normalizedEmail: NADIA,
      emailHash: emailBindingHash(SECRET, SITE_A, NADIA),
    };
    expect(verifyTrackingGrant(SECRET, grant.token, NOW)).toEqual(identity);
    expect(verifyTrackingGrant(SECRET, grant.token, NOW + TRACKING_GRANT_TTL_MS - 1)).toEqual(
      identity,
    );
    expect(verifyTrackingGrant(SECRET, grant.token, NOW + 1_800_000)).toBeUndefined();
  });

  it('names its own site, which the caller compares with the site asking', () => {
    const identity = verifyTrackingGrant(SECRET, sign().token, NOW);
    expect(identity?.workspaceId).toBe(SITE_A);
    expect(identity?.workspaceId).not.toBe(SITE_B);
  });

  it('refuses a tampered body, signature or sealed email, another key and garbage', () => {
    const grant = sign();
    const [body, signature] = grant.token.split('.');
    const flip = (part: string) => (part[0] === 'A' ? 'B' : 'A') + part.slice(1);
    expect(verifyTrackingGrant(SECRET, `${flip(body ?? '')}.${signature}`, NOW)).toBeUndefined();
    expect(verifyTrackingGrant(SECRET, `${body}.${flip(signature ?? '')}`, NOW)).toBeUndefined();
    expect(verifyTrackingGrant(SECRET, `${grant.token}x`, NOW)).toBeUndefined();
    const original = bodyOf(grant.token);
    const sealed = String(original['sealedEmail']);
    expect(
      verifyTrackingGrant(SECRET, resign({ ...original, sealedEmail: flip(sealed) }), NOW),
    ).toBeUndefined();
    expect(
      verifyTrackingGrant('another-secret-value-long-enough-00', grant.token, NOW),
    ).toBeUndefined();
    for (const bad of ['', 'garbage', '.', 'a.', '.b']) {
      expect(verifyTrackingGrant(SECRET, bad, NOW)).toBeUndefined();
    }
  });

  it('refuses a grant whose sealed email does not match its email hash', () => {
    const emailHash = emailBindingHash(SECRET, SITE_A, NADIA);
    const swapped = sealTrackingEmail(
      SECRET,
      { workspaceId: SITE_A, emailHash },
      'mallory@example.com',
    );
    const token = resign({
      v: 1,
      workspaceId: SITE_A,
      emailHash,
      sealedEmail: swapped,
      exp: NOW + 60_000,
    });
    expect(verifyTrackingGrant(SECRET, token, NOW)).toBeUndefined();
  });

  it('refuses a sealed email moved to another site', () => {
    const token = resign({
      ...bodyOf(sign().token),
      workspaceId: SITE_B,
      emailHash: emailBindingHash(SECRET, SITE_B, NADIA),
    });
    expect(verifyTrackingGrant(SECRET, token, NOW)).toBeUndefined();
  });

  it('is signed with a key derived for grants, never the raw secret', () => {
    const body = bodyOf(sign().token);
    expect(verifyTrackingGrant(SECRET, resign(body), NOW)).toBeDefined();
    expect(verifyTrackingGrant(SECRET, resign(body, SECRET), NOW)).toBeUndefined();
  });

  it('refuses an extra key, another version and an order-bound grant', () => {
    const body = bodyOf(sign().token);
    expect(verifyTrackingGrant(SECRET, resign(body), NOW)).toBeDefined();
    expect(verifyTrackingGrant(SECRET, resign({ ...body, extra: 1 }), NOW)).toBeUndefined();
    expect(verifyTrackingGrant(SECRET, resign({ ...body, v: 2 }), NOW)).toBeUndefined();
    expect(
      verifyTrackingGrant(
        SECRET,
        resign({ workspaceId: SITE_A, orderId: CHALLENGE_1, emailHash: 'abc', exp: NOW + 60_000 }),
        NOW,
      ),
    ).toBeUndefined();
  });
});

describe('loadTrackingSecret', () => {
  it('takes TRACKING_HASH_SECRET trimmed, only when it is at least 32 characters', () => {
    expect(loadTrackingSecret({})).toBeUndefined();
    expect(loadTrackingSecret({ TRACKING_HASH_SECRET: 'x'.repeat(31) })).toBeUndefined();
    expect(loadTrackingSecret({ TRACKING_HASH_SECRET: `  ${'x'.repeat(31)}  ` })).toBeUndefined();
    expect(loadTrackingSecret({ TRACKING_HASH_SECRET: 'x'.repeat(32) })).toBe('x'.repeat(32));
    expect(loadTrackingSecret({ TRACKING_HASH_SECRET: ` ${SECRET} ` })).toBe(SECRET);
  });
});
