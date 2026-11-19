import {
  contextWorkspaceId,
  withTenantTx,
  type DatabaseClient,
  type TenantTransaction,
} from '@gt-sales/db';
import {
  AI_ASSISTANT_LIMITS,
  type LeadPropertyFilter,
  type LeadStatus,
  type LeadTypeCount,
  type PropertyCatalog,
} from '@gt-sales/contracts';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import {
  selectLeadPage,
  selectLeadSummary,
  selectLeadWithWork,
  type LeadWithWork,
} from '../leads/staff-queries.js';
import { loadPropertyCatalog } from '../properties/catalog.js';
import type { Scope } from '../tenant-scope.js';
import {
  leadRowSchema,
  taskRowSchema,
  orderProjectionSchema,
  type OrderProjection,
  type LeadRow,
  type OverviewStageCount,
  type TaskRow,
} from './projections.js';
import type { ResolvedWindow, TaskDueWindow } from './windows.js';

/**
 * The assistant's read side.
 *
 * Every statement is narrow on purpose: it selects the handful of columns the
 * projections allow, scopes to the caller's site inside `withTenantTx` (so RLS
 * applies as `app_runtime`), excludes archived and customer-restricted leads
 * unless the question explicitly asks for the archive, and returns an exact
 * total alongside a bounded page — a total that is a real count, never a page
 * length. Nothing here writes, and no getter that would record "opened", seed
 * an automation or queue a job is called.
 */

export interface OverviewQuery {
  readonly leadType: string | null;
  readonly window: ResolvedWindow;
  readonly status?: 'submitted';
}

export interface OverviewTotals {
  readonly received: number;
  readonly submitted: number;
  readonly byStage: readonly OverviewStageCount[];
}

export interface FindLeadsQuery {
  readonly search?: string;
  readonly leadType?: string;
  readonly stage?: string;
  readonly assignee?: 'me' | 'none' | string;
  readonly archived?: boolean;
  /** `incomplete` drafts or `submitted` leads only. */
  readonly status?: LeadStatus;
  /** Only leads nobody has opened yet (the inbox's New badge). */
  readonly unopenedOnly?: boolean;
  /** Only leads with an open task due on or before this calendar day. */
  readonly dueBy?: string;
  /** Property filters, already checked against the site's catalogue by the caller. */
  readonly where?: readonly LeadPropertyFilter[];
  /** The catalogue `where` was checked against; read again when absent. */
  readonly catalog?: PropertyCatalog;
  readonly limit: number;
  readonly offset: number;
}

/** The inbox's counters: per type its active and unopened leads and follow-ups due, and the archive. */
export interface InboxCounts {
  readonly types: readonly LeadTypeCount[];
  readonly archived: number;
}

export interface LeadPage {
  readonly rows: readonly LeadRow[];
  readonly total: number;
}

export interface LeadSummaryQuery {
  readonly leadId: string;
  /** Read the five most recent notes in their own bounded query. */
  readonly includeNotes?: boolean;
  readonly includeArchived?: boolean;
  readonly includeFinancial?: boolean;
  /** A frozen plan's commission too (`revenue.view`). */
  readonly includeCommission?: boolean;
  /** The lead page's own read (`selectLeadWithWork`): timeline, documents, change request, values. */
  readonly includeRecord?: boolean;
}

/** The lead page as the staff route reads it, plus the site's names for its timeline. */
export interface LeadRecordRows {
  readonly work: LeadWithWork;
  readonly catalog: PropertyCatalog;
  /** Display names of the site's members by actor id, for the timeline's people. */
  readonly names: ReadonlyMap<string, string | null>;
  /**
   * Entries of an older kind the lead page's contract does not list (`call`,
   * `email`, `merge`): the page reads them as neutral system entries, so
   * their own kind is kept here, by entry id, to name them in words.
   */
  readonly legacyKinds: ReadonlyMap<string, string>;
}

export interface ActivityRow {
  readonly kind: string;
  readonly at: Date;
  readonly body: string | null;
}

export interface LeadSummaryRows {
  readonly lead: LeadRow;
  readonly order?: OrderProjection;
  readonly truncated?: boolean;
  readonly openTasks: readonly TaskRow[];
  readonly activity: readonly ActivityRow[];
  /** The most recent notes, only when the caller asked for the notes section. */
  readonly notes: readonly ActivityRow[];
  /** Only with `includeRecord`. */
  readonly record?: LeadRecordRows;
}

export interface OpenTasksQuery {
  readonly assignee: 'me' | 'all' | 'none' | string;
  readonly due: TaskDueWindow;
  /** `active` (open and in progress; the default) or one stage. */
  readonly status?: 'active' | 'open' | 'in_progress' | 'done' | 'cancelled';
  /** Only tasks whose title holds this text (case-insensitive; `%` and `_` taken literally). */
  readonly titleContains?: string;
  /** Only tasks completed at or after this instant (the start of a calendar day, UTC). */
  readonly completedSince?: Date;
  readonly limit: number;
  readonly offset: number;
}

export interface TaskPage {
  readonly rows: readonly TaskRow[];
  readonly total: number;
}

export interface AiReadService {
  isActiveMember(scope: Scope, actorId: string): Promise<boolean>;
  overview(scope: Scope, query: OverviewQuery): Promise<OverviewTotals>;
  findLeads(scope: Scope, query: FindLeadsQuery): Promise<LeadPage>;
  leadSummary(scope: Scope, query: LeadSummaryQuery): Promise<LeadSummaryRows | undefined>;
  openTasks(scope: Scope, query: OpenTasksQuery): Promise<TaskPage>;
  /** A validated hint for the lead the page has open; never trusted as a read. */
  leadHint(scope: Scope, leadId: string): Promise<LeadHint | undefined>;
  /** The site's lead property catalogue, to check property filters against. */
  siteCatalog?(scope: Scope): Promise<PropertyCatalog>;
  /** The inbox's counters, read by the staff summary's own query. */
  inboxCounts?(scope: Scope, dueBy: string): Promise<InboxCounts>;
  /**
   * A reference and name for each active, unrestricted lead of these ids, for
   * reads whose own rows name a lead by "name, else email" (the sent box, the
   * review queue): the model gets the lead's reference and name, never an
   * address. A lead not returned is not available.
   */
  leadLabels?(scope: Scope, leadIds: readonly string[]): Promise<Map<string, LeadHint>>;
  /**
   * B1: the real name and reference of each of these leads (at most 100), an
   * archived one included, for the mention check alone; never sent to the
   * model. A restricted or gone lead is not returned. A failure throws, and
   * the card or revision that needed it is refused.
   */
  mentionLabels?(
    scope: Scope,
    leadIds: readonly string[],
  ): Promise<Map<string, { name: string | null; reference: string | null }>>;
  /** Display names of the site's active members by actor id. */
  memberNames?(scope: Scope): Promise<Map<string, string | null>>;
}

export interface LeadHint {
  readonly leadId: string;
  readonly leadType: string;
  readonly stage: string;
  readonly reference: string | null;
  readonly name: string | null;
  /** When the lead was received: a card's label names it (B5). */
  readonly createdAt?: Date;
}

const leadHintRowSchema = z.object({
  id: z.uuid(),
  lead_type: z.string().min(1),
  stage: z.string().min(1),
  external_ref: z.string().nullable(),
  full_name: z.string().nullable(),
  created_at: z.coerce.date().optional(),
});

type ReadDatabase = Pick<DatabaseClient, 'withTenantTx'>;

const activityRowSchema = z.object({
  kind: z.string().min(1),
  at: z.coerce.date(),
  body: z.string().nullable(),
});

const overviewRowSchema = z.object({
  received: z.int().nonnegative(),
  submitted: z.int().nonnegative(),
  stages: z.array(z.object({ stage: z.string().min(1), count: z.int().nonnegative() })),
});

const SUMMARY_TASKS = 10;
const SUMMARY_ACTIVITY = 10;
const SUMMARY_NOTES = 5;

/** A `%term%` ILIKE pattern with the term's own wildcards escaped. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/** The `app.memberships` join that turns an assignee id into a display name. */
function assigneeJoin(): SQL {
  return sql`
    left join app.memberships m
      on m.workspace_id = l.workspace_id
     and m.user_id = l.assigned_actor_id
     and m.status = 'active'
  `;
}

const countRowSchema = z.object({ total: z.int().nonnegative() });

const legacyKindRowSchema = z.object({ id: z.uuid(), kind: z.string().min(1) });

/** The lead's timeline entries of a kind the contract does not list, by id (bounded as the page is). */
async function legacyActivityKinds(
  tx: TenantTransaction,
  leadId: string,
): Promise<Map<string, string>> {
  const rows = await tx.execute<{ [key: string]: unknown }>(sql`
    select a.id, a.kind
    from app.lead_activities a
    where a.workspace_id = ${contextWorkspaceId}
      and a.lead_id = ${leadId}
      and a.kind not in ('note', 'status_change', 'assignment', 'edit', 'document', 'system')
    order by a.created_at desc, a.id desc
    limit 500
  `);
  return new Map(
    rows.map((row) => {
      const parsed = legacyKindRowSchema.parse(row);
      return [parsed.id, parsed.kind];
    }),
  );
}

const memberNameRowSchema = z.object({ user_id: z.uuid(), display_name: z.string().nullable() });

/**
 * Display names of this site's active members, by actor id: the `ids` given,
 * or every member when `ids` is undefined (a lead's timeline names people who
 * may be anyone on the site). Bounded by the site's membership.
 */
async function memberNames(
  tx: TenantTransaction,
  ids?: readonly string[],
): Promise<Map<string, string | null>> {
  if (ids !== undefined && ids.length === 0) return new Map();
  const filter =
    ids === undefined
      ? sql`true`
      : sql`m.user_id in (${sql.join(
          [...new Set(ids)].map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`;
  const rows = await tx.execute<{ [key: string]: unknown }>(sql`
    select m.user_id, m.display_name
    from app.memberships m
    where m.workspace_id = ${contextWorkspaceId}
      and m.status = 'active'
      and ${filter}
    limit 500
  `);
  return new Map(
    rows.map((row) => {
      const parsed = memberNameRowSchema.parse(row);
      return [parsed.user_id, parsed.display_name];
    }),
  );
}

export class DatabaseAiReadService implements AiReadService {
  constructor(private readonly database: ReadDatabase = { withTenantTx }) {}

  /**
   * One bounded read in its own tenant transaction. The `statement_timeout` is
   * set inside the transaction, so a pathological query is cancelled by
   * Postgres itself instead of holding a pooled connection and the chat stream
   * open; the value is a code constant, never input.
   */
  private read<T>(scope: Scope, work: (tx: TenantTransaction) => Promise<T>): Promise<T> {
    return this.database.withTenantTx(scope, async (tx) => {
      await tx.execute(sql`set transaction read only`);
      await tx.execute(
        sql`select set_config('statement_timeout', ${String(AI_ASSISTANT_LIMITS.toolQueryTimeoutMs)}, true)`,
      );
      return work(tx);
    });
  }

  isActiveMember(scope: Scope, actorId: string): Promise<boolean> {
    return this.read(scope, async (tx) => {
      const rows = await tx.execute(
        sql`select id from app.memberships where workspace_id = ${contextWorkspaceId} and user_id = ${actorId} and status = 'active' and membership_type = 'staff' limit 1`,
      );
      return rows.length === 1;
    });
  }

  overview(scope: Scope, query: OverviewQuery): Promise<OverviewTotals> {
    const leadType = query.leadType;
    const { start, end } = query.window;
    return this.read(scope, async (tx) => {
      const [row] = await tx.execute<{ [key: string]: unknown }>(sql`
        with cohort as (
          select l.stage, l.status
          from app.leads l
          where l.workspace_id = ${contextWorkspaceId}
            and l.deleted_at is null
            and l.customer_data_restricted_at is null
            and (${leadType}::text is null or l.lead_type = ${leadType})
            and (${query.status ?? null}::text is null or l.status = ${query.status ?? null})
            and l.created_at >= ${start.toISOString()}::timestamptz
            and l.created_at < ${end.toISOString()}::timestamptz
        )
        select
          (select count(*)::int from cohort) as received,
          (select count(*)::int from cohort where status = 'submitted') as submitted,
          (
            select coalesce(
              json_agg(json_build_object('stage', s.stage, 'count', s.count) order by s.count desc, s.stage),
              '[]'::json
            )
            from (select stage, count(*)::int as count from cohort group by stage) s
          ) as stages
      `);
      const parsed = overviewRowSchema.parse(row);
      return {
        received: parsed.received,
        submitted: parsed.submitted,
        byStage: parsed.stages.map((entry) => ({
          stage: entry.stage,
          stageLabel: entry.stage,
          count: entry.count,
        })),
      };
    });
  }

  /**
   * The inbox's own page query (`selectLeadPage`, the staff `GET /leads`
   * route's), inside this read-only, time-limited tenant transaction; its
   * rows are narrowed here to the AI's lead row, the assignee's name read
   * from the active memberships as the other reads do.
   */
  findLeads(scope: Scope, query: FindLeadsQuery): Promise<LeadPage> {
    return this.read(scope, async (tx) => {
      const catalog = query.catalog ?? (await loadPropertyCatalog(tx, 'lead', {}));
      const page = await selectLeadPage(
        tx,
        {
          workspaceId: scope.workspaceId,
          actorId: scope.actorId,
          view: query.archived === true ? 'archived' : 'active',
          ...(query.status === undefined ? {} : { status: query.status }),
          ...(query.leadType === undefined ? {} : { leadType: query.leadType }),
          ...(query.stage === undefined ? {} : { stage: query.stage }),
          ...(query.assignee === undefined ? {} : { assignee: query.assignee }),
          ...(query.search === undefined ? {} : { search: query.search }),
          ...(query.dueBy === undefined ? {} : { dueBy: query.dueBy }),
          ...(query.unopenedOnly === true ? { unopenedOnly: true } : {}),
          ...(query.where === undefined || query.where.length === 0 ? {} : { where: query.where }),
          catalog,
        },
        Math.floor(query.offset / query.limit) + 1,
        query.limit,
      );
      const names = await memberNames(
        tx,
        page.leads.flatMap((lead) => (lead.assignedActorId === null ? [] : [lead.assignedActorId])),
      );
      return {
        rows: page.leads.map((lead) =>
          leadRowSchema.parse({
            id: lead.id,
            lead_type: lead.leadType,
            stage: lead.stage,
            status: lead.status,
            external_ref: lead.externalRef,
            full_name: lead.contact.fullName ?? null,
            assignee_name:
              lead.assignedActorId === null ? null : (names.get(lead.assignedActorId) ?? null),
            created_at: lead.createdAt,
            updated_at: lead.updatedAt,
            deleted_at: lead.deletedAt,
          }),
        ),
        total: page.total,
      };
    });
  }

  siteCatalog(scope: Scope): Promise<PropertyCatalog> {
    return this.read(scope, (tx) => loadPropertyCatalog(tx, 'lead', {}));
  }

  inboxCounts(scope: Scope, dueBy: string): Promise<InboxCounts> {
    return this.read(scope, (tx) => selectLeadSummary(tx, dueBy));
  }

  leadSummary(scope: Scope, query: LeadSummaryQuery): Promise<LeadSummaryRows | undefined> {
    return this.read(scope, async (tx) => {
      const [leadRow] = await tx.execute<{ [key: string]: unknown }>(sql`
        select
          l.id, l.lead_type, l.stage, l.status, l.external_ref, l.full_name,
          m.display_name as assignee_name,
          l.created_at, l.updated_at, l.deleted_at,
          jsonb_strip_nulls(jsonb_build_object(
            'planName', l.order_details -> 'plan' -> 'name',
            'quantity', l.order_details -> 'quantity',
            'dispatchedAt', l.order_details -> 'dispatchedAt',
            'activatedAt', l.order_details -> 'activatedAt',
            'courier', l.order_details -> 'courier',
            'commission', case when ${query.includeCommission === true} then l.order_details -> 'plan' -> 'commission' end,
            'priceMinor', case when ${query.includeFinancial === true} then l.order_details -> 'plan' -> 'priceMinor' end,
            'currency', case when ${query.includeFinancial === true} then l.order_details -> 'plan' -> 'currency' end,
            'paymentStatus', case when ${query.includeFinancial === true} then l.order_details -> 'paymentStatus' end,
            'carrierCommission', case when ${query.includeFinancial === true} then l.order_details -> 'carrierCommission' end
          )) as safe_order
        from app.leads l
        ${assigneeJoin()}
        where l.workspace_id = ${contextWorkspaceId}
          and l.id = ${query.leadId}
          and (${query.includeArchived === true} or l.deleted_at is null)
          and l.customer_data_restricted_at is null
        limit 1
      `);
      if (!leadRow) return undefined;

      const catalog = await loadPropertyCatalog(tx, 'lead', {});
      const order = orderProjectionSchema.parse(leadRow['safe_order']);
      const orderKeys = {
        planName: 'plan',
        quantity: 'quantity',
        dispatchedAt: 'dispatchedAt',
        activatedAt: 'activatedAt',
        courier: 'courier',
        commission: 'plan',
        priceMinor: 'plan',
        currency: 'plan',
        paymentStatus: 'paymentStatus',
        carrierCommission: 'carrierCommission',
      } as const;
      for (const key of [
        'planName',
        'quantity',
        'dispatchedAt',
        'activatedAt',
        'courier',
        'commission',
        'priceMinor',
        'currency',
        'paymentStatus',
        'carrierCommission',
      ] as const) {
        const property = catalog.get(orderKeys[key]);
        if (!property || property.hidden || property.sensitive) delete order[key];
      }
      const taskRows = await tx.execute<{ [key: string]: unknown }>(sql`
        select
          t.id, t.lead_id, l.external_ref as lead_ref, l.full_name as lead_name,
          t.title, t.status, m.display_name as assignee_name, t.due_at
        from app.lead_tasks t
        join app.leads l on l.id = t.lead_id and l.workspace_id = t.workspace_id
        left join app.memberships m
          on m.workspace_id = t.workspace_id and m.user_id = t.assigned_actor_id and m.status = 'active'
        where t.workspace_id = ${contextWorkspaceId}
          and t.lead_id = ${query.leadId}
          and t.status in ('open', 'in_progress')
          and l.deleted_at is null
        order by t.due_at asc nulls last, t.id
        limit ${SUMMARY_TASKS + 1}
      `);

      const activityRows = await tx.execute<{ [key: string]: unknown }>(sql`
        select a.kind, a.created_at as at,
          -- A sent mail keeps its words in body too; the summary carries notes only.
          case when a.kind = 'system' then null else a.body end as body
        from app.lead_activities a
        where a.workspace_id = ${contextWorkspaceId}
          and a.lead_id = ${query.leadId}
        order by a.created_at desc, a.id
        limit ${SUMMARY_ACTIVITY + 1}
      `);

      // Notes are read separately: asking for them must not depend on whether
      // the last ten activities happened to include one.
      const noteRows = query.includeNotes
        ? await tx.execute<{ [key: string]: unknown }>(sql`
            select a.kind, a.created_at as at, a.body
            from app.lead_activities a
            where a.workspace_id = ${contextWorkspaceId}
              and a.lead_id = ${query.leadId}
              and a.kind = 'note'
              and a.body is not null
            order by a.created_at desc, a.id
            limit ${SUMMARY_NOTES + 1}
          `)
        : [];

      // The lead page's own read, for its timeline, documents, change request
      // and values; projected for the model by the caller (lead-record.ts).
      const work = query.includeRecord
        ? await selectLeadWithWork(tx, scope.workspaceId, query.leadId, catalog)
        : undefined;
      const record =
        work === undefined
          ? undefined
          : {
              work,
              catalog,
              names: await memberNames(tx),
              legacyKinds: await legacyActivityKinds(tx, query.leadId),
            };

      return {
        ...(record === undefined ? {} : { record }),
        lead: leadRowSchema.parse(leadRow),
        ...(Object.keys(order).length === 0 ? {} : { order }),
        truncated:
          taskRows.length > SUMMARY_TASKS ||
          activityRows.length > SUMMARY_ACTIVITY ||
          noteRows.length > SUMMARY_NOTES,
        openTasks: taskRows.slice(0, SUMMARY_TASKS).map((row) => taskRowSchema.parse(row)),
        activity: activityRows
          .slice(0, SUMMARY_ACTIVITY)
          .map((row) => activityRowSchema.parse(row)),
        notes: noteRows.slice(0, SUMMARY_NOTES).map((row) => activityRowSchema.parse(row)),
      };
    });
  }

  /**
   * Tasks by stage: a lead's while its lead is active and unrestricted, and
   * the site's plain tasks (no lead). A left join on purpose, so a plain task
   * is listed, never dropped by the join.
   *
   * The order puts the task a person means within the tool's five pages:
   * done tasks most recently completed first and cancelled ones most recently
   * changed first ("reopen the call I finished today"); active ones soonest
   * due first, with the undated ones ahead of them, most recently changed
   * first, because no due window reaches an undated task and after every
   * dated one it would sit past the last page. The id breaks every tie.
   */
  openTasks(scope: Scope, query: OpenTasksQuery): Promise<TaskPage> {
    const status = query.status ?? 'active';
    const conditions: SQL[] = [
      sql`t.workspace_id = ${contextWorkspaceId}`,
      status === 'active' ? sql`t.status in ('open', 'in_progress')` : sql`t.status = ${status}`,
      sql`(t.lead_id is null or (l.deleted_at is null and l.customer_data_restricted_at is null))`,
    ];
    if (query.titleContains !== undefined)
      conditions.push(sql`t.title ilike ${likePattern(query.titleContains)}`);
    if (query.completedSince !== undefined)
      conditions.push(sql`t.completed_at >= ${query.completedSince.toISOString()}::timestamptz`);
    const order =
      status === 'done'
        ? sql`t.completed_at desc nulls last, t.id`
        : status === 'cancelled'
          ? sql`t.updated_at desc, t.id`
          : sql`t.due_at asc nulls first, t.updated_at desc, t.id`;
    if (query.assignee === 'me') {
      conditions.push(sql`t.assigned_actor_id = ${scope.actorId}`);
    } else if (query.assignee === 'none') {
      conditions.push(sql`t.assigned_actor_id is null`);
    } else if (query.assignee !== 'all') {
      conditions.push(sql`t.assigned_actor_id = ${query.assignee}`);
    }
    if (query.due.from !== undefined)
      conditions.push(sql`t.due_at >= ${query.due.from.toISOString()}::timestamptz`);
    if (query.due.before !== undefined)
      conditions.push(sql`t.due_at < ${query.due.before.toISOString()}::timestamptz`);

    return this.read(scope, async (tx) => {
      const rows = await tx.execute<{ [key: string]: unknown }>(sql`
        select
          t.id, t.lead_id, l.external_ref as lead_ref, l.full_name as lead_name,
          t.title, t.status, m.display_name as assignee_name, t.due_at,
          count(*) over ()::int as total
        from app.lead_tasks t
        left join app.leads l on l.id = t.lead_id and l.workspace_id = t.workspace_id
        left join app.memberships m
          on m.workspace_id = t.workspace_id and m.user_id = t.assigned_actor_id and m.status = 'active'
        where ${sql.join(conditions, sql` and `)}
        order by ${order}
        limit ${query.limit} offset ${query.offset}
      `);
      const total = rows[0]?.['total'];
      if (typeof total === 'number') {
        return { rows: rows.map((row) => taskRowSchema.parse(row)), total };
      }
      const [counted] = await tx.execute<{ [key: string]: unknown }>(sql`
        select count(*)::int as total
        from app.lead_tasks t
        left join app.leads l on l.id = t.lead_id and l.workspace_id = t.workspace_id
        where ${sql.join(conditions, sql` and `)}
      `);
      return { rows: [], total: countRowSchema.parse(counted).total };
    });
  }

  leadLabels(scope: Scope, leadIds: readonly string[]): Promise<Map<string, LeadHint>> {
    const ids = [...new Set(leadIds)].slice(0, 100);
    if (ids.length === 0) return Promise.resolve(new Map());
    return this.read(scope, async (tx) => {
      const rows = await tx.execute<{ [key: string]: unknown }>(sql`
        select l.id, l.lead_type, l.stage, l.external_ref, l.full_name
        from app.leads l
        where l.workspace_id = ${contextWorkspaceId}
          and l.id in (${sql.join(
            ids.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})
          and l.deleted_at is null
          and l.customer_data_restricted_at is null
      `);
      const labels = new Map<string, LeadHint>();
      for (const row of rows) {
        const parsed = leadHintRowSchema.parse(row);
        labels.set(parsed.id, {
          leadId: parsed.id,
          leadType: parsed.lead_type,
          stage: parsed.stage,
          reference: parsed.external_ref,
          name: parsed.full_name,
        });
      }
      return labels;
    });
  }

  mentionLabels(
    scope: Scope,
    leadIds: readonly string[],
  ): Promise<Map<string, { name: string | null; reference: string | null }>> {
    const ids = [...new Set(leadIds)].slice(0, 100);
    if (ids.length === 0) return Promise.resolve(new Map());
    return this.read(scope, async (tx) => {
      const rows = await tx.execute<{ [key: string]: unknown }>(sql`
        select l.id, l.lead_type, l.stage, l.external_ref, l.full_name
        from app.leads l
        where l.workspace_id = ${contextWorkspaceId}
          and l.id in (${sql.join(
            ids.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})
          and l.customer_data_restricted_at is null
      `);
      const labels = new Map<string, { name: string | null; reference: string | null }>();
      for (const row of rows) {
        const parsed = leadHintRowSchema.parse(row);
        labels.set(parsed.id, { name: parsed.full_name, reference: parsed.external_ref });
      }
      return labels;
    });
  }

  memberNames(scope: Scope): Promise<Map<string, string | null>> {
    return this.read(scope, (tx) => memberNames(tx));
  }

  leadHint(scope: Scope, leadId: string): Promise<LeadHint | undefined> {
    return this.read(scope, async (tx) => {
      const [row] = await tx.execute<{ [key: string]: unknown }>(sql`
        select l.id, l.lead_type, l.stage, l.external_ref, l.full_name, l.created_at
        from app.leads l
        where l.workspace_id = ${contextWorkspaceId}
          and l.id = ${leadId}
          and l.deleted_at is null
          and l.customer_data_restricted_at is null
        limit 1
      `);
      const parsed = leadHintRowSchema.safeParse(row);
      if (!parsed.success) return undefined;
      return {
        leadId: parsed.data.id,
        leadType: parsed.data.lead_type,
        stage: parsed.data.stage,
        reference: parsed.data.external_ref,
        name: parsed.data.full_name,
        ...(parsed.data.created_at ? { createdAt: parsed.data.created_at } : {}),
      };
    });
  }
}
