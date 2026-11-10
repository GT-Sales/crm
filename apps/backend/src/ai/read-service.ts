import {
  contextWorkspaceId,
  withTenantTx,
  type DatabaseClient,
  type TenantTransaction,
} from '@gt-sales/db';
import { AI_ASSISTANT_LIMITS } from '@gt-sales/contracts';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

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
  readonly limit: number;
  readonly offset: number;
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
}

export interface OpenTasksQuery {
  readonly assignee: 'me' | 'all' | 'none' | string;
  readonly due: TaskDueWindow;
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
}

export interface LeadHint {
  readonly leadId: string;
  readonly leadType: string;
  readonly stage: string;
  readonly reference: string | null;
  readonly name: string | null;
}

const leadHintRowSchema = z.object({
  id: z.uuid(),
  lead_type: z.string().min(1),
  stage: z.string().min(1),
  external_ref: z.string().nullable(),
  full_name: z.string().nullable(),
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

/**
 * The exact total for the same cohort a page selected, used only when the page
 * itself is empty (an offset past the end) and the window count is unavailable.
 */
async function countLeads(tx: TenantTransaction, conditions: SQL[]): Promise<number> {
  const [row] = await tx.execute<{ [key: string]: unknown }>(sql`
    select count(*)::int as total
    from app.leads l
    where ${sql.join(conditions, sql` and `)}
  `);
  return countRowSchema.parse(row).total;
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

  findLeads(scope: Scope, query: FindLeadsQuery): Promise<LeadPage> {
    const conditions: SQL[] = [
      sql`l.workspace_id = ${contextWorkspaceId}`,
      sql`l.customer_data_restricted_at is null`,
      query.archived ? sql`l.deleted_at is not null` : sql`l.deleted_at is null`,
    ];
    if (query.leadType !== undefined) conditions.push(sql`l.lead_type = ${query.leadType}`);
    if (query.stage !== undefined) conditions.push(sql`l.stage = ${query.stage}`);
    if (query.search !== undefined) {
      const pattern = likePattern(query.search);
      conditions.push(
        sql`(l.full_name ilike ${pattern} or l.external_ref ilike ${pattern} or l.email ilike ${pattern} or l.phone ilike ${pattern})`,
      );
    }
    if (query.assignee === 'me') {
      conditions.push(sql`l.assigned_actor_id = ${scope.actorId}`);
    } else if (query.assignee === 'none') {
      conditions.push(sql`l.assigned_actor_id is null`);
    } else if (query.assignee !== undefined) {
      conditions.push(sql`l.assigned_actor_id = ${query.assignee}`);
    }

    return this.read(scope, async (tx) => {
      const rows = await tx.execute<{ [key: string]: unknown }>(sql`
        select
          l.id, l.lead_type, l.stage, l.status, l.external_ref, l.full_name,
          m.display_name as assignee_name,
          l.created_at, l.updated_at, l.deleted_at,
          count(*) over ()::int as total
        from app.leads l
        ${assigneeJoin()}
        where ${sql.join(conditions, sql` and `)}
        order by l.updated_at desc, l.id
        limit ${query.limit} offset ${query.offset}
      `);
      const total = rows[0]?.['total'];
      if (typeof total === 'number') {
        return { rows: rows.map((row) => leadRowSchema.parse(row)), total };
      }
      // An offset past the last row returns no page, so the window count is
      // gone with it; count the same cohort directly rather than reporting 0.
      return { rows: [], total: await countLeads(tx, conditions) };
    });
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
          t.title, m.display_name as assignee_name, t.due_at
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
        select a.kind, a.created_at as at, a.body
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

      return {
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

  openTasks(scope: Scope, query: OpenTasksQuery): Promise<TaskPage> {
    const conditions: SQL[] = [
      sql`t.workspace_id = ${contextWorkspaceId}`,
      sql`t.status in ('open', 'in_progress')`,
      sql`l.deleted_at is null`,
      sql`l.customer_data_restricted_at is null`,
    ];
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
          t.title, m.display_name as assignee_name, t.due_at,
          count(*) over ()::int as total
        from app.lead_tasks t
        join app.leads l on l.id = t.lead_id and l.workspace_id = t.workspace_id
        left join app.memberships m
          on m.workspace_id = t.workspace_id and m.user_id = t.assigned_actor_id and m.status = 'active'
        where ${sql.join(conditions, sql` and `)}
        order by t.due_at asc nulls last, t.id
        limit ${query.limit} offset ${query.offset}
      `);
      const total = rows[0]?.['total'];
      if (typeof total === 'number') {
        return { rows: rows.map((row) => taskRowSchema.parse(row)), total };
      }
      const [counted] = await tx.execute<{ [key: string]: unknown }>(sql`
        select count(*)::int as total
        from app.lead_tasks t
        join app.leads l on l.id = t.lead_id and l.workspace_id = t.workspace_id
        where ${sql.join(conditions, sql` and `)}
      `);
      return { rows: [], total: countRowSchema.parse(counted).total };
    });
  }

  leadHint(scope: Scope, leadId: string): Promise<LeadHint | undefined> {
    return this.read(scope, async (tx) => {
      const [row] = await tx.execute<{ [key: string]: unknown }>(sql`
        select l.id, l.lead_type, l.stage, l.external_ref, l.full_name
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
      };
    });
  }
}
