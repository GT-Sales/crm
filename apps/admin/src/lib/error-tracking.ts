import { buildErrorEvent, type ErrorTrackerContext } from '@gt-sales/observability';

/**
 * Admin's error tracker (REQ 40, IMPLEMENTATION_PLAN §10: "An error-tracking
 * service ... receives exceptions from backend, admin, and jobs with release
 * tags"). Admin only ever talks to the backend API (PLATFORM_CONTEXT §2), so
 * this cannot import `@gt-sales/adapters` (backend-only — enforced by
 * lint, see `packages/config/boundaries.js`); it posts the scrubbed event to
 * Sentry's ingest endpoint directly with `fetch`, which every runtime here
 * (server component, server action, and the browser) already has.
 *
 * `NEXT_PUBLIC_SENTRY_DSN` is a public Sentry key by design (the browser SDK
 * ships it in every page load too) — it authorizes *sending* events to one
 * project, nothing more.
 */

function parseDsn(dsn: string): { publicKey: string; host: string; projectId: string } | undefined {
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.replace(/^\//, '');
    if (!url.username || !url.host || !projectId) return undefined;
    return { publicKey: url.username, host: url.host, projectId };
  } catch {
    return undefined;
  }
}

function releaseTag(): string {
  return process.env.RELEASE_SHA ?? process.env.NEXT_PUBLIC_RELEASE_SHA ?? 'unknown';
}

function environmentTag(): string {
  return (
    process.env.NEXT_PUBLIC_DEPLOYMENT_ENV ??
    process.env.VERCEL_ENV ??
    process.env.NODE_ENV ??
    'unknown'
  );
}

/**
 * Fire-and-forget, matching the backend/jobs tracker: a failed report never
 * throws back into the render/request path that triggered it.
 */
export function captureException(
  error: unknown,
  context: Omit<ErrorTrackerContext, 'release' | 'environment'> & { release?: string },
): void {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn) return;
  const parsed = parseDsn(dsn);
  if (!parsed) return;

  const event = buildErrorEvent(
    error,
    { ...context, release: context.release ?? releaseTag(), environment: environmentTag() },
    'javascript',
  );
  const endpoint = `https://${parsed.host}/api/${parsed.projectId}/store/?sentry_key=${parsed.publicKey}&sentry_version=7`;
  void fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  }).catch(() => {
    // Best-effort delivery only.
  });
}
