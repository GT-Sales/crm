import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';
import { TRACKING_GRANT_TTL_MS } from '@gt-sales/contracts';

import { openTrackingEmail, sealTrackingEmail } from '../crypto/cipher.js';

/**
 * Tracking hashes, codes and the customer's grant (ported from Canadian
 * Plans' `tracking/secrets.ts`). Every stored value is a keyed hash bound to
 * the site and the normalized email (`normalizeTrackingEmail`, done by the
 * caller), so the six-digit code is never kept readable and a hash from one
 * site or email never matches another. The grant is a stateless HMAC-signed
 * token carrying the verified email sealed, so the backend can list that
 * email's orders without the website ever holding a readable address.
 *
 * Pure: no database and no environment read but `loadTrackingSecret`.
 */

/**
 * The email as tracking hashes and matches it: spaces trimmed from both ends,
 * then lower case. Exactly the lookup's `lower(btrim(leads.email))` (btrim
 * strips spaces only, so a tab or a no-break space stays here too), so the
 * hashed email and the matched email are the same string.
 */
export function normalizeTrackingEmail(email: string): string {
  return email.replace(/^ +| +$/g, '').toLowerCase();
}

function hmac(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

/** The keyed hash of the normalized email within one site. */
export function emailBindingHash(
  secret: string,
  workspaceId: string,
  normalizedEmail: string,
): string {
  return hmac(secret, `email:v1\n${workspaceId}\n${normalizedEmail}`);
}

/** The keyed hash of one code for one site and normalized email. */
export function codeBindingHash(
  secret: string,
  workspaceId: string,
  normalizedEmail: string,
  code: string,
): string {
  return hmac(secret, `code:v1\n${workspaceId}\n${normalizedEmail}\n${code}`);
}

/**
 * A per-email rate-limit bucket key that never puts the email in the bucket
 * row. Asking for a code, verifying one and writing count separately: a shared
 * counter let a few mistyped codes block the next code request.
 */
export function emailRateBucket(
  secret: string,
  workspaceId: string,
  normalizedEmail: string,
  purpose: 'code' | 'verify' | 'write',
): string {
  return `tracking:${purpose}:${hmac(secret, `rate\n${purpose}\n${workspaceId}\n${normalizedEmail}`)}`;
}

/** A cryptographically random six-digit code. */
export function generateTrackingCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/** Constant-time equality of two hashes; false for an empty value or unequal lengths. */
export function hashesEqual(a: string, b: string): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

const grantBodySchema = z
  .object({
    v: z.literal(1),
    workspaceId: z.uuid(),
    emailHash: z.string().regex(/^[0-9a-f]{64}$/),
    sealedEmail: z.string().min(1).max(1_024),
    exp: z.int().positive(),
  })
  .strict();

/** What a valid grant proves: a visitor of this site verified this email. */
export interface TrackingGrantIdentity {
  workspaceId: string;
  normalizedEmail: string;
  emailHash: string;
}

/** The grant's signing key, derived for this purpose only, as the cipher derives its keys. */
function grantKey(secret: string): Buffer {
  return createHmac('sha256', secret).update('gt-sales-crm:tracking-grant:v1').digest();
}

function sign(secret: string, body: string): string {
  return createHmac('sha256', grantKey(secret)).update(body).digest('base64url');
}

/** Signs a stateless 30-minute grant bound to the site and the verified email. */
export function signTrackingGrant(
  secret: string,
  input: { workspaceId: string; normalizedEmail: string },
  nowMs: number,
): { token: string; expiresAt: string } {
  const exp = nowMs + TRACKING_GRANT_TTL_MS;
  const emailHash = emailBindingHash(secret, input.workspaceId, input.normalizedEmail);
  const sealedEmail = sealTrackingEmail(
    secret,
    { workspaceId: input.workspaceId, emailHash },
    input.normalizedEmail,
  );
  const body = Buffer.from(
    JSON.stringify({ v: 1, workspaceId: input.workspaceId, emailHash, sealedEmail, exp }),
    'utf8',
  ).toString('base64url');
  return { token: `${body}.${sign(secret, body)}`, expiresAt: new Date(exp).toISOString() };
}

/**
 * The identity a grant proves, or undefined when its signature, expiry,
 * sealed email or email hash does not hold. It names the grant's own site;
 * the caller compares that with the site asking.
 */
export function verifyTrackingGrant(
  secret: string,
  token: string,
  nowMs: number,
): TrackingGrantIdentity | undefined {
  const separator = token.lastIndexOf('.');
  if (separator < 1) return undefined;
  const body = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!hashesEqual(signature, sign(secret, body))) return undefined;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  const parsed = grantBodySchema.safeParse(decoded);
  if (!parsed.success || parsed.data.exp <= nowMs) return undefined;
  const { workspaceId, emailHash, sealedEmail } = parsed.data;
  const normalizedEmail = openTrackingEmail(secret, { workspaceId, emailHash }, sealedEmail);
  if (normalizedEmail === undefined) return undefined;
  if (!hashesEqual(emailBindingHash(secret, workspaceId, normalizedEmail), emailHash)) {
    return undefined;
  }
  return { workspaceId, normalizedEmail, emailHash };
}

/** `TRACKING_HASH_SECRET`, trimmed; unset or under 32 characters means tracking is unconfigured. */
export function loadTrackingSecret(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const secret = env.TRACKING_HASH_SECRET?.trim();
  return secret !== undefined && secret.length >= 32 ? secret : undefined;
}
