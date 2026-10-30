import { asc, eq, sql } from 'drizzle-orm';
import { contextWorkspaceId, plans, type TenantTransaction } from '@gt-sales/db';
import type { PlanOption } from '@gt-sales/contracts';

/** How plans are listed everywhere: by lead type, position, then name ignoring case. */
export const PLAN_ORDER = [
  asc(plans.leadType),
  asc(plans.position),
  sql`lower(${plans.name})`,
  asc(plans.id),
];

/**
 * Every plan of the transaction's site, inactive ones included, with its
 * lead type, as the lead catalogue's `plan` property offers them (an inactive
 * plan, or another type's, is a hidden option, so an order that names it
 * still reads). Kept apart from the plan
 * store so the property catalogue can load it without importing that store.
 */
export function loadPlanOptions(tx: TenantTransaction): Promise<PlanOption[]> {
  return tx
    .select({ id: plans.id, name: plans.name, active: plans.active, leadType: plans.leadType })
    .from(plans)
    .where(eq(plans.workspaceId, contextWorkspaceId))
    .orderBy(...PLAN_ORDER);
}
