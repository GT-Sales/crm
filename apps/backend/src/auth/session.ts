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
