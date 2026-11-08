import { sql, type SQL } from 'drizzle-orm';
import {
  ANALYTICS_LOST_STAGES,
  ANALYTICS_TOP_LIMIT,
  ANALYTICS_WON_STAGES,
  analyticsExcludedFromNew,
  analyticsRangeDays,
  leadStageSchema,
  leadTypeCatalog,
  leadTypeSchema,
  type AnalyticsCompare,
  type AnalyticsGroup,
  type AnalyticsResponse,
  type LeadAssigneeFilter,
} from '@gt-sales/contracts';
import { contextWorkspaceId, withTenantTx, type DatabaseClient } from '@gt-sales/db';
import { z } from 'zod';

import { QUEUE_ROWS } from '../documents/review-queue.js';
import type { Scope } from '../tenant-scope.js';

/**
 * The analytics dashboard's numbers: one read-only tenant transaction, one
 * aggregate statement over the site's leads (not archived, not restricted),
 * the filters applied once in `filtered`, then each figure counted over the
 * current range and the comparison range. UTC calendar days, as the older
 * stats. Every value is bound; the JSON keys and stage lists are constants.
 *
 * How a lead's plan is found (`resolved`): the frozen plan's `planId`, else
 * the order's `planId`, else the form's `planId` matched against a plan of the
 * same site and type whose `custom_website_slug` value equals it (CanadaWide
 * leads and Get Canada Sim's imported orders). None of those: no plan matched.
 *
 * Its commission: the frozen plan's `commission` when the copy has one (so a
 * historical order keeps the commission in force when it was taken), else the
 * plan's current one; fixed × quantity, or rate × price × quantity rounded
 * half up (`commissionMinorOf` in contracts). The price is the frozen one,
 * else the plan's.
 *
 * The won date is the lead's first `status_change` into a won stage of its
 * type, else its creation (an imported lead has no such entry).
 */

export type AnalyticsFigures = Omit<AnalyticsResponse, 'requestId'>;

export interface AnalyticsInput extends Scope {
  from: string;
  to: string;
  compare: AnalyticsCompare;
  group: AnalyticsGroup;
  leadType?: string;
  source?: string;
  partner?: string;
  assignee?: LeadAssigneeFilter;
  paymentStatus?: string;
  planId?: string;
  delivery?: string;
  /** The caller's UTC today, for follow-ups due and overdue; defaults to now. */
  today?: string;
  queryTimeoutMs?: number;
}

export interface AnalyticsStore {
  analytics(input: AnalyticsInput): Promise<AnalyticsFigures>;
}

type AnalyticsDatabase = Pick<DatabaseClient, 'withTenantTx'>;

const DAY_MS = 86_400_000;

/** The start of a UTC calendar day (plus `days`), whatever the session's time zone. */
function utc(day: string, days = 0): SQL {
  return sql`((${day}::date + ${days}::int)::timestamp at time zone 'UTC')`;
}

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function addYears(day: string, years: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date.toISOString().slice(0, 10);
}

/** The comparison range: the same length just before, or the same days a year earlier. */
export function comparisonRange(
  from: string,
  to: string,
  compare: AnalyticsCompare,
): { from: string; to: string } | null {
  if (compare === 'none') return null;
  if (compare === 'last_year') return { from: addYears(from, -1), to: addYears(to, -1) };
  const days = analyticsRangeDays(from, to);
  return { from: addDays(from, -days), to: addDays(from, -1) };
}

/** `(type, stage) in (…)` over a per-type stage list, or false when it names none. */
function stagePairs(table: Record<string, readonly string[]>, type: SQL, stage: SQL): SQL {
  const pairs = Object.entries(table).flatMap(([leadType, stages]) =>
    stages.map((key) => sql`(${leadType}, ${key})`),
  );
  return pairs.length === 0
    ? sql`false`
    : sql`(${type}, ${stage}) in (${sql.join(pairs, sql`, `)})`;
}

const EXCLUDED_FROM_NEW: Record<string, readonly string[]> = Object.fromEntries(
  Object.keys(leadTypeCatalog).map((leadType) => [leadType, analyticsExcludedFromNew(leadType)]),
);

const count = z.coerce.number().int().nonnegative();
const money = z.coerce.number().int();
const keyed = z.array(z.object({ key: z.string(), total: count }));

const rowSchema = z.object({
  new_current: count,
  new_previous: count,
  won_current: count,
  won_previous: count,
  paid_current: count,
  paid_previous: count,
  earned_current: money,
  earned_previous: money,
  expected: money,
  won_without_commission: count,
  any_plan_commission: z.boolean(),
  follow_ups_due: count,
  follow_ups_overdue: count,
  documents_to_review: count,
  trend: z.array(z.object({ bucket: z.string(), current: count, previous: count })),
  commission_trend: z.array(z.object({ bucket: z.string(), earned: money })),
  stages: z.array(z.object({ leadType: leadTypeSchema, stage: leadStageSchema, total: count })),
  sources: keyed,
  partners: z.array(z.object({ code: z.string(), name: z.string().nullable(), total: count })),
  plans: z.array(
    z.object({ planId: z.string().nullable(), name: z.string().nullable(), total: count }),
  ),
  delivery: keyed,
  lead_types: z.array(z.object({ leadType: leadTypeSchema, total: count })),
  payment: keyed,
  commission_status: keyed,
  team: z.array(
    z.object({ actorId: z.string().nullable(), assigned: count, won: count, overdue: count }),
  ),
});

export class DatabaseAnalyticsStore implements AnalyticsStore {
  constructor(private readonly database: AnalyticsDatabase = { withTenantTx }) {}

  analytics(input: AnalyticsInput): Promise<AnalyticsFigures> {
    const comparison = comparisonRange(input.from, input.to, input.compare);
    const today = input.today ?? new Date().toISOString().slice(0, 10);
    // An empty range when there is no comparison, so its sums are zero.
    const compFrom = comparison?.from ?? input.from;
    const compToExclusive = comparison ? addDays(comparison.to, 1) : input.from;
    const toExclusive = addDays(input.to, 1);
    const shift =
      input.compare === 'last_year' ? '1 year' : `${analyticsRangeDays(input.from, input.to)} days`;
    const unit = input.group;

    const won = stagePairs(ANALYTICS_WON_STAGES, sql`l.lead_type`, sql`l.stage`);
    const wonEntry = stagePairs(ANALYTICS_WON_STAGES, sql`l.lead_type`, sql`a.data ->> 'to'`);
    const lost = stagePairs(ANALYTICS_LOST_STAGES, sql`l.lead_type`, sql`l.stage`);
    const excluded = stagePairs(EXCLUDED_FROM_NEW, sql`l.lead_type`, sql`l.stage`);

    const filters: SQL[] = [];
    if (input.leadType !== undefined) filters.push(sql`b.lead_type = ${input.leadType}`);
    if (input.source !== undefined) filters.push(sql`b.utm_source = ${input.source}`);
    if (input.partner !== undefined) filters.push(sql`b.partner_code = ${input.partner}`);
    if (input.assignee === 'none') filters.push(sql`b.assigned_actor_id is null`);
    else if (input.assignee === 'me') filters.push(sql`b.assigned_actor_id = ${input.actorId}`);
    else if (input.assignee !== undefined)
      filters.push(sql`b.assigned_actor_id = ${input.assignee}`);
    if (input.paymentStatus !== undefined)
      filters.push(sql`b.payment_status = ${input.paymentStatus}`);
    if (input.planId !== undefined) filters.push(sql`b.plan_id = ${input.planId}`);
    if (input.delivery !== undefined) filters.push(sql`b.delivery = ${input.delivery}`);
    const where = filters.length === 0 ? sql`true` : sql.join(filters, sql` and `);
    const planType =
      input.leadType === undefined ? sql`true` : sql`p.lead_type = ${input.leadType}`;

    const statement = sql`
      with base as (
        select
          l.id, l.lead_type, l.stage, l.created_at, l.assigned_actor_id,
          nullif(btrim(l.attribution ->> 'utmSource'), '') as utm_source,
          nullif(btrim(l.attribution ->> 'partnerCode'), '') as partner_code,
          l.payload -> 'payload' ->> 'delivery' as delivery,
          (${won}) as won,
          (${lost}) as lost,
          (${excluded}) as excluded,
          case when ${won} then coalesce((
            select min(a.created_at) from app.lead_activities a
            where a.workspace_id = l.workspace_id and a.lead_id = l.id
              and a.kind = 'status_change' and ${wonEntry}
          ), l.created_at) end as won_at,
          case when l.lead_type = 'sim_order'
            then coalesce(l.order_details ->> 'paymentStatus', 'not_needed')
            else lower(nullif(btrim(l.custom_values ->> 'custom_payment_status'), ''))
          end as payment_status,
          case when l.lead_type = 'sim_order'
            then coalesce(l.order_details ->> 'carrierCommission', 'not_yet')
            else lower(nullif(btrim(l.custom_values ->> 'custom_commission'), ''))
          end as commission_status,
          l.lead_type in ('sim_order', 'internet', 'mobility') as is_order,
          case when jsonb_typeof(l.order_details -> 'plan') = 'object'
            then l.order_details -> 'plan' end as snapshot,
          case when jsonb_typeof(l.order_details -> 'quantity') = 'number'
            then (l.order_details ->> 'quantity')::int else 1 end as quantity,
          coalesce(
            nullif(l.order_details -> 'plan' ->> 'planId', ''),
            nullif(l.order_details ->> 'planId', ''),
            (
              select s.id::text from app.plans s
              where s.workspace_id = l.workspace_id and s.lead_type = l.lead_type
                and s.custom_values ->> 'custom_website_slug' = l.payload -> 'payload' ->> 'planId'
              order by s.active desc, s.position, s.id
              limit 1
            )
          ) as plan_ref
        from app.leads l
        where l.workspace_id = ${contextWorkspaceId}
          and l.deleted_at is null
          and l.customer_data_restricted_at is null
      ),
      priced as (
        select b.*,
          p.id::text as plan_id,
          coalesce(b.snapshot ->> 'name', p.name) as plan_name,
          coalesce((b.snapshot ->> 'priceMinor')::bigint, p.price_minor) as price_minor,
          case when b.snapshot ? 'commission' then b.snapshot -> 'commission' ->> 'type'
            else p.commission_type end as c_type,
          case when b.snapshot ? 'commission' then (b.snapshot -> 'commission' ->> 'rateBps')::int
            else p.commission_rate_bps end as c_bps,
          case when b.snapshot ? 'commission' then (b.snapshot -> 'commission' ->> 'amountMinor')::bigint
            else p.commission_minor end as c_fixed
        from base b
        left join app.plans p on p.workspace_id = ${contextWorkspaceId} and p.id::text = b.plan_ref
      ),
      filtered as (
        select b.*,
          case b.c_type
            when 'fixed' then b.c_fixed * b.quantity
            when 'percent' then round(b.price_minor::numeric * b.c_bps * b.quantity / 10000)::bigint
          end as commission_minor,
          b.created_at >= ${utc(input.from)} and b.created_at < ${utc(toExclusive)} as in_current,
          b.created_at >= ${utc(compFrom)} and b.created_at < ${utc(compToExclusive)} as in_previous,
          b.won_at >= ${utc(input.from)} and b.won_at < ${utc(toExclusive)} as won_current,
          b.won_at >= ${utc(compFrom)} and b.won_at < ${utc(compToExclusive)} as won_previous
        from priced b
        where ${where}
      ),
      buckets as (
        select g::date as bucket
        from generate_series(
          date_trunc(${unit}, ${input.from}::timestamp),
          ${input.to}::timestamp,
          ('1 ' || ${unit})::interval
        ) g
      ),
      open_tasks as (
        select t.assigned_actor_id, t.due_at
        from app.lead_tasks t
        join filtered f on f.id = t.lead_id
        where t.workspace_id = ${contextWorkspaceId} and t.status = 'open' and t.due_at is not null
      )
      select
        (select count(*) from filtered where in_current and not excluded) as new_current,
        (select count(*) from filtered where in_previous and not excluded) as new_previous,
        (select count(*) from filtered where won_current) as won_current,
        (select count(*) from filtered where won_previous) as won_previous,
        (select count(*) from filtered where in_current and payment_status = 'paid') as paid_current,
        (select count(*) from filtered where in_previous and payment_status = 'paid') as paid_previous,
        (select coalesce(sum(commission_minor), 0) from filtered where won_current) as earned_current,
        (select coalesce(sum(commission_minor), 0) from filtered where won_previous) as earned_previous,
        (
          select coalesce(sum(commission_minor), 0) from filtered
          where in_current and not won and not lost
        ) as expected,
        (
          select count(*) from filtered where won_current and commission_minor is null
        ) as won_without_commission,
        exists (
          select 1 from app.plans p
          where p.workspace_id = ${contextWorkspaceId} and p.commission_type <> 'none' and ${planType}
        ) as any_plan_commission,
        (select count(*) from open_tasks where due_at < ${utc(today, 1)}) as follow_ups_due,
        (select count(*) from open_tasks where due_at < ${utc(today)}) as follow_ups_overdue,
        (select count(*) from (${QUEUE_ROWS}) q where q.decision is null) as documents_to_review,
        (
          select coalesce(json_agg(json_build_object(
            'bucket', to_char(k.bucket, 'YYYY-MM-DD'),
            'current', (
              select count(*) from filtered f
              where f.in_current and not f.excluded
                and date_trunc(${unit}, f.created_at at time zone 'UTC')::date = k.bucket
            ),
            'previous', (
              select count(*) from filtered f
              where f.in_previous and not f.excluded
                and date_trunc(${unit}, (f.created_at at time zone 'UTC') + ${shift}::interval)::date
                  = k.bucket
            )
          ) order by k.bucket), '[]'::json)
          from buckets k
        ) as trend,
        (
          select coalesce(json_agg(json_build_object(
            'bucket', to_char(k.bucket, 'YYYY-MM-DD'),
            'earned', (
              select coalesce(sum(f.commission_minor), 0) from filtered f
              where f.won_current
                and date_trunc(${unit}, f.won_at at time zone 'UTC')::date = k.bucket
            )
          ) order by k.bucket), '[]'::json)
          from buckets k
        ) as commission_trend,
        (
          select coalesce(json_agg(json_build_object(
            'leadType', s.lead_type, 'stage', s.stage, 'total', s.total
          ) order by s.lead_type, s.stage), '[]'::json)
          from (
            select lead_type, stage, count(*) as total from filtered
            where in_current group by lead_type, stage
          ) s
        ) as stages,
        (
          select coalesce(json_agg(json_build_object('key', s.key, 'total', s.total)
            order by s.total desc, s.key), '[]'::json)
          from (
            select coalesce(left(utm_source, 200), '(none)') as key, count(*) as total
            from filtered where in_current and not excluded
            group by 1 order by 2 desc, 1 limit ${ANALYTICS_TOP_LIMIT}
          ) s
        ) as sources,
        (
          select coalesce(json_agg(json_build_object('code', p.code, 'name', p.name, 'total', p.total)
            order by p.total desc, p.code), '[]'::json)
          from (
            select left(f.partner_code, 64) as code, count(*) as total,
              (
                select left(nullif(btrim(a.payload -> 'payload' ->> 'company'), ''), 200)
                from app.leads a
                where a.workspace_id = ${contextWorkspaceId}
                  and a.lead_type = 'partner_application'
                  and a.external_ref = f.partner_code
                  and a.customer_data_restricted_at is null
                order by a.created_at desc
                limit 1
              ) as name
            from filtered f
            where f.in_current and not f.excluded and f.partner_code is not null
            group by f.partner_code
            order by total desc, f.partner_code
            limit ${ANALYTICS_TOP_LIMIT}
          ) p
        ) as partners,
        (
          select coalesce(json_agg(json_build_object('planId', m.plan_id, 'name', m.name, 'total', m.total)
            order by m.total desc, m.name), '[]'::json)
          from (
            (
              select plan_id, left(min(plan_name), 200) as name, count(*) as total
              from filtered where in_current and not excluded and is_order and plan_id is not null
              group by plan_id order by 3 desc, 2 limit ${ANALYTICS_TOP_LIMIT}
            )
            union all
            (
              select null, null, count(*)
              from filtered where in_current and not excluded and is_order and plan_id is null
              having count(*) > 0
            )
          ) m
        ) as plans,
        (
          select coalesce(json_agg(json_build_object('key', d.key, 'total', d.total)
            order by d.total desc, d.key), '[]'::json)
          from (
            select case when delivery in ('esim', 'pickup') then delivery else 'unknown' end as key,
              count(*) as total
            from filtered where in_current and not excluded and lead_type = 'sim_order'
            group by 1
          ) d
        ) as delivery,
        (
          select coalesce(json_agg(json_build_object('leadType', t.lead_type, 'total', t.total)
            order by t.total desc, t.lead_type), '[]'::json)
          from (
            select lead_type, count(*) as total from filtered
            where in_current and not excluded group by lead_type
          ) t
        ) as lead_types,
        (
          select coalesce(json_agg(json_build_object('key', s.key, 'total', s.total)
            order by s.total desc, s.key), '[]'::json)
          from (
            select coalesce(left(payment_status, 200), '(not set)') as key, count(*) as total
            from filtered where in_current and is_order group by 1
          ) s
        ) as payment,
        (
          select coalesce(json_agg(json_build_object('key', s.key, 'total', s.total)
            order by s.total desc, s.key), '[]'::json)
          from (
            select coalesce(left(commission_status, 200), '(not set)') as key, count(*) as total
            from filtered where in_current and is_order group by 1
          ) s
        ) as commission_status,
        (
          select coalesce(json_agg(json_build_object(
            'actorId', m.actor_id, 'assigned', m.assigned, 'won', m.won, 'overdue', m.overdue
          ) order by m.assigned desc, m.actor_id nulls last), '[]'::json)
          from (
            select actor_id, sum(assigned)::int as assigned, sum(won)::int as won,
              sum(overdue)::int as overdue
            from (
              select assigned_actor_id as actor_id, 1 as assigned,
                case when won then 1 else 0 end as won, 0 as overdue
              from filtered where in_current
              union all
              select assigned_actor_id, 0, 0, 1 from open_tasks
              where due_at < ${utc(today)} and assigned_actor_id is not null
            ) u
            group by actor_id
          ) m
        ) as team
    `;

    return this.database.withTenantTx(input, async (tx) => {
      await tx.execute(sql`set transaction read only`);
      await tx.execute(
        sql`select set_config('statement_timeout', ${String(input.queryTimeoutMs ?? 10_000)}, true)`,
      );
      const [raw] = await tx.execute<{ [key: string]: unknown }>(statement);
      const row = rowSchema.parse(raw);
      const previous = <T>(value: T): T | null => (comparison ? value : null);
      return {
        range: { from: input.from, to: input.to, days: analyticsRangeDays(input.from, input.to) },
        comparison,
        group: input.group,
        leadType: leadTypeSchema.nullable().parse(input.leadType ?? null),
        kpis: {
          newLeads: { current: row.new_current, previous: previous(row.new_previous) },
          won: { current: row.won_current, previous: previous(row.won_previous) },
          paid: { current: row.paid_current, previous: previous(row.paid_previous) },
          followUps: { due: row.follow_ups_due, overdue: row.follow_ups_overdue },
          documentsToReview: row.documents_to_review,
        },
        trend: row.trend.map((entry) => ({
          bucket: entry.bucket,
          current: entry.current,
          previous: previous(entry.previous),
        })),
        stages: row.stages,
        sources: row.sources,
        partners: row.partners,
        mix: {
          plans: row.plans.map((entry) => ({
            planId: entry.planId,
            name: entry.planId === null ? 'No plan matched' : (entry.name ?? 'Unnamed plan'),
            total: entry.total,
          })),
          delivery: row.delivery,
          leadTypes: row.lead_types,
        },
        statuses: { payment: row.payment, commission: row.commission_status },
        team: row.team,
        commission: {
          earnedMinor: { current: row.earned_current, previous: previous(row.earned_previous) },
          expectedMinor: row.expected,
          wonWithoutCommission: row.won_without_commission,
          anyPlanHasCommission: row.any_plan_commission,
          wonDateBasis: 'status_change_else_created',
        },
        commissionTrend: row.commission_trend.map((entry) => ({
          bucket: entry.bucket,
          earnedMinor: entry.earned,
        })),
      };
    });
  }
}

/** The figures as a caller without `revenue.view` sees them: no money keys at all. */
export function withoutMoney(figures: AnalyticsFigures): AnalyticsFigures {
  const { commission: _commission, commissionTrend: _trend, ...rest } = figures;
  return rest;
}
