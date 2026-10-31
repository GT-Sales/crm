import { z } from 'zod';

import { requestIdSchema } from './common';
import { leadTypeSchema } from './leads';
import { LEAD_STATS_WINDOWS } from './workspace-leads';

/**
 * Reports → Sources: per source, one lead type's leads received, submitted and
 * made it over a dashboard window. Counts only, so every role may read them
 * (`workspace.read`). The counting rules live in the backend's report store.
 */

/** The stages a lead has made it at, one rule for every lead type (owner, 2026-10-31). */
export const SOURCE_REPORT_SUCCESS_STAGES = ['activated', 'installed', 'completed', 'won'] as const;
/** The most sources listed; the rest are summed into one Other row. */
export const SOURCE_REPORT_MAX_SOURCES = 50;
/** The most campaigns listed per source; the rest are summed into one Other row. */
export const SOURCE_REPORT_MAX_CAMPAIGNS = 20;
/** The `source` of the summed Other row, which no `deriveSource` label can be. */
export const SOURCE_REPORT_OTHER_SOURCE = 'other';

export const SOURCE_KINDS = ['partner', 'utm', 'referrer', 'direct', 'other'] as const;
export const sourceKindSchema = z.enum(SOURCE_KINDS);
export type SourceKind = z.infer<typeof sourceKindSchema>;

/** `GET /workspaces/:id/reports/sources`: one type; no window is all time. */
export const sourceReportQuerySchema = z
  .object({
    leadType: leadTypeSchema,
    days: z.coerce
      .number()
      .pipe(z.literal([...LEAD_STATS_WINDOWS]))
      .optional(),
  })
  .strict();
export type SourceReportQuery = z.infer<typeof sourceReportQuerySchema>;

const counts = {
  received: z.int().nonnegative(),
  submitted: z.int().nonnegative(),
  madeIt: z.int().nonnegative(),
};

/** A `utm` source split by campaign; `other` marks the summed row (whose `campaign` is null). */
export const sourceReportCampaignSchema = z
  .object({
    campaign: z.string().min(1).max(120).nullable(),
    other: z.boolean(),
    ...counts,
  })
  .strict();
export type SourceReportCampaign = z.infer<typeof sourceReportCampaignSchema>;

/** One source by its `deriveSource` label (customer-influenced text: render it as text). */
export const sourceReportRowSchema = z
  .object({
    source: z.string().min(1).max(300),
    kind: sourceKindSchema,
    ...counts,
    campaigns: z.array(sourceReportCampaignSchema).max(SOURCE_REPORT_MAX_CAMPAIGNS + 1),
  })
  .strict();
export type SourceReportRow = z.infer<typeof sourceReportRowSchema>;

export const sourceReportResponseSchema = z.object({
  leadType: leadTypeSchema,
  days: z.literal([...LEAD_STATS_WINDOWS]).nullable(),
  /** Over every counted lead, before the caps. */
  totals: z.object(counts).strict(),
  rows: z.array(sourceReportRowSchema).max(SOURCE_REPORT_MAX_SOURCES + 1),
  /** Counted leads whose attribution is not empty. */
  withSourceData: z.int().nonnegative(),
  requestId: requestIdSchema,
});
export type SourceReportResponse = z.infer<typeof sourceReportResponseSchema>;
