import { describe, expect, it, vi } from 'vitest';

import { loadWebAnalyticsReader } from '../src/analytics/web-analytics.js';

const WORKSPACE = '10000000-0000-4000-8000-000000000101';
const WEBSITE = 'a4438042-ccae-4c29-9dc2-984456dc2384';
const KEY = 'umami_test-key-not-real';
const ENV = {
  UMAMI_API_URL: 'https://umami.example.test/',
  UMAMI_API_KEY: KEY,
  UMAMI_WORKSPACE_WEBSITES: JSON.stringify([{ workspaceId: WORKSPACE, websiteId: WEBSITE }]),
};
const NOW = new Date('2026-11-14T15:00:00.000Z');

function umami(overrides: Record<string, unknown> = {}) {
  const answers: Record<string, unknown> = {
    stats: {
      pageviews: '120',
      visitors: 40,
      visits: 55,
      bounces: 20,
      totaltime: 3300,
      comparison: { pageviews: 60, visitors: 30, visits: 33, bounces: 11, totaltime: 900 },
    },
    pageviews: {
      pageviews: [
        { x: '2026-11-13 00:00:00', y: 70 },
        { x: '2026-11-14 00:00:00', y: 50 },
      ],
      sessions: [{ x: '2026-11-14 00:00:00', y: 25 }],
    },
    path: [
      { x: '/', y: 80 },
      { x: '/plans', y: 40 },
    ],
    referrer: [
      { x: 'l.facebook.com', y: 30 },
      { x: null, y: 12 },
    ],
    country: [{ x: 'CA', y: 35 }],
    device: [{ x: 'mobile', y: 28 }],
    active: { visitors: 3 },
    ...overrides,
  };
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = new URL(String(input));
    const part = url.pathname.split('/').pop() ?? '';
    const name = part === 'metrics' ? (url.searchParams.get('type') ?? '') : part;
    const body = answers[name];
    if (body === undefined) return new Response('nope', { status: 500 });
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

describe('web analytics from Umami', () => {
  it('reads one site’s traffic with its key, for the asked period', async () => {
    const fetchMock = umami();
    const reader = loadWebAnalyticsReader(ENV, fetchMock);
    const outcome = await reader.read({ workspaceId: WORKSPACE, days: 7, now: NOW });
    if (outcome.status !== 'ok') throw new Error(`expected a report, got ${outcome.status}`);
    const { report } = outcome;

    expect(report.totals).toEqual({
      pageviews: 120,
      visitors: 40,
      visits: 55,
      bounces: 20,
      totalSeconds: 3300,
    });
    expect(report.previous.pageviews).toBe(60);
    // Seven days ending today, a day Umami left out being a zero.
    expect(report.daily).toHaveLength(7);
    expect(report.daily.at(-1)).toEqual({ day: '2026-11-14', pageviews: 50, visitors: 25 });
    expect(report.daily.at(-2)).toEqual({ day: '2026-11-13', pageviews: 70, visitors: 0 });
    expect(report.daily[0]).toEqual({ day: '2026-11-08', pageviews: 0, visitors: 0 });
    expect(report.pages[0]).toEqual({ label: '/', total: 80 });
    expect(report.referrers).toEqual([
      { label: 'l.facebook.com', total: 30 },
      { label: 'Direct or unknown', total: 12 },
    ]);
    expect(report.activeNow).toBe(3);

    // Every request names this site's website, the period, and carries the key.
    for (const [input, init] of fetchMock.mock.calls) {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://umami.example.test');
      expect(url.pathname).toContain(`/api/websites/${WEBSITE}/`);
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${KEY}`);
    }
    const stats = fetchMock.mock.calls.find(([input]) => String(input).includes('/stats?'));
    const range = new URL(String(stats?.[0])).searchParams;
    // Seven days as the chart counts them: from the start of 8 Nov in Toronto.
    expect(Number(range.get('endAt'))).toBe(NOW.getTime());
    expect(new Date(Number(range.get('startAt'))).toISOString()).toBe('2026-11-08T05:00:00.000Z');
  });

  it.each([
    // [label, now, first day, start of that day in Toronto as a UTC instant]
    ['fall-back day inside the week', '2026-11-03T17:00:00Z', '2026-10-28', '2026-10-28T04:00:00Z'],
    ['fall-back day is the last day', '2026-11-02T04:30:00Z', '2026-10-26', '2026-10-26T04:00:00Z'],
    [
      'fall-back day is the first day',
      '2026-11-07T05:30:00Z',
      '2026-11-01',
      '2026-11-01T04:00:00Z',
    ],
    [
      'fall-back day is the first day, midday',
      '2026-11-07T17:00:00Z',
      '2026-11-01',
      '2026-11-01T04:00:00Z',
    ],
    ['week after the fall-back day', '2026-11-08T17:00:00Z', '2026-11-02', '2026-11-02T05:00:00Z'],
    [
      'spring-forward day inside the week',
      '2026-03-10T16:00:00Z',
      '2026-03-04',
      '2026-03-04T05:00:00Z',
    ],
    [
      'spring-forward day is the first day',
      '2026-03-14T16:00:00Z',
      '2026-03-08',
      '2026-03-08T05:00:00Z',
    ],
    [
      'just after midnight following it',
      '2026-03-09T04:30:00Z',
      '2026-03-03',
      '2026-03-03T05:00:00Z',
    ],
  ])(
    'counts seven calendar days from Toronto midnight across a clock change (%s)',
    async (_label, now, firstDay, startsAt) => {
      const fetchMock = umami();
      const reader = loadWebAnalyticsReader(ENV, fetchMock);
      const outcome = await reader.read({ workspaceId: WORKSPACE, days: 7, now: new Date(now) });
      if (outcome.status !== 'ok') throw new Error(`expected a report, got ${outcome.status}`);
      const days = outcome.report.daily.map((entry) => entry.day);
      expect(days).toHaveLength(7);
      expect(days[0]).toBe(firstDay);
      expect(outcome.report.from).toBe(firstDay);
      // Consecutive calendar dates, none repeated or skipped.
      days.forEach((day, index) => {
        expect(day).toBe(
          new Date(Date.parse(`${firstDay}T00:00:00Z`) + index * 86_400_000)
            .toISOString()
            .slice(0, 10),
        );
      });
      // Every request starts exactly at Toronto midnight of the first day.
      for (const call of fetchMock.mock.calls) {
        const url = new URL(String(call[0]));
        if (url.pathname.endsWith('/active')) continue;
        expect(new Date(Number(url.searchParams.get('startAt'))).toISOString()).toBe(
          new Date(startsAt).toISOString(),
        );
      }
    },
  );

  it('reuses a report for a minute instead of asking Umami again', async () => {
    const fetchMock = umami();
    const reader = loadWebAnalyticsReader(ENV, fetchMock);
    await reader.read({ workspaceId: WORKSPACE, days: 30, now: NOW });
    const asked = fetchMock.mock.calls.length;
    await reader.read({ workspaceId: WORKSPACE, days: 30, now: new Date(NOW.getTime() + 30_000) });
    expect(fetchMock.mock.calls.length).toBe(asked);
    await reader.read({ workspaceId: WORKSPACE, days: 30, now: new Date(NOW.getTime() + 90_000) });
    expect(fetchMock.mock.calls.length).toBe(asked * 2);
  });

  it('still reports when only the live visitor count fails', async () => {
    const reader = loadWebAnalyticsReader(ENV, umami({ active: undefined }));
    const outcome = await reader.read({ workspaceId: WORKSPACE, days: 7, now: NOW });
    expect(outcome.status === 'ok' && outcome.report.activeNow).toBe(null);
  });

  it('says why there is nothing to show', async () => {
    const fetchMock = umami({ stats: undefined });
    expect(
      await loadWebAnalyticsReader(ENV, fetchMock).read({ workspaceId: WORKSPACE, days: 7 }),
    ).toEqual({ status: 'unreachable' });
    expect(
      await loadWebAnalyticsReader(ENV, umami()).read({
        workspaceId: '10000000-0000-4000-8000-000000000999',
        days: 7,
      }),
    ).toEqual({ status: 'no_website' });

    const silent = umami();
    for (const env of [
      {},
      { ...ENV, UMAMI_API_KEY: '' },
      { ...ENV, UMAMI_API_URL: 'http://umami.example.test' },
      { ...ENV, UMAMI_API_URL: 'not a url' },
    ]) {
      expect(
        await loadWebAnalyticsReader(env, silent).read({ workspaceId: WORKSPACE, days: 7 }),
      ).toEqual({ status: 'not_configured' });
    }
    expect(silent).not.toHaveBeenCalled();
  });
});
