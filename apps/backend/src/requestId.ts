import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Structured request-id middleware. Every request gets a fresh,
 * server-generated id (never trusts a client-supplied one) attached to
 * `req.id` and echoed back on the `x-request-id` response header, so a
 * request can be traced through logs without carrying any PII.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const id = randomUUID();
  req.id = id;
  res.setHeader('x-request-id', id);
  next();
}
