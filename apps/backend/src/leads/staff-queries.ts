import { sql, type SQL } from 'drizzle-orm';
import type { TenantTransaction } from '@gt-sales/db';
import {
  attributionSchema,
  leadActivitySchema,
  leadContactSchema,
  leadFormSchema,
  leadStageSchema,
  leadStatusSchema,
  leadTaskSchema,
  leadTypeEntry,
  leadTypeSchema,
  type LeadActivity,
  type LeadAssigneeFilter,
  type LeadBoardColumn,
  type LeadDetail,
  type LeadListItem,
  type LeadStatus,
  type LeadTask,
  type LeadTaskStatus,
  type LeadTypeCount,
  type LeadView,
  type WorkspaceTask,
} from '@gt-sales/contracts';

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
function iso(expression: string): SQL {
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
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

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

export function toLeadListItem(row: LeadRow): LeadListItem {
  const attribution = attributionSchema.parse(row.attribution ?? {});
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
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
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
  return sql.join(conditions, sql` and `);
}

export interface LeadPage {
  leads: LeadListItem[];
  total: number;
}

/**
 * One page of leads, newest activity first (the trash: most recently deleted
 * first). The page's total rides on each row as a window count taken before
 * the limit; the task summary is joined after it, so only the page pays.
 */
export async function selectLeadPage(
  tx: TenantTransaction,
  filters: LeadFilters,
  page: number,
  pageSize: number,
): Promise<LeadPage> {
  const offset = (page - 1) * pageSize;
  const order =
    filters.view === 'trash'
      ? sql.raw('l.deleted_at desc, l.id')
      : sql.raw('l.updated_at desc, l.id');
  const rows = await tx.execute<LeadRow & { total: number }>(sql`
    with page as (
      select l.*, count(*) over ()::int as total
      from app.leads l
      where ${leadConditions(filters)}
      order by ${order}
      limit ${pageSize} offset ${offset}
    )
    select ${LEAD_COLUMNS} ${LEAD_TIMESTAMPS}, l.total
    from page l
    ${OPEN_TASK_SUMMARY}
    order by ${order}
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
  return { leads: rows.map(toLeadListItem), total };
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

/** Active leads per type (only types that have one) and the size of the trash. */
export async function selectLeadSummary(
  tx: TenantTransaction,
  workspaceId: string,
): Promise<{ types: LeadTypeCount[]; trash: number }> {
  const rows = await tx.execute<{
    [key: string]: unknown;
    leadType: string;
    active: number;
    trashed: number;
  }>(sql`
    select
      l.lead_type as "leadType",
      count(*) filter (where l.deleted_at is null)::int as active,
      count(*) filter (where l.deleted_at is not null)::int as trashed
    from app.leads l
    where l.workspace_id = ${workspaceId} and l.customer_data_restricted_at is null
    group by l.lead_type
    order by l.lead_type
  `);
  return {
    types: rows
      .filter((row) => row.active > 0)
      .map((row) => ({ leadType: leadTypeSchema.parse(row.leadType), total: row.active })),
    trash: rows.reduce((sum, row) => sum + row.trashed, 0),
  };
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

interface ActivityRow {
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

const ACTIVITY_COLUMNS = sql.join(
  [
    sql.raw('a.id, a.actor_id as "actorId", a.kind, a.body, a.data'),
    sql`${iso('a.created_at')} as "createdAt"`,
  ],
  sql`, `,
);

/** The lead's timeline, newest first; capped so one very long history cannot stall the page. */
export async function selectLeadActivities(
  tx: TenantTransaction,
  workspaceId: string,
  leadId: string,
  limit = 500,
): Promise<LeadActivity[]> {
  const rows = await tx.execute<ActivityRow>(sql`
    select ${ACTIVITY_COLUMNS}
    from app.lead_activities a
    where a.workspace_id = ${workspaceId} and a.lead_id = ${leadId}
    order by a.created_at desc, a.id desc
    limit ${limit}
  `);
  return rows.map(toLeadActivity);
}

export async function selectActivitiesById(
  tx: TenantTransaction,
  workspaceId: string,
  ids: readonly string[],
): Promise<LeadActivity[]> {
  if (ids.length === 0) return [];
  const rows = await tx.execute<ActivityRow>(sql`
    select ${ACTIVITY_COLUMNS}
    from app.lead_activities a
    where a.workspace_id = ${workspaceId}
      and a.id in (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})
    order by a.created_at desc, a.id desc
  `);
  return rows.map(toLeadActivity);
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

/** Open tasks first, soonest due (undated last); then closed ones, most recently changed first. */
export async function selectLeadTasks(
  tx: TenantTransaction,
  workspaceId: string,
  leadId: string,
): Promise<LeadTask[]> {
  const rows = await tx.execute<TaskRow>(sql`
    select ${TASK_COLUMNS}
    from app.lead_tasks k
    where k.workspace_id = ${workspaceId} and k.lead_id = ${leadId}
    order by
      (k.status = 'open') desc,
      case when k.status = 'open' then k.due_at end asc nulls last,
      k.updated_at desc,
      k.id
  `);
  return rows.map(toLeadTask);
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
  assignee: LeadAssigneeFilter;
  status: LeadTaskStatus;
}

/** Tasks on the workspace's active leads, soonest due first (undated last), with each lead's summary. */
export async function selectWorkspaceTasks(
  tx: TenantTransaction,
  filters: TaskFilters,
  page: number,
  pageSize: number,
): Promise<{ tasks: WorkspaceTask[]; total: number }> {
  const assignee =
    filters.assignee === 'me'
      ? sql`k.assigned_actor_id = ${filters.actorId}`
      : filters.assignee === 'none'
        ? sql`k.assigned_actor_id is null`
        : sql`k.assigned_actor_id = ${filters.assignee}`;
  const rows = await tx.execute<
    TaskRow & {
      total: number;
      leadType: string;
      stage: string;
      fullName: string | null;
      email: string | null;
      phone: string | null;
      countryCode: string | null;
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
      l.country_code as "countryCode"
    from app.lead_tasks k
    inner join app.leads l on l.workspace_id = k.workspace_id and l.id = k.lead_id
    where k.workspace_id = ${filters.workspaceId}
      and k.status = ${filters.status}
      and ${assignee}
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
      },
    })),
    total: rows[0]?.total ?? 0,
  };
}
