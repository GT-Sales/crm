import { sql, type SQL } from 'drizzle-orm';
import { contextWorkspaceId, type TenantTransaction } from '@gt-sales/db';
import {
  attributionSchema,
  isOrderLeadType,
  leadContactSchema,
  leadCountdownField,
  leadFieldCatalog,
  leadFormSchema,
  leadStageSchema,
  leadStatusSchema,
  leadTypeEntry,
  leadTypeSchema,
  type LeadBoardColumn,
  type LeadDetail,
  type LeadListItem,
  type LeadPropertyValue,
  type PropertyCatalog,
  type LeadTypeCount,
} from '@gt-sales/contracts';
import { z } from 'zod';
import { toLeadOrder } from './order.js';
import { deriveSource } from './source.js';
import {
  type LeadFilters,
  calendarDay,
  dueCutoff,
  leadConditions,
  sortOrderOf,
} from './lead-filters.js';

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
  customValues?: unknown;
  orderDetails?: unknown;
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
export const LEAD_COLUMNS = sql.raw(`
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

export const LEAD_TIMESTAMPS = sql.join(
  [
    sql`${iso('t.next_due')} as "nextTaskDueAt"`,
    sql`${iso('l.deleted_at')} as "deletedAt"`,
    sql`${iso('l.created_at')} as "createdAt"`,
    sql`${iso('l.updated_at')} as "updatedAt"`,
  ],
  sql`, `,
);

/** Active (open or in-progress) tasks per lead, joined laterally so only the rows actually returned pay for it. */
export const OPEN_TASK_SUMMARY = sql.raw(`
  left join lateral (
    select count(*)::int as open_count, min(task.due_at) as next_due
    from app.lead_tasks task
    where task.workspace_id = l.workspace_id
      and task.lead_id = l.id
      and task.status in ('open', 'in_progress')
  ) t on true
`);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The requested columns' values, each read from the storage its property
 * names (the form, the custom values, or the order details under the
 * property's `storageKey`, with the order's defaults filled in for an order
 * type); never a sensitive one.
 */
function extractRequestedProperties(
  row: Pick<LeadRow, 'leadType' | 'formPayload' | 'customValues' | 'orderDetails'>,
  columns: readonly string[],
  catalog: PropertyCatalog,
): Record<string, LeadPropertyValue> {
  const properties: Record<string, LeadPropertyValue> = {};
  let order: Record<string, unknown> | undefined;
  for (const key of columns) {
    const property = catalog.get(key);
    if (!property || property.sensitive) continue;
    let source: unknown;
    if (property.storage === 'order') {
      if (!isOrderLeadType(row.leadType)) continue;
      order ??= { ...toLeadOrder(row.orderDetails) };
      source = order;
    } else {
      source = property.storage === 'custom' ? row.customValues : row.formPayload;
    }
    const storedKey = property.storageKey ?? key;
    if (!isRecord(source) || !Object.hasOwn(source, storedKey)) continue;
    const raw = source[storedKey];
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      properties[key] = raw;
    }
  }
  return properties;
}

/**
 * A lead's stored custom values; anything but a plain value is left out.
 * With the site's catalogue, only its custom properties' values (a write that
 * loads no catalogue, such as an archive, returns every stored value: the
 * property store refuses to delete a property a lead still holds, so the two
 * agree).
 */
export function toCustomValues(
  stored: unknown,
  catalog: PropertyCatalog | undefined,
): Record<string, LeadPropertyValue> {
  const values: Record<string, LeadPropertyValue> = {};
  if (!isRecord(stored)) return values;
  for (const [key, value] of Object.entries(stored)) {
    if (catalog && catalog.get(key)?.storage !== 'custom') continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      values[key] = value;
    }
  }
  return values;
}

export function toLeadListItem(
  row: LeadRow,
  requested?: { columns: readonly string[]; catalog: PropertyCatalog },
): LeadListItem {
  const attribution = attributionSchema.parse(row.attribution ?? {});
  const hasRequestedColumns = requested !== undefined && requested.columns.length > 0;
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
      ? {
          properties: extractRequestedProperties(row, requested.columns, requested.catalog),
        }
      : {}),
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface LeadPage {
  leads: LeadListItem[];
  total: number;
}

/**
 * One page of leads, newest activity first (the archive: most recently archived
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
  const requestedProperties = (filters.columns ?? []).flatMap((key) => {
    const property = filters.catalog.get(key);
    return property !== undefined && !property.sensitive ? [property] : [];
  });
  const requestedColumns = requestedProperties.map((property) => property.key);
  const formPayloadColumn = requestedProperties.some((property) => property.storage === 'form')
    ? sql`, l.payload -> 'payload' as "formPayload"`
    : sql``;
  const customValuesColumn = requestedProperties.some((property) => property.storage === 'custom')
    ? sql`, l.custom_values as "customValues"`
    : sql``;
  const orderDetailsColumn = requestedProperties.some((property) => property.storage === 'order')
    ? sql`, l.order_details as "orderDetails"`
    : sql``;

  const rows = await tx.execute<LeadRow & { total: number }>(sql`
    with page as (
      select l.*, count(*) over ()::int as total
      from app.leads l
      where ${leadConditions(filters)}
      order by ${pageOrder}
      limit ${pageSize} offset ${offset}
    )
    select ${LEAD_COLUMNS} ${LEAD_TIMESTAMPS}, l.total${formPayloadColumn}${customValuesColumn}${orderDetailsColumn}
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
    leads: rows.map((row) =>
      toLeadListItem(row, { columns: requestedColumns, catalog: filters.catalog }),
    ),
    total,
  };
}

/** Which leads an export writes: the ticked ones, or the inbox's own filters. */
export type LeadExportSelection =
  | { kind: 'ids'; workspaceId: string; ids: readonly string[] }
  | { kind: 'filter'; filters: LeadFilters };

/** What each export row carries beyond the list's own columns; each is read only when asked for. */
export interface LeadExportParts {
  /** The form, the custom values and the order: only for callers who see contact details. */
  details: boolean;
  /** The timeline's dates and the note count: one aggregate per lead. */
  activity: boolean;
}

export interface LeadExportRow {
  lead: LeadListItem;
  /** `form.payload`, when `details` was asked for and the lead has one. */
  form: Record<string, unknown> | null;
  custom: Record<string, LeadPropertyValue>;
  /** An order type's order with the defaults filled in; null for any other type. */
  order: LeadDetail['order'] | null;
  stageChangedAt: string | null;
  lastActivityAt: string | null;
  noteCount: number;
}

/** The export's WHERE: the list's own conditions, or the ticked ids among the site's unrestricted leads. */
function exportConditions(selection: LeadExportSelection): SQL {
  if (selection.kind === 'filter') return leadConditions(selection.filters);
  return sql`l.workspace_id = ${selection.workspaceId}
    and l.customer_data_restricted_at is null
    and l.id in (${sql.join(
      selection.ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`;
}

/** How many leads the selection holds: the list's own total for the same filters. */
export async function countLeadsForExport(
  tx: TenantTransaction,
  selection: LeadExportSelection,
): Promise<number> {
  const [count] = await tx.execute<{ [key: string]: unknown; total: number }>(sql`
    select count(*)::int as total from app.leads l where ${exportConditions(selection)}
  `);
  return count?.total ?? 0;
}

/**
 * Every lead of the selection (all pages, at most `limit`), in the list's own
 * order for a filter and newest first for ticked ids. It reads through
 * `leadConditions` and `sortOrderOf`, the list's own, so an export of the
 * current filters is exactly what the inbox shows: restricted leads are never
 * in it, and the archive only when the filter asks for it.
 */
export async function selectLeadsForExport(
  tx: TenantTransaction,
  selection: LeadExportSelection,
  parts: LeadExportParts,
  limit: number,
): Promise<LeadExportRow[]> {
  const { pageOrder, rowOrder } =
    selection.kind === 'filter'
      ? sortOrderOf(selection.filters)
      : {
          pageOrder: sql.raw('l.created_at desc, l.id'),
          rowOrder: sql.raw('l.created_at desc, l.id'),
        };
  const details = parts.details
    ? sql`, l.payload -> 'payload' as "formPayload", l.custom_values as "customValues", l.order_details as "orderDetails"`
    : sql``;
  const activityColumns = parts.activity
    ? sql`, ${iso('act.stage_at')} as "stageChangedAt", ${iso('act.last_at')} as "lastActivityAt", coalesce(act.notes, 0)::int as "noteCount"`
    : sql``;
  const activityJoin = parts.activity
    ? sql.raw(`
      left join lateral (
        select
          max(entry.created_at) as last_at,
          max(entry.created_at) filter (where entry.kind = 'status_change') as stage_at,
          count(*) filter (where entry.kind = 'note')::int as notes
        from app.lead_activities entry
        where entry.workspace_id = l.workspace_id and entry.lead_id = l.id
      ) act on true`)
    : sql``;

  const rows = await tx.execute<
    LeadRow & {
      stageChangedAt?: string | null;
      lastActivityAt?: string | null;
      noteCount?: number;
    }
  >(sql`
    with picked as (
      select l.*
      from app.leads l
      where ${exportConditions(selection)}
      order by ${pageOrder}
      limit ${limit}
    )
    select ${LEAD_COLUMNS} ${LEAD_TIMESTAMPS}${details}${activityColumns}
    from picked l
    ${OPEN_TASK_SUMMARY}
    ${activityJoin}
    order by ${rowOrder}
  `);

  return rows.map((row) => ({
    lead: toLeadListItem(row),
    form: parts.details && isRecord(row.formPayload) ? row.formPayload : null,
    custom: parts.details ? toCustomValues(row.customValues, undefined) : {},
    order: parts.details ? (orderOf(row).order ?? null) : null,
    stageChangedAt: row.stageChangedAt ?? null,
    lastActivityAt: row.lastActivityAt ?? null,
    noteCount: row.noteCount ?? 0,
  }));
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
 * archive, for the transaction's own site: the site comes from the tenant
 * context and the day travels as a validated literal, so the statement binds
 * nothing and costs one round trip, not two. The opened leads are read once
 * as a set and joined: a `not exists` inside the aggregate's filter runs once
 * per lead, about a second for a site of 100,000 leads.
 */
export async function selectLeadSummary(
  tx: TenantTransaction,
  dueBy?: string,
): Promise<{ types: LeadTypeCount[]; archived: number }> {
  const followUpsDue = dueBy
    ? sql`count(*) filter (
        where l.deleted_at is null
          and exists (
            select 1 from app.lead_tasks due
            where due.workspace_id = l.workspace_id
              and due.lead_id = l.id
              and due.status in ('open', 'in_progress')
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
      count(*) filter (where l.deleted_at is null and opened.lead_id is null)::int as unopened,
      ${followUpsDue} as "followUpsDue",
      count(*) filter (where l.deleted_at is not null)::int as trashed
    from app.leads l
    left join (
      select distinct activity.lead_id
      from app.lead_activities activity
      where activity.workspace_id = ${contextWorkspaceId}
        and activity.kind = 'system'
        and activity.data ->> 'event' = 'opened'
    ) opened on opened.lead_id = l.id
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
    archived: rows.reduce((sum, row) => sum + row.trashed, 0),
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

/** The detail's order: an order type's order details with the defaults filled in; nothing for any other type. */
export function orderOf(
  row: Pick<LeadRow, 'leadType' | 'orderDetails'>,
): Pick<LeadDetail, 'order'> {
  return isOrderLeadType(row.leadType) ? { order: toLeadOrder(row.orderDetails) } : {};
}

/** One lead with its form, custom values and order, for the lead page. Archived leads are readable; restricted ones are not. */
export async function selectLeadDetail(
  tx: TenantTransaction,
  workspaceId: string,
  leadId: string,
  catalog?: PropertyCatalog,
): Promise<LeadDetail | undefined> {
  const [row] = await tx.execute<LeadRow & { payload: unknown; customValues: unknown }>(sql`
    select ${LEAD_COLUMNS} ${LEAD_TIMESTAMPS}, l.payload, l.custom_values as "customValues",
      l.order_details as "orderDetails"
    from app.leads l
    ${OPEN_TASK_SUMMARY}
    where l.workspace_id = ${workspaceId}
      and l.id = ${leadId}
      and l.customer_data_restricted_at is null
  `);
  if (!row) return undefined;
  const form = leadFormSchema.safeParse(row.payload);
  return {
    ...toLeadListItem(row),
    form: form.success ? form.data : null,
    customValues: toCustomValues(row.customValues, catalog),
    ...orderOf(row),
  };
}
