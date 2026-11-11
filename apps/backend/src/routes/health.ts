import type { Request, Response } from 'express';
import {
  healthResponseSchema,
  readyResponseSchema,
  type HealthResponse,
  type ReadyResponse,
} from '@gt-sales/contracts';

export function getHealth(req: Request, res: Response): void {
  const body: HealthResponse = { ok: true, requestId: req.id };

  // Validates the response against the published contract before sending —
  // catches drift between this handler and @gt-sales/contracts early.
  healthResponseSchema.parse(body);

  res.status(200).json(body);
}

/** How long the readiness check waits for the database before it answers 503. */
export const READY_DATABASE_TIMEOUT_MS = 3_000;

/**
 * GET /api/v1/ready (audit L-7). The liveness route above proves only that the
 * process listens, so a deploy with a broken `DATABASE_URL` passed Railway's
 * health check and replaced a working release. This one answers 200 only
 * after a `select 1` as the runtime role; anything else is 503 with a fixed
 * code (never the error text, which can carry the host).
 */
export function createReadyHandler(
  ping: (timeoutMs: number) => Promise<void>,
): (req: Request, res: Response) => Promise<void> {
  return async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    try {
      await ping(READY_DATABASE_TIMEOUT_MS);
      const body: ReadyResponse = { ok: true, requestId: req.id };
      res.status(200).json(readyResponseSchema.parse(body));
    } catch {
      console.warn(JSON.stringify({ event: 'readiness_failed', code: 'database_unreachable' }));
      const body: ReadyResponse = { ok: false, requestId: req.id, code: 'database_unreachable' };
      res.status(503).json(readyResponseSchema.parse(body));
    }
  };
}
