import { sql, type SQL } from 'drizzle-orm';
import type { TenantTransaction } from '@gt-sales/db';
import type { Condition, ConditionGroup, PropertyCatalog } from '@gt-sales/contracts';

import { propertyFilterCondition, resolvePropertyFor } from '../leads/staff-queries.js';

/**
 * A flow's conditions (spec §5 "Conditions") as one SQL expression on lead
 * `l`: a property condition is exactly the inbox filter of the same shape
 * (`propertyFilterCondition`, resolved for the lead's type, so a hidden or
 * sensitive property matches nothing); a plan condition reads the frozen
 * plan's id, else the order's `planId`; stage and assignee read the columns.
 * Every value is bound.
 */

/** A group at either level: groups go two levels deep. */
interface AnyConditionGroup {
  readonly match: 'all' | 'any';
  readonly items: readonly (Condition | AnyConditionGroup)[];
}

const isGroup = (item: Condition | AnyConditionGroup): item is AnyConditionGroup => 'match' in item;

const listOf = (values: readonly string[]): SQL =>
  sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );

/** The plan an order lead stands on: the frozen copy's id, else the link. */
const PLAN_ID = sql`coalesce(l.order_details -> 'plan' ->> 'id', l.order_details ->> 'planId')`;

function conditionSql(condition: Condition, leadType: string, catalog: PropertyCatalog): SQL {
  switch (condition.kind) {
    case 'lead_type':
      return sql`l.lead_type in (${listOf(condition.in)})`;
    case 'stage':
      return condition.op === 'in'
        ? sql`l.stage in (${listOf(condition.stages)})`
        : sql`l.stage not in (${listOf(condition.stages)})`;
    case 'plan':
      return condition.op === 'in'
        ? sql`coalesce(${PLAN_ID} in (${listOf(condition.planIds)}), false)`
        : sql`(${PLAN_ID} is null or ${PLAN_ID} not in (${listOf(condition.planIds)}))`;
    case 'assignee':
      if (condition.op === 'none') return sql`l.assigned_actor_id is null`;
      if (condition.op === 'any') return sql`l.assigned_actor_id is not null`;
      return condition.actorId === undefined
        ? sql`false`
        : sql`coalesce(l.assigned_actor_id = ${condition.actorId}::uuid, false)`;
    case 'property': {
      const property = resolvePropertyFor(catalog, condition.filter.key, leadType);
      return property
        ? sql`coalesce((${propertyFilterCondition(condition.filter, property)}), false)`
        : sql`false`;
    }
  }
}

function groupSql(group: AnyConditionGroup, leadType: string, catalog: PropertyCatalog): SQL {
  const parts = group.items.map((item) =>
    isGroup(item) ? groupSql(item, leadType, catalog) : conditionSql(item, leadType, catalog),
  );
  if (parts.length === 0) return group.match === 'all' ? sql`true` : sql`false`;
  return sql`(${sql.join(parts, group.match === 'all' ? sql` and ` : sql` or `)})`;
}

/** The group as a boolean expression on lead `l`, for a lead of `leadType`. */
export function conditionGroupSql(
  group: ConditionGroup,
  leadType: string,
  catalog: PropertyCatalog,
): SQL {
  return groupSql(group, leadType, catalog);
}

/** One statement on the lead row; property conditions mean exactly what the same inbox filter means. */
export async function evaluateConditionGroup(
  tx: TenantTransaction,
  input: {
    workspaceId: string;
    leadId: string;
    leadType: string;
    group: ConditionGroup;
    catalog: PropertyCatalog;
  },
): Promise<boolean> {
  const rows = await tx.execute<{ holds: boolean }>(sql`
    select coalesce(${conditionGroupSql(input.group, input.leadType, input.catalog)}, false) as holds
    from app.leads l
    where l.workspace_id = ${input.workspaceId} and l.id = ${input.leadId}
  `);
  return rows[0]?.holds === true;
}
