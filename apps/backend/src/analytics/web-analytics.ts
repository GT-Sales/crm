import {
  webAnalyticsReportSchema,
  type WebAnalyticsDays,
  type WebAnalyticsReport,
  type WebAnalyticsTotals,
} from '@gt-sales/contracts';
import { z } from 'zod';

/**
 * Analytics page: a site's website traffic, read from the deployment's Umami
 * over its HTTP API (Umami 3.x: `/api/websites/:id/stats`, `/pageviews`,
 * `/metrics`, `/active`, an API key as a bearer token). Read-only and totals
 * only: nothing about a customer or a lead goes to Umami or comes back.
 *
 * Configured by `UMAMI_API_URL` and `UMAMI_API_KEY`, with each site's Umami
 * website in `UMAMI_WORKSPACE_WEBSITES` (the same map the analytics sink uses).
 */
export type WebAnalyticsOutcome =
  | { status: 'ok'; report: WebAnalyticsReport }
  | { status: 'not_configured' | 'no_website' | 'unreachable' };

export interface WebAnalyticsReader {
  read(input: {
    workspaceId: string;
    days: WebAnalyticsDays;
    now?: Date;
  }): Promise<WebAnalyticsOutcome>;
}

const DAY_MS = 86_400_000;
const TIMEOUT_MS = 8_000;
/** A report is reused this long: the page's numbers move slowly and Umami is one small server. */
const CACHE_MS = 60_000;
/** Days are counted in the business's own time zone, as the dashboard's follow-ups are. */
const TIME_ZONE = 'America/Toronto';
const TOP = 8;

const number = z.coerce.number().int().nonnegative().catch(0);
const totalsSchema = z.object({
  pageviews: number,
  visitors: number,
  visits: number,
  bounces: number,
  totaltime: number,
});
const statsSchema = totalsSchema.extend({ comparison: totalsSchema.optional() });
const pointsSchema = z.array(z.object({ x: z.string(), y: number }));
const seriesSchema = z.object({ pageviews: pointsSchema, sessions: pointsSchema });
const metricsSchema = z.array(z.object({ x: z.string().nullable(), y: number }));
const activeSchema = z.object({ visitors: number });

const sitesSchema = z.array(z.object({ workspaceId: z.uuid(), websiteId: z.uuid() }));

function totals(value: z.infer<typeof totalsSchema> | undefined): WebAnalyticsTotals {
  return {
    pageviews: value?.pageviews ?? 0,
    visitors: value?.visitors ?? 0,
    visits: value?.visits ?? 0,
    bounces: value?.bounces ?? 0,
    totalSeconds: value?.totaltime ?? 0,
  };
}

/** `YYYY-MM-DD` of an instant in the reporting time zone. */
/** The start of the business's day that holds this instant. */
function startOfDay(instant: number): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value ?? 0);
  const start =
    instant -
    (part('hour') * 3600 + part('minute') * 60 + part('second')) * 1000 -
    (instant % 1000);
  // The night the clocks go forward has an hour less behind it.
  return dayOf(new Date(start)) === dayOf(new Date(instant)) ? start : start + 3_600_000;
}

function dayOf(instant: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

function rows(data: z.infer<typeof metricsSchema>, unnamed: string) {
  return data
    .filter((entry) => entry.y > 0)
    .slice(0, TOP)
    .map((entry) => ({ label: (entry.x?.trim() || unnamed).slice(0, 300), total: entry.y }));
}

/** The reader from the environment, or one that answers `not_configured`. */
export function loadWebAnalyticsReader(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): WebAnalyticsReader {
  const rawUrl = env['UMAMI_API_URL']?.trim().replace(/\/+$/, '');
  const apiKey = env['UMAMI_API_KEY']?.trim();
  let baseUrl: URL | undefined;
  try {
    baseUrl = rawUrl ? new URL(rawUrl) : undefined;
  } catch {
    baseUrl = undefined;
  }
  let sites: z.infer<typeof sitesSchema> = [];
  try {
    sites = sitesSchema.parse(JSON.parse(env['UMAMI_WORKSPACE_WEBSITES']?.trim() || '[]'));
  } catch {
    sites = [];
  }
  if (!baseUrl || baseUrl.protocol !== 'https:' || !apiKey) {
    return { read: async () => ({ status: 'not_configured' }) };
  }
  const origin = baseUrl.origin;
  const websites = new Map(sites.map((site) => [site.workspaceId, site.websiteId]));
  const cache = new Map<string, { at: number; report: WebAnalyticsReport }>();

  async function get<T>(
    websiteId: string,
    path: string,
    query: Record<string, string>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const url = new URL(`${origin}/api/websites/${websiteId}/${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`umami ${path} answered ${response.status}`);
    return schema.parse(await response.json());
  }

  return {
    async read({ workspaceId, days, now = new Date() }) {
      const websiteId = websites.get(workspaceId);
      if (!websiteId) return { status: 'no_website' };
      const key = `${workspaceId}:${days}`;
      const cached = cache.get(key);
      if (cached && now.getTime() - cached.at < CACHE_MS) {
        return { status: 'ok', report: cached.report };
      }

      const endAt = now.getTime();
      // From the start of the first day the chart shows, so the totals and
      // the days add up to the same period.
      const startAt = startOfDay(endAt - (days - 1) * DAY_MS);
      const range = { startAt: String(startAt), endAt: String(endAt) };
      const metric = (type: string) =>
        get(websiteId, 'metrics', { ...range, type, limit: String(TOP) }, metricsSchema);
      try {
        const [stats, series, pages, referrers, countries, devices, active] = await Promise.all([
          get(websiteId, 'stats', range, statsSchema),
          get(websiteId, 'pageviews', { ...range, unit: 'day', timezone: TIME_ZONE }, seriesSchema),
          metric('path'),
          metric('referrer'),
          metric('country'),
          metric('device'),
          // "Who is on the site now" is a nicety: the report stands without it.
          get(websiteId, 'active', {}, activeSchema).catch(() => undefined),
        ]);

        const visitorsByDay = new Map(
          series.sessions.map((point) => [point.x.slice(0, 10), point.y]),
        );
        const viewsByDay = new Map(
          series.pageviews.map((point) => [point.x.slice(0, 10), point.y]),
        );
        // Every day of the period, so a day with no visits is a zero and not a gap.
        const daily: WebAnalyticsReport['daily'] = [];
        for (let offset = days - 1; offset >= 0; offset -= 1) {
          const day = dayOf(new Date(endAt - offset * DAY_MS));
          if (daily.at(-1)?.day === day) continue;
          daily.push({
            day,
            pageviews: viewsByDay.get(day) ?? 0,
            visitors: visitorsByDay.get(day) ?? 0,
          });
        }

        const report = webAnalyticsReportSchema.parse({
          days,
          from: dayOf(new Date(startAt)),
          to: dayOf(now),
          totals: totals(stats),
          previous: totals(stats.comparison),
          daily,
          pages: rows(pages, '/'),
          referrers: rows(referrers, 'Direct or unknown'),
          countries: rows(countries, 'Unknown'),
          devices: rows(devices, 'Unknown'),
          activeNow: active?.visitors ?? null,
        });
        cache.set(key, { at: now.getTime(), report });
        return { status: 'ok', report };
      } catch {
        // Never the response body or the key: only that Umami could not be read.
        return { status: 'unreachable' };
      }
    },
  };
}
