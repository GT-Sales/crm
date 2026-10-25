import type { AnalyticsEvent, AnalyticsSink, ProviderDeliveryResult } from './messaging.js';

/**
 * Server-only analytics sinks (IMPLEMENTATION_PLAN §9 "Analytics"). These carry
 * no browser-safe code: only the backend's outbox runner imports them, and an
 * event never contains contact data, a raw URL or attribution — just a stable
 * logical id and an opaque lead/order identifier (invariant 12).
 */

/** One sanitized structured log line. No PII, URL or free text. */
export interface AnalyticsLogLine {
  readonly event: 'analytics_event';
  readonly workspaceId: string;
  readonly eventId: string;
  readonly name: string;
  readonly subjectId: string;
}

export type AnalyticsLogger = (line: AnalyticsLogLine) => void;

/**
 * A sink that only writes a sanitized structured log line. Used in tests and
 * non-production environments where Umami is deliberately not configured; it
 * never forwards anything to a third party.
 */
export class LogAnalyticsSink implements AnalyticsSink {
  constructor(private readonly log: AnalyticsLogger) {}

  async capture(event: AnalyticsEvent): Promise<ProviderDeliveryResult> {
    this.log({
      event: 'analytics_event',
      workspaceId: event.workspaceId,
      eventId: event.eventId,
      name: event.name,
      subjectId: event.subjectId,
    });
    return { status: 'delivered', providerId: `log-analytics:${event.eventId}` };
  }
}

export interface UmamiAnalyticsOptions {
  /**
   * Full URL of the Umami collect endpoint, e.g.
   * `https://cloud.umami.is/api/send`. Never derived from a caller-supplied
   * value.
   */
  readonly endpoint: string;
  /**
   * Maps a workspace to its Umami website id (one site per website, REQ 35).
   * An unmapped workspace fails closed rather than sending to the wrong site.
   */
  readonly websiteIdForWorkspace: (workspaceId: string) => string | undefined;
  /** Optional hostname recorded on the event; omitted entirely when unset. */
  readonly hostname?: string;
  /**
   * Sent as the User-Agent. Umami drops events whose agent looks like a bot
   * (Node's default `node`/`undici` does), so a browser-shaped value is used;
   * it must not contain "bot", "crawler", "spider" or a URL.
   */
  readonly userAgent?: string;
  /** Injectable fetch for tests; defaults to the global. */
  readonly fetch?: typeof fetch;
  /** Per-request timeout; defaults to 10s. */
  readonly timeoutMs?: number;
}

/**
 * Umami server-event sink. Umami has no server SDK, so events go to its collect
 * endpoint as a `type: "event"` payload with the mapped website id. The URL is
 * the constant sanitized path `/` (never the customer's URL), and the only data
 * field is the opaque internal subject id.
 */
const DEFAULT_UMAMI_USER_AGENT = 'Mozilla/5.0 (compatible; CanadianPlansServer/1.0)';

export class UmamiAnalyticsSink implements AnalyticsSink {
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: UmamiAnalyticsOptions) {
    this.doFetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async capture(event: AnalyticsEvent): Promise<ProviderDeliveryResult> {
    const website = this.options.websiteIdForWorkspace(event.workspaceId);
    if (!website) return { status: 'uncertain', errorCode: 'analytics_site_unmapped' };

    const payload = {
      type: 'event' as const,
      payload: {
        website,
        url: '/',
        ...(this.options.hostname ? { hostname: this.options.hostname } : {}),
        name: event.name,
        data: { subjectId: event.subjectId },
      },
    };

    const response = await this.doFetch(this.options.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': this.options.userAgent ?? DEFAULT_UMAMI_USER_AGENT,
      },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) return { status: 'uncertain', errorCode: `umami_http_${response.status}` };
    return { status: 'delivered', providerId: `umami:${event.eventId}` };
  }
}
