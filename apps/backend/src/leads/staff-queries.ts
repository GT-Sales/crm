import { sql, type SQL } from 'drizzle-orm';
import { contextWorkspaceId, type TenantTransaction } from '@gt-sales/db';
import {
  RELATED_LEADS_LIMIT,
  attributionSchema,
  filterableLeadProperties,
  leadActivitySchema,
  leadContactSchema,
  leadCountdownField,
  leadDocumentSchema,
  leadFieldCatalog,
  leadFormSchema,
  leadIdentitySchema,
  leadProperty,
  leadStageSchema,
  leadStatusSchema,
  leadTaskSchema,
  leadTypeEntry,
  leadTypeSchema,
  parseLeadSort,
  relatedLeadSchema,
  type LeadActivity,
  type LeadAssigneeFilter,
  type LeadBoardColumn,
  type LeadDetail,
  type LeadDocument,
  type LeadIdentity,
  type LeadListItem,
  type LeadPropertyFilter,
  type LeadPropertyValue,
  type LeadStatus,
  type LeadTask,
  type LeadTaskStatus,
  type LeadTypeCount,
  type LeadView,
  type RelatedLead,
  type TaskAssigneeFilter,
  type WorkspaceTask,
} from '@gt-sales/contracts';
import { z } from 'zod';

import { deriveSource } from './source.js';

/**
 * The staff side's lead reads, as plain SQL with explicit table aliases. The
 * query builder renders column references without their table in a one-table
 * select, and an unqualified `workspace_id` inside a correlated subquery
 * silently binds to the inner table instead of failing; spelling every alias
 * out removes that whole class of bug. Timestamps are formatted to ISO-8601 in
 * SQL because the driver hands raw-query timestamps back as Postgres text.
 */

/** A constant column expression formatted as `2026-10-26T21:15:42.123Z`; never user input. */
/** A timestamp column as the API's ISO form (`2026-10-27T12:00:00.000Z`), computed in SQL. */
export function iso(expression: string): SQL {
  return sql.raw(`to_char((${expression}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
}

export interface LeadRow {
  [key: string]: unknown;
  id: string;
  workspaceId: string;
  leadType: string;
  status: string;
  stage: string;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  countryCode: string | null;
  contactId: string | null;
  assignedActorId: string | null;
  externalRef: string | null;
  attribution: unknown;
  consentVersion: string | null;
  openTaskCount: number;
  nextTaskDueAt: string | null;
  isNew: boolean;
  countdownDate: unknown;
  formPayload?: unknown;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Each type's countdown date from its form (a SIM order's arrival), as one
 * CASE over the field definitions (`leadCountdownField`). The type names and
 * field keys are code constants, checked against their shapes because they
 * become SQL text.
 */
const COUNTDOWN_DATE = (() => {
  const branches = Object.keys(leadFieldCatalog).flatMap((leadType) => {
    const field = leadCountdownField(leadType);
    if (!field) return [];
    if (!/^[a-z0-9_]{1,64}$/.test(leadType) || !/^[a-z][A-Za-z0-9]{0,63}$/.test(field.key)) {
      throw new Error(`unsafe countdown field ${leadType}.${field.key}`);
    }
    return [`when '${leadType}' then l.payload -> 'payload' ->> '${field.key}'`];
  });
  return branches.length === 0 ? 'null::text' : `case l.lead_type ${branches.join(' ')} end`;
})();

/** The columns every list-shaped read returns, from a lead aliased `l` and its open-task summary `t`. */
const LEAD_COLUMNS = sql.raw(`
  l.id,
  l.workspace_id as "workspaceId",
  l.lead_type as "leadType",
  l.status,
  l.stage,
  l.full_name as "fullName",
  l.email,
  l.phone,
  l.country_code as "countryCode",
  l.contact_id as "contactId",
  l.assigned_actor_id as "assignedActorId",
  l.external_ref as "externalRef",
  l.attribution,
  l.consent_version as "consentVersion",
  coalesce(t.open_count, 0)::int as "openTaskCount",
  not exists (
    select 1 from app.lead_activities opened
    where opened.workspace_id = l.workspace_id
      and opened.lead_id = l.id
      and opened.kind = 'system'
      and opened.data ->> 'event' = 'opened'
  ) as "isNew",
  ${COUNTDOWN_DATE} as "countdownDate",
`);

const LEAD_TIMESTAMPS = sql.join(
  [
    sql`${iso('t.next_due')} as "nextTaskDueAt"`,
    sql`${iso('l.deleted_at')} as "deletedAt"`,
    sql`${iso('l.created_at')} as "createdAt"`,
    sql`${iso('l.updated_at')} as "updatedAt"`,
  ],
  sql`, `,
);

/** Open tasks per lead, joined laterally so only the rows actually returned pay for it. */
const OPEN_TASK_SUMMARY = sql.raw(`
  left join lateral (
    select count(*)::int as open_count, min(task.due_at) as next_due
    from app.lead_tasks task
    where task.workspace_id = l.workspace_id
      and task.lead_id = l.id
      and task.status = 'open'
  ) t on true
`);

function extractRequestedProperties(
  formPayload: unknown,
  columns: readonly string[],
): Record<string, LeadPropertyValue> {
  const properties: Record<string, LeadPropertyValue> = {};
  if (typeof formPayload !== 'object' || formPayload === null || Array.isArray(formPayload)) {
    return properties;
  }
  for (const key of columns) {
    const property = leadProperty(key);
    if (!property || property.sensitive) continue;
    const raw: unknown = Reflect.get(formPayload, key);
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      properties[key] = raw;
    }
  }
  return properties;
}

export function toLeadListItem(row: LeadRow, requestedColumns?: readonly string[]): LeadListItem {
  const attribution = attributionSchema.parse(row.attribution ?? {});
  const hasRequestedColumns = requestedColumns !== undefined && requestedColumns.length > 0;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    leadType: leadTypeSchema.parse(row.leadType),
    status: leadStatusSchema.parse(row.status),
    stage: leadStageSchema.parse(row.stage),
    contact: leadContactSchema.parse({
      fullName: row.fullName ?? undefined,
      email: row.email ?? undefined,
      phone: row.phone ?? undefined,
      countryCode: row.countryCode ?? undefined,
    }),
    contactId: row.contactId,
    assignedActorId: row.assignedActorId,
    externalRef: row.externalRef,
    source: deriveSource(attribution),
    attribution,
    consentVersion: row.consentVersion,
    openTaskCount: row.openTaskCount,
    nextTaskDueAt: row.nextTaskDueAt,
    isNew: row.isNew === true,
    // Whatever the form holds; only a real calendar day counts down.
    countdownDate: calendarDay(row.countdownDate),
    ...(hasRequestedColumns
      ? { properties: extractRequestedProperties(row.formPayload, requestedColumns) }
      : {}),
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const calendarDaySchema = z.iso.date();

function calendarDay(value: unknown): string | null {
  const parsed = calendarDaySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The first instant after the calendar day `day` (midnight UTC that ends
 * it): a task is due by `day` when its `due_at`, a calendar day stored at
 * noon UTC, falls before this. A validated literal, so a statement that
 * otherwise binds nothing stays at one round trip.
 */
function dueCutoff(day: string): SQL {
  if (!calendarDaySchema.safeParse(day).success) throw new Error('dueBy must be YYYY-MM-DD');
  return sql.raw(`(('${day}'::date + 1)::timestamp at time zone 'UTC')`);
}

/** `%term%` for ILIKE, with the term's own wildcards escaped. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

export interface LeadFilters {
  workspaceId: string;
  actorId: string;
  status?: LeadStatus;
  leadType?: string;
  stage?: string;
  assignee?: LeadAssigneeFilter;
  search?: string;
  view?: LeadView;
  /** Only leads with an open task due on or before this calendar day. */
  dueBy?: string;
  /** Validated property filters combined with AND. */
  where?: readonly LeadPropertyFilter[];
  /** Validated sort string (`<field>:<asc|desc>`). */
  sort?: string;
  /** Validated property column keys (at most 6). */
  columns?: readonly string[];
}

function propertyFilterCondition(filter: LeadPropertyFilter, leadType?: string): SQL {
  const property = filterableLeadProperties(leadType).find((entry) => entry.key === filter.key);
  if (!property) return sql`false`;

  const v = sql`(l.payload -> 'payload' ->> ${filter.key})`;
  const jsonVal = sql`(l.payload -> 'payload' -> ${filter.key})`;

  if (filter.op === 'empty') {
    return sql`coalesce(btrim(${v}), '') = ''`;
  }
  if (filter.op === 'notEmpty') {
    return sql`coalesce(btrim(${v}), '') <> ''`;
  }

  switch (property.kind) {
    case 'text':
    case 'longText': {
      if (typeof filter.value !== 'string') return sql`false`;
      if (filter.op === 'eq') {
        return sql`lower(btrim(${v})) = lower(btrim(${filter.value}))`;
      }
      if (filter.op === 'contains') {
        return sql`${v} ilike ${likePattern(filter.value)}`;
      }
      return sql`false`;
    }
    case 'choice': {
      if (filter.op === 'eq' && typeof filter.value === 'string') {
        return sql`${v} = ${filter.value}`;
      }
      if (filter.op === 'in' && Array.isArray(filter.value) && filter.value.length > 0) {
        return sql`${v} in (${sql.join(
          filter.value.map((item) => sql`${item}`),
          sql`, `,
        )})`;
      }
      return sql`false`;
    }
    case 'date': {
      if (typeof filter.value !== 'string') return sql`false`;
      if (filter.op === 'eq') {
        return sql`(${v} ~ '^\\d{4}-\\d{2}-\\d{2}$' and ${v} = ${filter.value})`;
      }
      if (filter.op === 'lte') {
        return sql`(${v} ~ '^\\d{4}-\\d{2}-\\d{2}$' and ${v} <= ${filter.value})`;
      }
      if (filter.op === 'gte') {
        return sql`(${v} ~ '^\\d{4}-\\d{2}-\\d{2}$' and ${v} >= ${filter.value})`;
      }
      return sql`false`;
    }
    case 'dateTime': {
      if (typeof filter.value !== 'string') return sql`false`;
      const guardedTs = sql`(case when ${v} ~ '^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])T([01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(\\.\\d+)?(Z|[+-]([01]\\d|2[0-3]):[0-5]\\d)$' then (${v})::timestamptz end)`;
      if (filter.op === 'lte') {
        return sql`${guardedTs} <= ${filter.value}::timestamptz`;
      }
      if (filter.op === 'gte') {
        return sql`${guardedTs} >= ${filter.value}::timestamptz`;
      }
      return sql`false`;
    }
    case 'count': {
      if (typeof filter.value !== 'number') return sql`false`;
      const guardedNum = sql`(case when jsonb_typeof(${jsonVal}) = 'number' then (${v})::numeric end)`;
      if (filter.op === 'eq') {
        return sql`${guardedNum} = ${filter.value}`;
      }
      if (filter.op === 'lte') {
        return sql`${guardedNum} <= ${filter.value}`;
      }
      if (filter.op === 'gte') {
        return sql`${guardedNum} >= ${filter.value}`;
      }
      return sql`false`;
    }
    case 'yesNo': {
      if (typeof filter.value !== 'boolean') return sql`false`;
      if (filter.op === 'eq') {
        return sql`${jsonVal} = to_jsonb(${filter.value}::boolean)`;
      }
      return sql`false`;
    }
  }
}

/** The WHERE conditions for lead `l`. Restricted leads are never listed, whatever the view. */
function leadConditions(filters: LeadFilters): SQL {
  const conditions: SQL[] = [
    sql`l.workspace_id = ${filters.workspaceId}`,
    sql`l.customer_data_restricted_at is null`,
    filters.view === 'trash' ? sql`l.deleted_at is not null` : sql`l.deleted_at is null`,
  ];
  if (filters.status) conditions.push(sql`l.status = ${filters.status}`);
  if (filters.leadType) conditions.push(sql`l.lead_type = ${filters.leadType}`);
  if (filters.stage) conditions.push(sql`l.stage = ${filters.stage}`);
  if (filters.assignee === 'me') conditions.push(sql`l.assigned_actor_id = ${filters.actorId}`);
  else if (filters.assignee === 'none') conditions.push(sql`l.assigned_actor_id is null`);
  else if (filters.assignee) conditions.push(sql`l.assigned_actor_id = ${filters.assignee}`);
  if (filters.dueBy) {
    conditions.push(sql`exists (
      select 1 from app.lead_tasks due
      where due.workspace_id = l.workspace_id
        and due.lead_id = l.id
        and due.status = 'open'
        and due.due_at < ${dueCutoff(filters.dueBy)}
    )`);
  }
  if (filters.search) {
    const pattern = likePattern(filters.search);
    const matches: SQL[] = [
      sql`l.full_name ilike ${pattern}`,
      sql`l.email ilike ${pattern}`,
      sql`l.phone ilike ${pattern}`,
      sql`l.external_ref ilike ${pattern}`,
    ];
    // A phone typed as digits finds `+1 (604) 555-0100`; short digit runs
    // would match nearly every number, so only four or more count.
    const digits = filters.search.replace(/\D/g, '');
    if (digits.length >= 4) {
      matches.push(
        sql`regexp_replace(coalesce(l.phone, ''), '[^0-9]', '', 'g') like ${`%${digits}%`}`,
      );
    }
    conditions.push(sql`(${sql.join(matches, sql` or `)})`);
  }
  if (filters.where && filters.where.length > 0) {
    for (const filter of filters.where) {
      conditions.push(propertyFilterCondition(filter, filters.leadType));
    }
  }
  return sql.join(conditions, sql` and `);
}

export interface LeadPage {
  leads: LeadListItem[];
  total: number;
}

/** A lead's soonest open task, for ordering the follow-ups due before the page is cut. */
const NEXT_DUE = sql.raw(`(
  select min(task.due_at) from app.lead_tasks task
  where task.workspace_id = l.workspace_id and task.lead_id = l.id and task.status = 'open'
)`);

function sortOrderOf(filters: LeadFilters): { pageOrder: SQL; rowOrder: SQL } {
  if (filters.sort) {
    const parsed = parseLeadSort(filters.sort);
    if (parsed) {
      const dir =
        parsed.direction === 'asc' ? sql.raw('asc nulls last') : sql.raw('desc nulls last');
      let expr: SQL;
      if (parsed.field === 'createdAt') {
        expr = sql`l.created_at`;
      } else if (parsed.field === 'updatedAt') {
        expr = sql`l.updated_at`;
      } else if (parsed.field === 'fullName') {
        expr = sql`nullif(btrim(l.full_name), '')`;
      } else if (parsed.field === 'externalRef') {
        expr = sql`nullif(btrim(l.external_ref), '')`;
      } else if (parsed.propertyKey !== undefined) {
        const key = parsed.propertyKey;
        const property = filterableLeadProperties(filters.leadType).find(
          (entry) => entry.key === key,
        );
        const v = sql`(l.payload -> 'payload' ->> ${key})`;
        const jsonVal = sql`(l.payload -> 'payload' -> ${key})`;
        if (property?.kind === 'count') {
          expr = sql`(case when jsonb_typeof(${jsonVal}) = 'number' then (${v})::numeric end)`;
        } else if (property?.kind === 'yesNo') {
          expr = sql`(case when jsonb_typeof(${jsonVal}) = 'boolean' then (${v})::boolean end)`;
        } else if (property?.kind === 'date') {
          expr = sql`(case when ${v} ~ '^\\d{4}-\\d{2}-\\d{2}$' then ${v} end)`;
        } else {
          expr = sql`nullif(btrim(${v}), '')`;
        }
      } else {
        expr = sql`l.updated_at`;
      }
      const order = sql`${expr} ${dir}, l.id`;
      return { pageOrder: order, rowOrder: order };
    }
  }

  const trash = filters.view === 'trash';
  const pageOrder = trash
    ? sql.raw('l.deleted_at desc, l.id')
    : filters.dueBy
      ? sql`${NEXT_DUE} asc, l.id`
      : sql.raw('l.updated_at desc, l.id');
  const rowOrder = trash
    ? sql.raw('l.deleted_at desc, l.id')
    : filters.dueBy
      ? sql.raw('t.next_due asc, l.id')
      : sql.raw('l.updated_at desc, l.id');
  return { pageOrder, rowOrder };
}

/**
 * One page of leads, newest activity first (the trash: most recently deleted
 * first; follow-ups due: the most overdue first; or an explicit `sort`). The
 * page's total rides on each row as a window count taken before the limit; the
 * task summary is joined after it, so only the page pays.
 */
export async function selectLeadPage(
  tx: TenantTransaction,
  filters: LeadFilters,
  page: number,
  pageSize: number,
): Promise<LeadPage> {
  const offset = (page - 1) * pageSize;
  const { pageOrder, rowOrder } = sortOrderOf(filters);
  const requestedColumns = (filters.columns ?? []).filter((key) => {
    const property = leadProperty(key);
    return property !== undefined && !property.sensitive;
  });
  const formPayloadColumn =
    requestedColumns.length > 0 ? sql`, l.payload -> 'payload' as "formPayload"` : sql``;

  const rows = await tx.execute<LeadRow & { total: number }>(sql`
    with page as (
      select l.*, count(*) over ()::int as total
      from app.leads l
      where ${leadConditions(filters)}
      order by ${pageOrder}
      limit ${pageSize} offset ${offset}
    )
    select ${LEAD_COLUMNS} ${LEAD_TIMESTAMPS}, l.total${formPayloadColumn}
    from page l
    ${OPEN_TASK_SUMMARY}
    order by ${rowOrder}
  `);

  // An empty page past the end still needs the real total, which no row
  // carried; the first page being empty means zero.
  let total = rows[0]?.total ?? 0;
  if (rows.length === 0 && offset > 0) {
    const [count] = await tx.execute<{ [key: string]: unknown; total: number }>(sql`
      select count(*)::int as total from app.leads l where ${leadConditions(filters)}
    `);
    total = count?.total ?? 0;
  }
  return {
    leads: rows.map((row) => toLeadListItem(row, requestedColumns)),
    total,
  };
}

/**
 * The board for one type: a column per catalogue stage in order, then any
 * stored stage the catalogue does not list, each with its full count and its
 * newest `perStage` leads.
 */
export async function selectLeadBoard(
  tx: TenantTransaction,
  filters: LeadFilters & { leadType: string },
  perStage: number,
): Promise<LeadBoardColumn[]> {
  const rows = await tx.execute<LeadRow & { stageTotal: number }>(sql`
    with ranked as (
      select
        l.*,
        row_number() over (partition by l.stage order by l.updated_at desc, l.id) as stage_rank,
        count(*) over (partition by l.stage)::int as stage_total
      from app.leads l
      where ${leadConditions({ ...filters, view: 'active' })}
    )
    select ${LEAD_COLUMNS} ${LEAD_TIMESTAMPS}, l.stage_total as "stageTotal"
    from ranked l
    ${OPEN_TASK_SUMMARY}
    where l.stage_rank <= ${perStage}
    order by l.stage, l.stage_rank
  `);

  const columns = new Map<string, LeadBoardColumn>();
  for (const stageEntry of leadTypeEntry(filters.leadType)?.stages ?? []) {
    columns.set(stageEntry.key, { stage: stageEntry.key, total: 0, leads: [] });
  }
  for (const row of rows) {
    const column = columns.get(row.stage) ?? { stage: row.stage, total: 0, leads: [] };
    column.total = row.stageTotal;
    column.leads.push(toLeadListItem(row));
    columns.set(row.stage, column);
  }
  return [...columns.values()];
}

/**
 * Active leads per type (only types that have one), how many nobody has
 * opened, with `dueBy` how many have a follow-up due, and the size of the
 * trash, for the transaction's own site: the site comes from the tenant
 * context and the day travels as a validated literal, so the statement binds
 * nothing and costs one round trip, not two.
 */
export async function selectLeadSummary(
  tx: TenantTransaction,
  dueBy?: string,
): Promise<{ types: LeadTypeCount[]; trash: number }> {
  const followUpsDue = dueBy
    ? sql`count(*) filter (
        where l.deleted_at is null
          and exists (
            select 1 from app.lead_tasks due
            where due.workspace_id = l.workspace_id
              and due.lead_id = l.id
              and due.status = 'open'
              and due.due_at < ${dueCutoff(dueBy)}
          )
      )::int`
    : sql.raw('null::int');
  const rows = await tx.execute<{
    [key: string]: unknown;
    leadType: string;
    active: number;
    unopened: number;
    followUpsDue: number | null;
    trashed: number;
  }>(sql`
    select
      l.lead_type as "leadType",
      count(*) filter (where l.deleted_at is null)::int as active,
      count(*) filter (
        where l.deleted_at is null
          and not exists (
            select 1 from app.lead_activities opened
            where opened.workspace_id = l.workspace_id
              and opened.lead_id = l.id
              and opened.kind = 'system'
              and opened.data ->> 'event' = 'opened'
          )
      )::int as unopened,
      ${followUpsDue} as "followUpsDue",
      count(*) filter (where l.deleted_at is not null)::int as trashed
    from app.leads l
    where l.workspace_id = ${contextWorkspaceId} and l.customer_data_restricted_at is null
    group by l.lead_type
    order by l.lead_type
  `);
  return {
    types: rows
      .filter((row) => row.active > 0)
      .map((row) => ({
        leadType: leadTypeSchema.parse(row.leadType),
        total: row.active,
        unopened: row.unopened,
        ...(row.followUpsDue === null ? {} : { followUpsDue: row.followUpsDue }),
      })),
    trash: rows.reduce((sum, row) => sum + row.trashed, 0),
  };
}

export interface LeadStats {
  total: number;
  stages: { stage: string; total: number }[];
  daily: { day: string; total: number }[];
  partners: { code: string; name: string | null; total: number }[];
}

const statsRowSchema = z.object({
  total: z.int().nonnegative(),
  stages: z.array(z.object({ stage: leadStageSchema, total: z.int().nonnegative() })),
  daily: z.array(z.object({ day: z.iso.date(), total: z.int().nonnegative() })),
  partners: z.array(
    z.object({
      code: z.string().min(1).max(64),
      name: z.string().min(1).max(200).nullable(),
      total: z.int().nonnegative(),
    }),
  ),
});

/**
 * The dashboard's counts for one type's active leads received in the window
 * (all time without one), in one statement: by stage, per UTC day and by
 * partner code (the ten largest), the last two without the type's lost
 * stages, as Get Canada Sim's dashboard leaves out cancellations. A partner
 * is named by the company on its partner application, when the site has one
 * under that code. Counts only, never a lead.
 */
export async function selectLeadStats(
  tx: TenantTransaction,
  input: { leadType: string; days?: number; lost: readonly string[] },
): Promise<LeadStats> {
  const since =
    input.days === undefined
      ? sql`true`
      : sql`l.created_at >= now() - make_interval(days => ${input.days})`;
  const lost =
    input.lost.length === 0
      ? sql`false`
      : sql`l.stage in (${sql.join(
          input.lost.map((stage) => sql`${stage}`),
          sql`, `,
        )})`;
  const [row] = await tx.execute<{
    [key: string]: unknown;
    total: number;
    stages: unknown[];
    daily: unknown[];
    partners: unknown[];
  }>(sql`
    with scoped as (
      select l.stage, l.created_at, l.attribution ->> 'partnerCode' as partner_code,
             (${lost}) as lost
      from app.leads l
      where l.workspace_id = ${contextWorkspaceId}
        and l.lead_type = ${input.leadType}
        and l.deleted_at is null
        and l.customer_data_restricted_at is null
        and ${since}
    )
    select
      (select count(*)::int from scoped) as total,
      (
        select coalesce(json_agg(json_build_object('stage', s.stage, 'total', s.total)
          order by s.stage), '[]'::json)
        from (select stage, count(*)::int as total from scoped group by stage) s
      ) as stages,
      (
        select coalesce(json_agg(json_build_object('day', d.day, 'total', d.total)
          order by d.day), '[]'::json)
        from (
          select to_char((c.created_at at time zone 'UTC')::date, 'YYYY-MM-DD') as day,
                 count(*)::int as total
          from scoped c
          where not c.lost
          group by 1
        ) d
      ) as daily,
      (
        select coalesce(json_agg(json_build_object('code', p.code, 'name', p.name, 'total', p.total)
          order by p.total desc, p.code), '[]'::json)
        from (
          select c.partner_code as code, count(*)::int as total,
            (
              select left(nullif(btrim(a.payload -> 'payload' ->> 'company'), ''), 200)
              from app.leads a
              where a.workspace_id = ${contextWorkspaceId}
                and a.lead_type = 'partner_application'
                and a.external_ref = c.partner_code
                and a.customer_data_restricted_at is null
              order by a.created_at desc
              limit 1
            ) as name
          from scoped c
          where not c.lost and nullif(btrim(c.partner_code), '') is not null
          group by c.partner_code
          order by total desc, c.partner_code
          limit 10
        ) p
      ) as partners
  `);
  return statsRowSchema.parse(row);
}

/** One lead with its form, for the lead page. Trashed leads are readable; restricted ones are not. */
export async function selectLeadDetail(
  tx: TenantTransaction,
  workspaceId: string,
  leadId: string,
): Promise<LeadDetail | undefined> {
  const [row] = await tx.execute<LeadRow & { payload: unknown }>(sql`
    select ${LEAD_COLUMNS} ${LEAD_TIMESTAMPS}, l.payload
    from app.leads l
    ${OPEN_TASK_SUMMARY}
    where l.workspace_id = ${workspaceId}
      and l.id = ${leadId}
      and l.customer_data_restricted_at is null
  `);
  if (!row) return undefined;
  const form = leadFormSchema.safeParse(row.payload);
  return { ...toLeadListItem(row), form: form.success ? form.data : null };
}

export interface ActivityRow {
  [key: string]: unknown;
  id: string;
  actorId: string;
  kind: string;
  body: string | null;
  data: unknown;
  createdAt: string;
}

/**
 * A stored timeline row as the contract's entry. `data` carries the kind's
 * fields (`from`/`to`, `fields`, `event`); a row that does not fit its kind
 * (written by a newer version, or a kind not yet shown) becomes a neutral
 * `system` entry rather than failing the whole lead page.
 */
export function toLeadActivity(row: ActivityRow): LeadActivity {
  const data =
    typeof row.data === 'object' && row.data !== null && !Array.isArray(row.data) ? row.data : {};
  const parsed = leadActivitySchema.safeParse({
    ...data,
    id: row.id,
    actorId: row.actorId,
    kind: row.kind,
    body: row.body ?? undefined,
    createdAt: row.createdAt,
  });
  if (parsed.success) return parsed.data;
  return {
    id: row.id,
    actorId: row.actorId,
    createdAt: row.createdAt,
    kind: 'system',
    event: 'unknown',
  };
}

interface TaskRow {
  [key: string]: unknown;
  id: string;
  leadId: string;
  title: string;
  dueAt: string | null;
  assignedActorId: string | null;
  status: string;
  completedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const TASK_COLUMNS = sql.join(
  [
    sql.raw(
      'k.id, k.lead_id as "leadId", k.title, k.assigned_actor_id as "assignedActorId", k.status, k.created_by as "createdBy"',
    ),
    sql`${iso('k.due_at')} as "dueAt"`,
    sql`${iso('k.completed_at')} as "completedAt"`,
    sql`${iso('k.created_at')} as "createdAt"`,
    sql`${iso('k.updated_at')} as "updatedAt"`,
  ],
  sql`, `,
);

export function toLeadTask(row: TaskRow): LeadTask {
  return leadTaskSchema.parse({
    id: row.id,
    leadId: row.leadId,
    title: row.title,
    dueAt: row.dueAt,
    assignedActorId: row.assignedActorId,
    status: row.status,
    completedAt: row.completedAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export interface LeadWithWork {
  lead: LeadDetail;
  activities: LeadActivity[];
  tasks: LeadTask[];
  related: RelatedLead[];
  identities: LeadIdentity[];
  documents: LeadDocument[];
}

/**
 * The lead page in one statement: the lead with its form, its timeline (newest
 * first, capped so one very long history cannot stall the page), its tasks
 * (open first, soonest due, undated last; then closed ones, most recently
 * changed first), the same person's other requests on this site (newest
 * first, trashed ones included and marked), the identities given for a
 * credit check (newest first, a SIN masked to its last three digits) and its
 * current documents (one per type, oldest first), the last five as JSON
 * arrays.
 * Each statement is a round trip to the remote pooler, so the page's reads
 * travel as one.
 */
export async function selectLeadWithWork(
  tx: TenantTransaction,
  workspaceId: string,
  leadId: string,
): Promise<LeadWithWork | undefined> {
  const [row] = await tx.execute<
    LeadRow & {
      payload: unknown;
      activities: ActivityRow[];
      tasks: TaskRow[];
      related: unknown[];
      identities: unknown[];
      documents: unknown[];
    }
  >(sql`
    select
      ${LEAD_COLUMNS} ${LEAD_TIMESTAMPS},
      l.payload,
      (
        select coalesce(json_agg(json_build_object(
          'id', a.id,
          'actorId', a.actor_id,
          'kind', a.kind,
          'body', a.body,
          'data', a.data,
          'createdAt', ${iso('a.created_at')}
        ) order by a.created_at desc, a.id desc), '[]'::json)
        from (
          select entry.*
          from app.lead_activities entry
          where entry.workspace_id = l.workspace_id and entry.lead_id = l.id
          order by entry.created_at desc, entry.id desc
          limit 500
        ) a
      ) as activities,
      (
        select coalesce(json_agg(json_build_object(
          'id', k.id,
          'leadId', k.lead_id,
          'title', k.title,
          'assignedActorId', k.assigned_actor_id,
          'status', k.status,
          'createdBy', k.created_by,
          'dueAt', ${iso('k.due_at')},
          'completedAt', ${iso('k.completed_at')},
          'createdAt', ${iso('k.created_at')},
          'updatedAt', ${iso('k.updated_at')}
        ) order by
          (k.status = 'open') desc,
          case when k.status = 'open' then k.due_at end asc nulls last,
          k.updated_at desc,
          k.id
        ), '[]'::json)
        from app.lead_tasks k
        where k.workspace_id = l.workspace_id and k.lead_id = l.id
      ) as tasks,
      (
        select coalesce(json_agg(json_build_object(
          'id', o.id,
          'leadType', o.lead_type,
          'status', o.status,
          'stage', o.stage,
          'deletedAt', ${iso('o.deleted_at')},
          'createdAt', ${iso('o.created_at')},
          'updatedAt', ${iso('o.updated_at')}
        ) order by o.created_at desc, o.id desc), '[]'::json)
        from (
          select other.*
          from app.leads other
          where other.workspace_id = l.workspace_id
            and other.contact_id = l.contact_id
            and other.id <> l.id
            and other.customer_data_restricted_at is null
          order by other.created_at desc, other.id desc
          limit ${sql.raw(String(RELATED_LEADS_LIMIT))}
        ) o
      ) as related,
      (
        select coalesce(json_agg(json_build_object(
          'id', i.id,
          'idType', i.id_type,
          'sinMasked', case when i.sin_last3 is null then null else '*** *** ' || i.sin_last3 end,
          'dateOfBirth', to_char(i.date_of_birth, 'YYYY-MM-DD'),
          'fileId', i.file_id,
          'createdAt', ${iso('i.created_at')}
        ) order by i.created_at desc, i.id desc), '[]'::json)
        from app.lead_identities i
        where i.workspace_id = l.workspace_id and i.lead_id = l.id
      ) as identities,
      (
        -- A licence photo given for the credit check is the ID check's, not here.
        select coalesce(json_agg(json_build_object(
          'id', f.id,
          'documentType', f.document_type,
          'contentType', f.detected_mime,
          'sizeBytes', f.size_bytes,
          'revision', f.revision,
          'createdAt', ${iso('f.created_at')}
        ) order by f.created_at, f.id), '[]'::json)
        from app.files f
        where f.workspace_id = l.workspace_id
          and f.record_type = 'lead'
          and f.record_id = l.id
          and f.status = 'available'
          and f.superseded_by_file_id is null
          and not exists (
            select 1 from app.lead_identities i
            where i.workspace_id = f.workspace_id and i.file_id = f.id
          )
      ) as documents
    from app.leads l
    ${OPEN_TASK_SUMMARY}
    where l.workspace_id = ${workspaceId}
      and l.id = ${leadId}
      and l.customer_data_restricted_at is null
  `);
  if (!row) return undefined;
  const form = leadFormSchema.safeParse(row.payload);
  return {
    lead: { ...toLeadListItem(row), form: form.success ? form.data : null },
    activities: row.activities.map(toLeadActivity),
    tasks: row.tasks.map(toLeadTask),
    // A request this version cannot show (say, a newer lead type) is left
    // out rather than failing the page.
    related: row.related.flatMap((item) => {
      const parsed = relatedLeadSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }),
    // Masked as stored: the sealed SIN never leaves the database on this path.
    identities: row.identities.flatMap((item) => {
      const parsed = leadIdentitySchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }),
    documents: row.documents.flatMap((item) => {
      const parsed = leadDocumentSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }),
  };
}

export async function selectTask(
  tx: TenantTransaction,
  workspaceId: string,
  taskId: string,
): Promise<LeadTask | undefined> {
  const [row] = await tx.execute<TaskRow>(sql`
    select ${TASK_COLUMNS}
    from app.lead_tasks k
    where k.workspace_id = ${workspaceId} and k.id = ${taskId}
  `);
  return row ? toLeadTask(row) : undefined;
}

export interface TaskFilters {
  workspaceId: string;
  actorId: string;
  assignee: TaskAssigneeFilter;
  status: LeadTaskStatus;
  /** Only tasks due on or before this calendar day (an undated task never is). */
  dueBy?: string;
}

/** Tasks on the workspace's active leads, soonest due first (undated last), with each lead's summary. */
export async function selectWorkspaceTasks(
  tx: TenantTransaction,
  filters: TaskFilters,
  page: number,
  pageSize: number,
): Promise<{ tasks: WorkspaceTask[]; total: number }> {
  const assignee =
    filters.assignee === 'all'
      ? sql`true`
      : filters.assignee === 'me'
        ? sql`k.assigned_actor_id = ${filters.actorId}`
        : filters.assignee === 'none'
          ? sql`k.assigned_actor_id is null`
          : sql`k.assigned_actor_id = ${filters.assignee}`;
  const due = filters.dueBy ? sql`k.due_at < ${dueCutoff(filters.dueBy)}` : sql`true`;
  const rows = await tx.execute<
    TaskRow & {
      total: number;
      leadType: string;
      stage: string;
      fullName: string | null;
      email: string | null;
      phone: string | null;
      countryCode: string | null;
      externalRef: string | null;
    }
  >(sql`
    select
      ${TASK_COLUMNS},
      count(*) over ()::int as total,
      l.lead_type as "leadType",
      l.stage,
      l.full_name as "fullName",
      l.email,
      l.phone,
      l.country_code as "countryCode",
      l.external_ref as "externalRef"
    from app.lead_tasks k
    inner join app.leads l on l.workspace_id = k.workspace_id and l.id = k.lead_id
    where k.workspace_id = ${filters.workspaceId}
      and k.status = ${filters.status}
      and ${assignee}
      and ${due}
      and l.deleted_at is null
      and l.customer_data_restricted_at is null
    order by k.due_at asc nulls last, k.created_at asc, k.id
    limit ${pageSize} offset ${(page - 1) * pageSize}
  `);
  return {
    tasks: rows.map((row) => ({
      ...toLeadTask(row),
      lead: {
        id: row.leadId,
        leadType: leadTypeSchema.parse(row.leadType),
        stage: leadStageSchema.parse(row.stage),
        contact: leadContactSchema.parse({
          fullName: row.fullName ?? undefined,
          email: row.email ?? undefined,
          phone: row.phone ?? undefined,
          countryCode: row.countryCode ?? undefined,
        }),
        externalRef: row.externalRef,
      },
    })),
    total: rows[0]?.total ?? 0,
  };
}
