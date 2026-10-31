import { sql, type SQL } from 'drizzle-orm';
import {
  SOURCE_REPORT_MAX_CAMPAIGNS,
  SOURCE_REPORT_MAX_SOURCES,
  SOURCE_REPORT_OTHER_SOURCE,
  SOURCE_REPORT_SUCCESS_STAGES,
  type SourceKind,
  type SourceReportCampaign,
  type SourceReportResponse,
  type SourceReportRow,
} from '@gt-sales/contracts';
import { contextWorkspaceId, withTenantTx, type DatabaseClient } from '@gt-sales/db';
import { z } from 'zod';

import type { Scope } from '../tenant-scope.js';

/**
 * Reports → Sources. One lead type's leads per source label, counted in
 * Postgres inside the site's tenant transaction over exactly the leads
 * `GET /leads/stats` counts (the type, not archived, not restricted, the same
 * `created_at` window), so the report's totals match the dashboard's.
 *
 * - received: every counted lead; submitted: `status = 'submitted'`; made it:
 *   `stage` in `SOURCE_REPORT_SUCCESS_STAGES` (one rule for every type).
 * - The source label is `deriveSource`'s (`leads/source.ts`), computed in SQL
 *   by `sourceLabelSql`; a `utm` source is split by `utmCampaign`.
 * - Every value is bound; the JSON keys are fixed constants written into the
 *   statement, never input.
 * - `shapeSourceReport` ranks the groups and caps them at 50 sources and 20
 *   campaigns a source, summing the rest into Other rows; the totals are over
 *   every counted lead, before the caps.
 */

export type SourceReport = Pick<SourceReportResponse, 'totals' | 'rows' | 'withSourceData'>;

/** One `group by source, kind, campaign` row of the statement. */
export interface SourceGroupRow {
  source: string;
  kind: Exclude<SourceKind, 'other'>;
  campaign: string | null;
  received: number;
  submitted: number;
  madeIt: number;
}

export interface ReportStore {
  sourceReport(input: Scope & { leadType: string; days?: number }): Promise<SourceReport>;
}

type ReportDatabase = Pick<DatabaseClient, 'withTenantTx'>;

/** The `deriveSource` label of a jsonb attribution expression, in SQL. */
export function sourceLabelSql(attribution: SQL): SQL {
  return sql`(case
    when nullif(${attribution} ->> 'partnerCode', '') is not null then
      'partner:' || (${attribution} ->> 'partnerCode')
        || case when ${attribution} -> 'partnerCodeMatched' = 'true'::jsonb then '' else ' (unmatched)' end
    when nullif(${attribution} ->> 'utmSource', '') is not null then
      'utm:' || (${attribution} ->> 'utmSource')
        || coalesce('/' || nullif(${attribution} ->> 'utmMedium', ''), '')
    when nullif(${attribution} ->> 'referrerHost', '') is not null then
      'referrer:' || (${attribution} ->> 'referrerHost')
    else 'direct'
  end)`;
}

/** The kind of `sourceLabelSql`'s label, by the same precedence. */
export function sourceKindSql(attribution: SQL): SQL {
  return sql`(case
    when nullif(${attribution} ->> 'partnerCode', '') is not null then 'partner'
    when nullif(${attribution} ->> 'utmSource', '') is not null then 'utm'
    when nullif(${attribution} ->> 'referrerHost', '') is not null then 'referrer'
    else 'direct'
  end)`;
}

const count = z.int().nonnegative();
const reportRowSchema = z.object({
  groups: z.array(
    z.object({
      source: z.string().min(1),
      kind: z.enum(['partner', 'utm', 'referrer', 'direct']),
      campaign: z.string().min(1).nullable(),
      received: count,
      submitted: count,
      madeIt: count,
    }),
  ),
  withSourceData: count,
});

/** Code-point order (not UTF-16 code units), so a label's place never depends on surrogates. */
function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index]?.codePointAt(0) ?? 0) - (right[index]?.codePointAt(0) ?? 0);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

interface Counts {
  received: number;
  submitted: number;
  madeIt: number;
}

function sum(items: readonly Counts[]): Counts {
  return items.reduce<Counts>(
    (total, item) => ({
      received: total.received + item.received,
      submitted: total.submitted + item.submitted,
      madeIt: total.madeIt + item.madeIt,
    }),
    { received: 0, submitted: 0, madeIt: 0 },
  );
}

/** Most received first, then the campaign by code point, no campaign last among ties. */
function compareCampaigns(a: SourceReportCampaign, b: SourceReportCampaign): number {
  if (a.received !== b.received) return b.received - a.received;
  if (a.campaign === b.campaign) return 0;
  if (a.campaign === null) return 1;
  if (b.campaign === null) return -1;
  return compareCodePoints(a.campaign, b.campaign);
}

function capCampaigns(campaigns: SourceReportCampaign[]): SourceReportCampaign[] {
  const ranked = [...campaigns].sort(compareCampaigns);
  if (ranked.length <= SOURCE_REPORT_MAX_CAMPAIGNS) return ranked;
  const rest = ranked.slice(SOURCE_REPORT_MAX_CAMPAIGNS);
  return [
    ...ranked.slice(0, SOURCE_REPORT_MAX_CAMPAIGNS),
    { campaign: null, other: true, ...sum(rest) },
  ];
}

/** Ranks grouped rows into report rows and applies both caps; totals are not its job. */
export function shapeSourceReport(groups: readonly SourceGroupRow[]): SourceReportRow[] {
  const bySource = new Map<string, { kind: SourceGroupRow['kind']; groups: SourceGroupRow[] }>();
  for (const group of groups) {
    const entry = bySource.get(group.source);
    if (entry) entry.groups.push(group);
    else bySource.set(group.source, { kind: group.kind, groups: [group] });
  }
  const rows: SourceReportRow[] = [...bySource].map(([source, entry]) => ({
    source,
    kind: entry.kind,
    ...sum(entry.groups),
    campaigns:
      entry.kind === 'utm'
        ? capCampaigns(
            entry.groups.map((group) => ({
              campaign: group.campaign,
              other: false,
              received: group.received,
              submitted: group.submitted,
              madeIt: group.madeIt,
            })),
          )
        : [],
  }));
  rows.sort((a, b) =>
    a.received !== b.received ? b.received - a.received : compareCodePoints(a.source, b.source),
  );
  if (rows.length <= SOURCE_REPORT_MAX_SOURCES) return rows;
  return [
    ...rows.slice(0, SOURCE_REPORT_MAX_SOURCES),
    {
      source: SOURCE_REPORT_OTHER_SOURCE,
      kind: 'other',
      ...sum(rows.slice(SOURCE_REPORT_MAX_SOURCES)),
      campaigns: [],
    },
  ];
}

export class DatabaseReportStore implements ReportStore {
  constructor(private readonly database: ReportDatabase = { withTenantTx }) {}

  sourceReport(input: Scope & { leadType: string; days?: number }): Promise<SourceReport> {
    const since =
      input.days === undefined
        ? sql`true`
        : sql`l.created_at >= now() - make_interval(days => ${input.days})`;
    const madeIt = sql.join(
      SOURCE_REPORT_SUCCESS_STAGES.map((stage) => sql`${stage}`),
      sql`, `,
    );
    const attribution = sql`l.attribution`;
    const kind = sourceKindSql(attribution);
    return this.database.withTenantTx(
      { workspaceId: input.workspaceId, actorId: input.actorId },
      async (tx) => {
        // Grouped in the outer query over the CTE's columns: a bind parameter
        // repeated in `select` and `group by` renders as two placeholders,
        // which Postgres refuses as "must appear in the GROUP BY clause".
        const [row] = await tx.execute<{ [key: string]: unknown }>(sql`
          with scoped as (
            select
              ${sourceLabelSql(attribution)} as source,
              ${kind} as kind,
              case when ${kind} = 'utm' then nullif(l.attribution ->> 'utmCampaign', '') end
                as campaign,
              l.status = 'submitted' as submitted,
              l.stage in (${madeIt}) as made_it,
              l.attribution <> '{}'::jsonb as has_source
            from app.leads l
            where l.workspace_id = ${contextWorkspaceId}
              and l.lead_type = ${input.leadType}
              and l.deleted_at is null
              and l.customer_data_restricted_at is null
              and ${since}
          )
          select
            (
              select coalesce(json_agg(json_build_object(
                'source', g.source, 'kind', g.kind, 'campaign', g.campaign,
                'received', g.received, 'submitted', g.submitted, 'madeIt', g.made_it
              )), '[]'::json)
              from (
                select s.source, s.kind, s.campaign,
                       count(*)::int as received,
                       count(*) filter (where s.submitted)::int as submitted,
                       count(*) filter (where s.made_it)::int as made_it
                from scoped s
                group by s.source, s.kind, s.campaign
              ) g
            ) as groups,
            (select count(*) filter (where has_source)::int from scoped) as "withSourceData"
        `);
        const parsed = reportRowSchema.parse(row);
        return {
          totals: sum(parsed.groups),
          rows: shapeSourceReport(parsed.groups),
          withSourceData: parsed.withSourceData,
        };
      },
    );
  }
}
