import { createHash, randomBytes } from 'node:crypto';

/** Human-visible prefix so a leaked grant token is greppable and obviously ours. */
const GRANT_PREFIX = 'cpldg_';
const GRANT_BYTES = 32;

export interface GeneratedDraftGrantToken {
  /** Returned to the caller exactly once; never persisted. */
  token: string;
  /** Stored in `draft_grants.token_hash`. */
  tokenHash: string;
}

/** SHA-256 hex of the exact token string — the token is high-entropy random, so a fast hash is appropriate. */
export function hashDraftGrantToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateDraftGrantToken(): GeneratedDraftGrantToken {
  const token = `${GRANT_PREFIX}${randomBytes(GRANT_BYTES).toString('base64url')}`;
  return { token, tokenHash: hashDraftGrantToken(token) };
}

/** Extracts a well-formed draft grant token from the `X-Draft-Grant` header, or undefined. */
export function parseDraftGrantToken(header: string | undefined): string | undefined {
  if (!header || header.length > 4_096) return undefined;
  const token = header.trim();
  if (!token.startsWith(GRANT_PREFIX) || token.length < GRANT_PREFIX.length + 16) {
    return undefined;
  }
  return token;
}
