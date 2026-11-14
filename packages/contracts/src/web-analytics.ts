import { z } from 'zod';

import { requestIdSchema } from './common';

/**
 * Analytics → a site's website traffic, read from its Umami website: visitors,
 * page views, where they came from and what they looked at. Totals only; Umami
 * holds no customer details and none pass through here.
 */
export const webAnalyticsDaysSchema = z.union([z.literal(7), z.literal(30), z.literal(90)]);
export type WebAnalyticsDays = z.infer<typeof webAnalyticsDaysSchema>;

export const webAnalyticsQuerySchema = z
  .object({ days: z.coerce.number().pipe(webAnalyticsDaysSchema).optional() })
  .strict();
export type WebAnalyticsQuery = z.infer<typeof webAnalyticsQuerySchema>;

const count = z.int().nonnegative();

export const webAnalyticsTotalsSchema = z.object({
  pageviews: count,
  visitors: count,
  visits: count,
  /** Visits that saw one page and did nothing else. */
  bounces: count,
  /** Seconds spent across all visits. */
  totalSeconds: count,
});
export type WebAnalyticsTotals = z.infer<typeof webAnalyticsTotalsSchema>;

const rowSchema = z.object({ label: z.string().max(300), total: count });

export const webAnalyticsReportSchema = z.object({
  days: webAnalyticsDaysSchema,
  /** The period's first and last day, `YYYY-MM-DD`, in the site's reporting time zone. */
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  totals: webAnalyticsTotalsSchema,
  /** The same number of days just before `from`. */
  previous: webAnalyticsTotalsSchema,
  /** One entry per day of the period, oldest first. */
  daily: z
    .array(
      z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), pageviews: count, visitors: count }),
    )
    .max(120),
  pages: z.array(rowSchema).max(10),
  referrers: z.array(rowSchema).max(10),
  countries: z.array(rowSchema).max(10),
  devices: z.array(rowSchema).max(10),
  /** Visitors on the site in the last five minutes; null when Umami did not say. */
  activeNow: count.nullable(),
});
export type WebAnalyticsReport = z.infer<typeof webAnalyticsReportSchema>;

/**
 * `unavailable` says why there is nothing to show: the deployment has no
 * Umami connection (`not_configured`), this site has no Umami website
 * (`no_website`), or Umami did not answer (`unreachable`, try again).
 */
export const webAnalyticsResponseSchema = z.object({
  report: webAnalyticsReportSchema.nullable(),
  unavailable: z.enum(['not_configured', 'no_website', 'unreachable']).optional(),
  requestId: requestIdSchema,
});
export type WebAnalyticsResponse = z.infer<typeof webAnalyticsResponseSchema>;
