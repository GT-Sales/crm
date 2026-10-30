import type { WebsiteBotAction } from '@gt-sales/contracts';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { RateLimitInput, RateLimitResult, WebsiteCredentialResolution } from '@gt-sales/db';
import { websiteScopeNames, type WebsiteScopeName } from '@gt-sales/types';

import { logRequestError } from '../http/logger.js';
import { sendWebsiteError } from '../http/website-errors.js';
import { sendDomainError } from '../http/domain-errors.js';
import { hashServiceSecret, parseCredentialSecret } from './credential.js';

export interface WebsiteContext {
  /** The credential's own row id — used as `actorId` for its tenant writes (no human actor exists). */
  credentialId: string;
  workspaceId: string;
  callerType: 'website';
  /** Authenticated website server assertion, never an untrusted forwarding header. */
  visitorKey?: string;
  scopes: readonly WebsiteScopeName[];
}

export interface WebsiteRateLimits {
  ipWindowSeconds: number;
  ipMaxCount: number;
  credentialWindowSeconds: number;
  credentialMaxCount: number;
  bootstrapMaxCount?: number;
}

export const DEFAULT_WEBSITE_RATE_LIMITS: WebsiteRateLimits = {
  ipWindowSeconds: 60,
  ipMaxCount: 120,
  credentialWindowSeconds: 60,
  credentialMaxCount: 300,
  bootstrapMaxCount: 1200,
};

export interface WebsiteAuthDependencies {
  resolveCredential(secretHash: string): Promise<WebsiteCredentialResolution | undefined>;
  rateLimit(input: RateLimitInput): Promise<RateLimitResult>;
  /** Route-owned human admission check, separate from authenticated machine reads. */
  botCheck: (req: Request, action: WebsiteBotAction) => boolean | Promise<boolean>;
  limits?: WebsiteRateLimits;
}

const knownScopes = new Set<string>(websiteScopeNames);

function clientIp(req: Request): string {
  // Express trusts no proxy by default. Do not let arbitrary forwarded headers
  // select a fresh limiter bucket; deployment-specific proxy trust is explicit.
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

function context(req: Request): WebsiteContext {
  const value = req.websiteContext;
  if (!value) throw new Error('website credential middleware did not run');
  return value;
}

/**
 * Human admission is run once at each protected write, after the service
 * credential (and its rate limits) and before tenant DB work, so an
 * unauthenticated caller can never make the backend call the provider.
 */
export function requireHumanProof(
  deps: WebsiteAuthDependencies,
  action: WebsiteBotAction,
): RequestHandler {
  return async (req, res, next) => {
    if (!parseCredentialSecret(req.get('authorization'))) {
      sendWebsiteError(res, req.id, 'missing_credential', 401);
      return;
    }
    let admitted = false;
    try {
      admitted = await deps.botCheck(req, action);
    } catch {
      // Fail closed, but visibly: no token or body is logged (invariant 12).
      logRequestError({
        requestId: req.id,
        route: `website:${action}`,
        code: 'bot_check_error',
        flag: 'not_retryable',
      });
    }
    if (!admitted) {
      logRequestError({
        requestId: req.id,
        route: `website:${action}`,
        code: 'bot_check_denied',
        flag: 'not_retryable',
      });
      sendWebsiteError(res, req.id, 'caller_forbidden', 403);
      return;
    }
    next();
  };
}

/** Authenticated machine reads need credentials/scopes/limits, without a browser token. */
export function requireWebsiteCredential(deps: WebsiteAuthDependencies): RequestHandler {
  const limits = deps.limits ?? DEFAULT_WEBSITE_RATE_LIMITS;
  return async (req: Request, res: Response, next: NextFunction) => {
    const secret = parseCredentialSecret(req.get('authorization'));
    if (!secret) {
      sendWebsiteError(res, req.id, 'missing_credential', 401);
      return;
    }

    try {
      const secretHash = hashServiceSecret(secret);
      // Keyed by IP and presented secret so a junk bearer token cannot share
      // (and exhaust) the real credential's bootstrap bucket.
      const ipLimit = await deps.rateLimit({
        bucketKey: `bootstrap:ip:${clientIp(req)}:${secretHash.slice(0, 16)}`,
        windowSeconds: limits.ipWindowSeconds,
        maxCount:
          limits.bootstrapMaxCount ?? Math.max(limits.ipMaxCount, limits.credentialMaxCount * 4),
      });
      if (!ipLimit.allowed) {
        sendWebsiteError(res, req.id, 'rate_limited', 429, {
          'retry-after': String(ipLimit.retryAfterSeconds),
        });
        return;
      }

      const resolution = await deps.resolveCredential(secretHash);
      if (!resolution) {
        sendWebsiteError(res, req.id, 'invalid_credential', 401);
        return;
      }
      if (resolution.revoked) {
        sendWebsiteError(res, req.id, 'credential_revoked', 401);
        return;
      }

      const credentialLimit = await deps.rateLimit({
        bucketKey: `cred:${secretHash}`,
        windowSeconds: limits.credentialWindowSeconds,
        maxCount: limits.credentialMaxCount,
      });
      if (!credentialLimit.allowed) {
        sendWebsiteError(res, req.id, 'rate_limited', 429, {
          'retry-after': String(credentialLimit.retryAfterSeconds),
        });
        return;
      }

      const assertedVisitor = req.get('x-website-visitor-id');
      const visitorKey =
        assertedVisitor && /^[a-f0-9]{64}$/.test(assertedVisitor)
          ? `asserted:${assertedVisitor}`
          : `network:${clientIp(req)}`;
      const visitorLimit = await deps.rateLimit({
        bucketKey: `visitor:${resolution.credentialId}:${visitorKey}`,
        windowSeconds: limits.ipWindowSeconds,
        maxCount: limits.ipMaxCount,
      });
      if (!visitorLimit.allowed) {
        sendWebsiteError(res, req.id, 'rate_limited', 429, {
          'retry-after': String(visitorLimit.retryAfterSeconds),
        });
        return;
      }
      req.websiteContext = {
        credentialId: resolution.credentialId,
        workspaceId: resolution.workspaceId,
        callerType: 'website',
        visitorKey,
        scopes: resolution.scopes.filter((scope): scope is WebsiteScopeName =>
          knownScopes.has(scope),
        ),
      };
      next();
    } catch {
      res.setHeader('retry-after', '2');
      sendDomainError(res, req.id, 'persistence_unavailable', 503, { retryable: true });
    }
  };
}

/** A tighter, per-endpoint budget layered on top of the global IP/credential limits. */
export interface EndpointRateLimit {
  windowSeconds: number;
  maxCount: number;
}

/**
 * Per-endpoint rate limits for the abuse-sensitive public write surface
 * (REQ 37: "rate limits ... on public endpoints"). These are intentionally far
 * tighter than the coarse per-credential ceiling in {@link requireWebsiteCredential}
 * so a flood of one endpoint (e.g. order submissions) is capped without starving
 * the others. Values sized for the Phase A 100-orders/day target with generous
 * headroom for legitimate bursts. Override per deployment via the env reader below.
 */
export const DEFAULT_ENDPOINT_RATE_LIMITS = {
  leads: { windowSeconds: 60, maxCount: 30 },
  // The ID step: an upload authorisation and a submit per customer, retries included.
  identity: { windowSeconds: 60, maxCount: 10 },
  // Customer order tracking, per visitor, on top of its per-email budgets (ruling T10).
  tracking: { windowSeconds: 60, maxCount: 30 },
} as const satisfies Record<string, EndpointRateLimit>;

export type EndpointRateLimitName = keyof typeof DEFAULT_ENDPOINT_RATE_LIMITS;

function positiveIntEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Resolves the per-endpoint budgets, letting a deployment tune each one via
 * `RATE_LIMIT_<ENDPOINT>_MAX` / `RATE_LIMIT_<ENDPOINT>_WINDOW` (e.g.
 * `RATE_LIMIT_ORDERS_MAX`). Invalid or absent values fall back to the defaults.
 */
export function loadEndpointRateLimits(
  env: NodeJS.ProcessEnv = process.env,
): Record<EndpointRateLimitName, EndpointRateLimit> {
  const resolve = (name: EndpointRateLimitName): EndpointRateLimit => {
    const upper = name.toUpperCase();
    const fallback = DEFAULT_ENDPOINT_RATE_LIMITS[name];
    return {
      maxCount: positiveIntEnv(env[`RATE_LIMIT_${upper}_MAX`], fallback.maxCount),
      windowSeconds: positiveIntEnv(env[`RATE_LIMIT_${upper}_WINDOW`], fallback.windowSeconds),
    };
  };
  return {
    leads: resolve('leads'),
    identity: resolve('identity'),
    tracking: resolve('tracking'),
  };
}

/**
 * Gates a single route with a tighter budget keyed by (endpoint, workspace, IP).
 * The website credential middleware must have run first so the workspace is
 * trusted (never caller-supplied). A failure of the durable limiter denies the
 * request rather than silently allowing an unbounded flood.
 */
export function requireEndpointRateLimit(
  deps: Pick<WebsiteAuthDependencies, 'rateLimit'>,
  endpoint: EndpointRateLimitName,
  limit: EndpointRateLimit,
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const ctx = req.websiteContext;
    if (!ctx) {
      // Defence in depth: the credential guard must precede this middleware.
      sendWebsiteError(res, req.id, 'missing_credential', 401);
      return;
    }
    try {
      const outcome = await deps.rateLimit({
        bucketKey: `endpoint:${endpoint}:ws:${ctx.workspaceId}:visitor:${websiteVisitorKey(req)}`,
        windowSeconds: limit.windowSeconds,
        maxCount: limit.maxCount,
      });
      if (!outcome.allowed) {
        sendWebsiteError(res, req.id, 'rate_limited', 429, {
          'retry-after': String(outcome.retryAfterSeconds),
        });
        return;
      }
      next();
    } catch {
      res.setHeader('retry-after', '2');
      sendDomainError(res, req.id, 'persistence_unavailable', 503, { retryable: true });
    }
  };
}

/** Per-route scope guard. The website middleware must have run first. */
export function requireScope(scope: WebsiteScopeName): RequestHandler {
  return (req, res, next) => {
    if (!context(req).scopes.includes(scope)) {
      sendWebsiteError(res, req.id, 'scope_denied', 403);
      return;
    }
    next();
  };
}

export { context as websiteContext };

/** Only credential middleware establishes a trusted assertion. */
export function websiteVisitorKey(req: Request): string {
  return req.websiteContext?.visitorKey ?? `network:${clientIp(req)}`;
}
