import { describe, expect, it } from 'vitest';

import { LogAnalyticsSink, UmamiAnalyticsSink, type AnalyticsLogLine } from './analytics.js';
import type { AnalyticsEvent } from './messaging.js';

const EVENT: AnalyticsEvent = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  eventId: '22222222-2222-4222-8222-222222222222',
  name: 'lead_saved',
  subjectId: '33333333-3333-4333-8333-333333333333',
};

/** A typed `fetch` that records calls, without an assertion. */
function recordingFetch(response: Response) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return response;
  };
  return { fn, calls };
}

describe('UmamiAnalyticsSink', () => {
  it('posts a sanitized event to the workspace’s mapped website', async () => {
    const { fn, calls } = recordingFetch(new Response('{}', { status: 200 }));
    const sink = new UmamiAnalyticsSink({
      endpoint: 'https://umami.example.test/api/send',
      hostname: 'site-1.example.test',
      websiteIdForWorkspace: (workspaceId) =>
        workspaceId === EVENT.workspaceId ? 'site-1-website' : undefined,
      fetch: fn,
    });

    const result = await sink.capture(EVENT);

    expect(result).toEqual({ status: 'delivered', providerId: `umami:${EVENT.eventId}` });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://umami.example.test/api/send');
    const body: unknown = JSON.parse(String(calls[0]?.init?.body));
    expect(body).toEqual({
      type: 'event',
      payload: {
        website: 'site-1-website',
        url: '/',
        hostname: 'site-1.example.test',
        name: 'lead_saved',
        data: { subjectId: EVENT.subjectId },
      },
    });
    // The submitted payload carries no URL, contact data or free text.
    expect(JSON.stringify(body)).not.toMatch(/http|@|fullName|email|phone/i);
    // A browser-shaped agent, so Umami's bot filter does not discard the event.
    const agent = new Headers(calls[0]?.init?.headers).get('user-agent') ?? '';
    expect(agent).toMatch(/^Mozilla\/5\.0/);
    expect(agent).not.toMatch(/bot|crawler|spider|http/i);
  });

  it('fails closed (uncertain, no request) when the workspace is unmapped', async () => {
    const { fn, calls } = recordingFetch(new Response('{}', { status: 200 }));
    const sink = new UmamiAnalyticsSink({
      endpoint: 'https://umami.example.test/api/send',
      websiteIdForWorkspace: () => undefined,
      fetch: fn,
    });

    expect(await sink.capture(EVENT)).toEqual({
      status: 'uncertain',
      errorCode: 'analytics_site_unmapped',
    });
    expect(calls).toHaveLength(0);
  });

  it('surfaces a provider HTTP failure as uncertain rather than throwing', async () => {
    const { fn } = recordingFetch(new Response('nope', { status: 503 }));
    const sink = new UmamiAnalyticsSink({
      endpoint: 'https://umami.example.test/api/send',
      websiteIdForWorkspace: () => 'site-1-website',
      fetch: fn,
    });

    expect(await sink.capture(EVENT)).toEqual({
      status: 'uncertain',
      errorCode: 'umami_http_503',
    });
  });
});

describe('LogAnalyticsSink', () => {
  it('writes one sanitized structured line and reports delivery', async () => {
    const lines: AnalyticsLogLine[] = [];
    const sink = new LogAnalyticsSink((line) => lines.push(line));

    const result = await sink.capture(EVENT);

    expect(result).toEqual({ status: 'delivered', providerId: `log-analytics:${EVENT.eventId}` });
    expect(lines).toEqual([
      {
        event: 'analytics_event',
        workspaceId: EVENT.workspaceId,
        eventId: EVENT.eventId,
        name: 'lead_saved',
        subjectId: EVENT.subjectId,
      },
    ]);
  });
});
