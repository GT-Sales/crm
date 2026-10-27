import { createHash } from 'node:crypto';

import type { RateLimitInput, RateLimitResult } from '@gt-sales/db';
import { createClient } from '@supabase/supabase-js';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { sendStaffAuthError } from '../http/staff-errors.js';

export interface VerifiedStaffSession {
  actorId: string;
  verifiedEmail: string;
}

export interface StaffSessionVerifier {
  verify(accessToken: string): Promise<VerifiedStaffSession | undefined>;
}

function authClient() {
  const url = process.env.SUPABASE_URL;
  const publishableKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !publishableKey) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required');
  }

  return createClient(url, publishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  }).auth;
}

/** A Supabase access token is always a three-segment base64url JWT. */
export function isJwtShaped(token: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
}

export class SupabaseStaffSessionVerifier implements StaffSessionVerifier {
  async verify(accessToken: string): Promise<VerifiedStaffSession | undefined> {
    // REL-17: a token that cannot be a Supabase JWT never costs an Auth call.
    if (!isJwtShaped(accessToken)) return undefined;
    // A fresh stateless client is created for each request. Identity comes
    // from a Supabase Auth server call for this exact bearer token, never
    // from the token's own claims.
    const auth = authClient();
    const userResult = await auth.getUser(accessToken);
    const user = userResult.data.user;
    if (userResult.error || !user || !user.email || !user.email_confirmed_at) {
      return undefined;
    }

    return { actorId: user.id, verifiedEmail: user.email };
  }
}

/** How long a verified token is trusted without asking Auth again (owner decision, 2026-10-27). */
export const STAFF_SESSION_CACHE_SECONDS = 60;
const STAFF_SESSION_CACHE_MAX_ENTRIES = 1_000;

interface CachedSession {
  /** The verification, shared by concurrent requests carrying the same token. */
  session: Promise<VerifiedStaffSession | undefined>;
  expiresAt: number;
}

/** The token's own `exp`, in milliseconds, read only to cap how long it is cached. */
function tokenExpiry(accessToken: string): number | undefined {
  const payload = accessToken.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof claims !== 'object' || claims === null || !('exp' in claims)) return undefined;
    return typeof claims.exp === 'number' ? claims.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Remembers a successful verification for up to `STAFF_SESSION_CACHE_SECONDS`
 * (never past the token's own expiry), so a staff member clicking around makes
 * one Auth call a minute instead of one per request. The trade, accepted by the
 * owner: a session signed out or revoked in Auth keeps working for at most that
 * long on this instance. Site access is not cached: every request still reads
 * the membership, so removing someone from a site takes effect at once.
 *
 * Only successes are kept, keyed by a hash of the token rather than the token
 * itself; concurrent requests with one token share a single Auth call; the map
 * is bounded, oldest entries leaving first.
 */
export class CachedStaffSessionVerifier implements StaffSessionVerifier {
  private readonly entries = new Map<string, CachedSession>();

  constructor(
    private readonly inner: StaffSessionVerifier,
    private readonly now: () => number = Date.now,
  ) {}

  async verify(accessToken: string): Promise<VerifiedStaffSession | undefined> {
    const key = createHash('sha256').update(accessToken).digest('hex');
    const now = this.now();
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > now) return cached.session;
    if (cached) this.entries.delete(key);

    const session = this.inner.verify(accessToken);
    const expiresAt = Math.min(
      now + STAFF_SESSION_CACHE_SECONDS * 1000,
      tokenExpiry(accessToken) ?? Number.POSITIVE_INFINITY,
    );
    this.entries.set(key, { session, expiresAt });
    while (this.entries.size > STAFF_SESSION_CACHE_MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }

    try {
      const result = await session;
      if (!result) this.forget(key, session);
      return result;
    } catch (error) {
      this.forget(key, session);
      throw error;
    }
  }

  /** Drops an entry, unless a newer verification for the token has replaced it meanwhile. */
  private forget(key: string, session: CachedSession['session']): void {
    if (this.entries.get(key)?.session === session) this.entries.delete(key);
  }
}

let sharedVerifier: StaffSessionVerifier | undefined;

/** The process's one staff verifier: Supabase Auth behind the short cache. */
export function defaultStaffSessionVerifier(): StaffSessionVerifier {
  sharedVerifier ??= new CachedStaffSessionVerifier(new SupabaseStaffSessionVerifier());
  return sharedVerifier;
}

function bearerToken(req: Request): string | undefined {
  const authorization = req.get('authorization');
  if (!authorization || authorization.length > 8_200) return undefined;
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  return match?.[1];
}

export type StaffRateLimit = (input: RateLimitInput) => Promise<RateLimitResult>;

/** Per client IP; generous for a small staff team (REL-17). */
export const STAFF_RATE_LIMIT = { windowSeconds: 60, maxCount: 300 } as const;

export function requireStaffSession(
  verifier: StaffSessionVerifier,
  rateLimit?: StaffRateLimit,
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (rateLimit) {
      let limit: RateLimitResult | undefined;
      try {
        limit = await rateLimit({
          bucketKey: `staff:ip:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`,
          ...STAFF_RATE_LIMIT,
        });
      } catch {
        // The limiter shares the database every staff route needs; failing
        // closed here would turn a limiter fault into a staff lockout.
        limit = undefined;
      }
      if (limit && !limit.allowed) {
        res.setHeader('retry-after', String(limit.retryAfterSeconds));
        res.status(429).json({
          error: {
            code: 'rate_limited',
            message: 'Too many requests. Try again shortly.',
            requestId: req.id,
          },
        });
        return;
      }
    }
    const token = bearerToken(req);
    if (!token) {
      sendStaffAuthError(res, req.id, 'missing_session', 401);
      return;
    }

    try {
      const session = await verifier.verify(token);
      if (!session) {
        sendStaffAuthError(res, req.id, 'invalid_session', 401);
        return;
      }
      req.staffSession = session;
      next();
    } catch {
      sendStaffAuthError(res, req.id, 'invalid_session', 401);
    }
  };
}
