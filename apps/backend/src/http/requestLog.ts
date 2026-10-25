import type { NextFunction, Request, Response } from 'express';
import { logEvent } from '@gt-sales/adapters';

/**
 * Structured per-request access log (REQ 40, IMPLEMENTATION_PLAN §10:
 * "Structured JSON logs with request ID, workspace ID, actor ID, and
 * route"). Runs after every request completes (`res.on('finish')`) so it
 * always has the final status code, and pulls workspace/actor identity from
 * whichever auth middleware ran (staff session, website credential, or a
 * route's own `:workspaceId` param) rather than requiring every route to log
 * itself. Never logs the request body, query string, or any header value.
 */
function paramWorkspaceId(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function requestLog(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    logEvent({
      event: 'http_request',
      requestId: req.id,
      workspaceId: req.websiteContext?.workspaceId ?? paramWorkspaceId(req.params?.workspaceId),
      actorId: req.staffSession?.actorId ?? req.websiteContext?.credentialId,
      route:
        (req.route?.path ? `${req.baseUrl}${req.route.path}` : req.baseUrl || req.path) || req.path,
      durationMs,
      extra: { status: res.statusCode, method: req.method },
    });
  });
  next();
}
