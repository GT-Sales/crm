import {
  buildErrorEvent,
  type CapturedErrorEvent,
  type ErrorTracker,
  type ErrorTrackerContext,
} from '@gt-sales/observability';

/**
 * Server-only Sentry-class error tracker (REQ 40, IMPLEMENTATION_PLAN §10:
 * "An error-tracking service ... receives exceptions from backend, admin, and
 * jobs with release tags"). Talks to Sentry's classic store endpoint directly
 * over `fetch` — matching the repo's existing hand-rolled-HTTP adapter
 * convention (`ResendEmailAdapter`, `SesEmailAdapter`) rather than adding the
 * `@sentry/*` SDK family as a dependency. Every event is built by
 * {@link buildErrorEvent}, which scrubs the error message before it ever
 * leaves the process (invariant 12) — this class never sees or forwards a
 * raw payload.
 */

export interface SentryDsn {
  publicKey: string;
  host: string;
  projectId: string;
}

/** Parses a standard Sentry DSN (`https://<key>@<host>/<projectId>`). */
export function parseSentryDsn(dsn: string): SentryDsn | undefined {
  try {
    const url = new URL(dsn);
    const publicKey = url.username;
    // Tolerate a trailing slash in SENTRY_DSN; it must not corrupt the project id.
    const projectId = url.pathname.replace(/^\/+|\/+$/g, '');
    if (!publicKey || !url.host || !projectId) return undefined;
    return { publicKey, host: url.host, projectId };
  } catch {
    return undefined;
  }
}

function storeEndpoint(parsed: SentryDsn): string {
  return `https://${parsed.host}/api/${parsed.projectId}/store/?sentry_key=${parsed.publicKey}&sentry_version=7`;
}

export interface SentryHttpErrorTrackerConfig {
  dsn: string;
  /** Deployed release identifier (git SHA, package version). Never a free-text label. */
  release: string;
  environment?: string;
  fetchImpl?: typeof fetch;
  /** Test/inspection hook: called with every event this tracker attempted to send. */
  onEvent?(event: CapturedErrorEvent): void;
}

/**
 * Fire-and-forget: a capture call never throws and never blocks the caller on
 * network I/O, so a failing exception report can't itself take down the
 * request/job that triggered it. A delivery failure is swallowed — there is
 * no secondary tracker to report a tracker failure to.
 */
export class SentryHttpErrorTracker implements ErrorTracker {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: SentryHttpErrorTrackerConfig) {
    const parsed = parseSentryDsn(config.dsn);
    if (!parsed) throw new Error('Error tracker requires a valid Sentry DSN.');
    if (!config.release) throw new Error('Error tracker requires a release identifier.');
    this.endpoint = storeEndpoint(parsed);
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  captureException(error: unknown, context: ErrorTrackerContext): void {
    const event = buildErrorEvent(
      error,
      {
        ...context,
        release: context.release || this.config.release,
        environment: context.environment ?? this.config.environment,
      },
      'node',
    );
    this.config.onEvent?.(event);
    void this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    })
      .then((response) => {
        // Still best-effort, but a rejected DSN/endpoint must not be silent.
        // Never log the endpoint (it carries the public key) or the event.
        if (!response.ok) {
          console.error(
            JSON.stringify({ event: 'error_tracker_delivery_rejected', status: response.status }),
          );
        }
      })
      .catch(() => {
        console.error(JSON.stringify({ event: 'error_tracker_delivery_failed' }));
      });
  }
}

/** Used when no DSN is configured (local dev, CI) so capture calls are inert, not crashing. */
export class NoopErrorTracker implements ErrorTracker {
  captureException(): void {
    // Intentionally does nothing.
  }
}

export interface CreateErrorTrackerOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

/**
 * Builds the process-wide tracker from `SENTRY_DSN`/`RELEASE_SHA`. Unset DSN
 * (local dev, CI, a preview without one configured) yields a no-op tracker
 * rather than throwing, so capturing an exception is always safe to call.
 */
export function createErrorTrackerFromEnv(options: CreateErrorTrackerOptions = {}): ErrorTracker {
  const env = options.env ?? process.env;
  const dsn = env['SENTRY_DSN'];
  if (!dsn) return new NoopErrorTracker();
  const release = env['RELEASE_SHA'] ?? env['npm_package_version'] ?? 'unknown';
  return new SentryHttpErrorTracker({
    dsn,
    release,
    environment: env['DEPLOYMENT_ENV'] ?? env['NODE_ENV'],
    fetchImpl: options.fetchImpl,
  });
}

export {
  buildErrorEvent,
  FakeErrorTracker,
  type CapturedErrorEvent,
  type ErrorTracker,
  type ErrorTrackerContext,
} from '@gt-sales/observability';
