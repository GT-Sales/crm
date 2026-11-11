import { rateLimitHit, type RateLimitInput, type RateLimitResult } from '@gt-sales/db';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { sendDomainError } from './domain-errors.js';
import { sendWebsiteError } from './website-errors.js';

export type MachineRateLimit = (input: RateLimitInput) => Promise<RateLimitResult>;

/** Attempts at a machine endpoint (a scheduler secret) per client IP. */
export const MACHINE_ATTEMPTS = { windowSeconds: 60, maxCount: 10 } as const;

export const defaultMachineRateLimit: MachineRateLimit = rateLimitHit;

/**
 * Counts every request to an internal machine endpoint against its client IP
 * BEFORE the secret is checked, so the secret cannot be guessed at line speed
 * from the internet (audit L-10). Fails closed: if the limiter cannot answer,
 * the request is refused rather than left unbounded, because an outage must
 * not be the moment a guess becomes free. Without a limiter (route tests) the
 * budget is skipped.
 */
export function requireMachineAttemptBudget(
  name: string,
  rateLimit: MachineRateLimit | undefined,
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!rateLimit) {
      next();
      return;
    }
    try {
      const outcome = await rateLimit({
        bucketKey: `machine:${name}:ip:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`,
        ...MACHINE_ATTEMPTS,
      });
      if (!outcome.allowed) {
        sendWebsiteError(res, req.id, 'rate_limited', 429, {
          'retry-after': String(outcome.retryAfterSeconds),
        });
        return;
      }
    } catch {
      res.setHeader('retry-after', '2');
      sendDomainError(res, req.id, 'persistence_unavailable', 503, { retryable: true });
      return;
    }
    next();
  };
}
