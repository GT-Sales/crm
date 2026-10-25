import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Human-visible prefix so a leaked secret is greppable and obviously ours. */
const SECRET_PREFIX = 'cplsk_';
const SECRET_BYTES = 32;

export interface GeneratedServiceSecret {
  /** Shown to the owner exactly once; never persisted. */
  secret: string;
  /** Stored in `service_credentials.secret_hash`. */
  secretHash: string;
}

/** SHA-256 hex of the exact secret string. The secret is high-entropy random, so a fast hash is appropriate (unlike a low-entropy password). */
export function hashServiceSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function generateServiceSecret(): GeneratedServiceSecret {
  const secret = `${SECRET_PREFIX}${randomBytes(SECRET_BYTES).toString('base64url')}`;
  return { secret, secretHash: hashServiceSecret(secret) };
}

/** Extracts a well-formed credential secret from an Authorization header, or undefined. */
export function parseCredentialSecret(authorization: string | undefined): string | undefined {
  if (!authorization || authorization.length > 4_096) return undefined;
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  const token = match?.[1];
  if (!token || !token.startsWith(SECRET_PREFIX) || token.length < SECRET_PREFIX.length + 16) {
    return undefined;
  }
  return token;
}

/** Constant-time comparison for secrets compared in application code (e.g. scheduler secrets). */
export function secretsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
