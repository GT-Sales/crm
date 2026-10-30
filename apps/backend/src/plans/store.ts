import { randomUUID } from 'node:crypto';

import { and, asc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import {
  auditEvents,
  plans,
  properties,
  withTenantTx,
  type DatabaseClient,
  type TenantContext,
  type TenantTransaction,
} from '@gt-sales/db';
import {
  PLAN_LIMIT,
  applyCustomValueEdits,
  planSchema,
  type CreatePlanRequest,
  type Plan,
  type PlanOption,
  type PropertyValue,
  type UpdatePlanRequest,
  type WebsitePlan,
} from '@gt-sales/contracts';

import { loadPropertyCatalog } from '../properties/catalog.js';
import { PLAN_ORDER, loadPlanOptions } from './options.js';
import type { PropertyContext } from '../properties/store.js';

/**
 * The plans a site sells (spec §5.3): one order lead type each, a price in
 * integer cents CAD, and values for the site's custom plan properties
 * (`object = 'plan'`). Plans are never deleted; one no longer sold is made
 * inactive, and every order that named it keeps its own frozen copy, so no
 * write here ever touches a lead. Every write runs in one tenant transaction
 * that first takes the site's plan lock, so the limit and the next position
 * are read with no concurrent write in between. Plan data is not personal,
 * so audit rows carry the whole plan.
 */

export type CreatePlanOutcome =
  | { kind: 'created'; plan: Plan }
  | { kind: 'name_taken' }
  | { kind: 'limit_reached' }
  | { kind: 'invalid_custom_value'; field: string };
export type UpdatePlanOutcome =
  | { kind: 'updated'; plan: Plan }
  | { kind: 'not_found' }
  | { kind: 'name_taken' }
  | { kind: 'version_conflict' }
  | { kind: 'invalid_custom_value'; field: string };

export interface PlanStore {
  /** Ordered by lead type, position, then name ignoring case; inactive plans only when asked. */
  list(
    ctx: TenantContext,
    filter: { leadType?: string; includeInactive: boolean },
  ): Promise<Plan[]>;
  get(ctx: TenantContext, planId: string): Promise<Plan | undefined>;
  create(ctx: PropertyContext, input: CreatePlanRequest): Promise<CreatePlanOutcome>;
  update(
    ctx: PropertyContext,
    planId: string,
    input: UpdatePlanRequest,
  ): Promise<UpdatePlanOutcome>;
  /** For the website and for freezing: active plans (of one type), with only website-visible custom values. */
  listForWebsite(ctx: TenantContext, leadType?: string): Promise<WebsitePlan[]>;
  /** Every plan, inactive ones included, for the catalogue. */
  options(ctx: TenantContext): Promise<PlanOption[]>;
}

type PlanDatabase = Pick<DatabaseClient, 'withTenantTx'>;
type PlanRecord = typeof plans.$inferSelect;

const AUDIT_ACTOR_LABEL = 'staff actor';
const NAME_INDEX = 'plans_workspace_type_name_unique';

const isPropertyValue = (value: unknown): value is PropertyValue =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

/** The stored custom values that are plain values; anything else is left out. */
function storedValues(value: unknown): Record<string, PropertyValue> {
  const values: Record<string, PropertyValue> = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return values;
  for (const [key, entry] of Object.entries(value)) {
    if (isPropertyValue(entry)) values[key] = entry;
  }
  return values;
}

/** The API form of a stored row; parsing narrows its text columns to their enums. */
function toPlan(record: PlanRecord): Plan {
  return planSchema.parse({
    id: record.id,
    leadType: record.leadType,
    name: record.name,
    priceMinor: record.priceMinor,
    currency: record.currency,
    billingPeriod: record.billingPeriod,
    paymentRequired: record.paymentRequired,
    active: record.active,
    requiredDocuments: record.requiredDocuments,
    customValues: storedValues(record.customValues),
    position: record.position,
    version: record.version,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}

/** `plans_workspace_type_name_unique`: the site already has a plan of this type by this name (any case). */
function isNameTaken(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    if (
      'code' in current &&
      current.code === '23505' &&
      'constraint_name' in current &&
      current.constraint_name === NAME_INDEX
    ) {
      return true;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

/** The site's plan lock: every write takes it first. */
async function lockSitePlans(tx: TenantTransaction, workspaceId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('plans:' || ${workspaceId}::text, 0))`,
  );
}

async function selectPlans(tx: TenantTransaction, where: SQL | undefined): Promise<PlanRecord[]> {
  return tx
    .select()
    .from(plans)
    .where(where)
    .orderBy(...PLAN_ORDER);
}

/**
 * The keys of the site's live custom plan properties shown on the website,
 * with the lead types each applies to ([] = every type). Hidden ones are left
 * out: a hidden property is shown nowhere.
 */
async function websiteVisibleProperties(
  tx: TenantTransaction,
  workspaceId: string,
): Promise<{ key: string; leadTypes: string[] }[]> {
  return tx
    .select({ key: properties.key, leadTypes: properties.leadTypes })
    .from(properties)
    .where(
      and(
        eq(properties.workspaceId, workspaceId),
        eq(properties.object, 'plan'),
        eq(properties.origin, 'custom'),
        eq(properties.websiteVisible, true),
        eq(properties.hidden, false),
        isNull(properties.deletedAt),
      ),
    )
    .orderBy(asc(properties.position), asc(properties.key));
}

async function auditPlan(
  tx: TenantTransaction,
  ctx: PropertyContext,
  input: { action: 'plan.created' | 'plan.updated'; before: Plan | null; after: Plan },
): Promise<void> {
  await tx.insert(auditEvents).values({
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    actorLabel: AUDIT_ACTOR_LABEL,
    action: input.action,
    entity: 'plan',
    entityId: input.after.id,
    requestId: ctx.requestId ?? randomUUID(),
    before: input.before,
    after: input.after,
  });
}

export class DatabasePlanStore implements PlanStore {
  constructor(private readonly database: PlanDatabase = { withTenantTx }) {}

  list(
    ctx: TenantContext,
    filter: { leadType?: string; includeInactive: boolean },
  ): Promise<Plan[]> {
    return this.database.withTenantTx(ctx, async (tx) => {
      const records = await selectPlans(
        tx,
        and(
          eq(plans.workspaceId, ctx.workspaceId),
          filter.leadType === undefined ? undefined : eq(plans.leadType, filter.leadType),
          filter.includeInactive ? undefined : eq(plans.active, true),
        ),
      );
      return records.map(toPlan);
    });
  }

  get(ctx: TenantContext, planId: string): Promise<Plan | undefined> {
    return this.database.withTenantTx(ctx, async (tx) => {
      const [record] = await selectPlans(
        tx,
        and(eq(plans.workspaceId, ctx.workspaceId), eq(plans.id, planId)),
      );
      return record ? toPlan(record) : undefined;
    });
  }

  async create(ctx: PropertyContext, input: CreatePlanRequest): Promise<CreatePlanOutcome> {
    try {
      // A failed insert aborts the transaction, so its unique violation is
      // answered here, after the rollback.
      return await this.database.withTenantTx(ctx, async (tx): Promise<CreatePlanOutcome> => {
        await lockSitePlans(tx, ctx.workspaceId);

        const [counts] = await tx
          .select({
            total: sql<number>`count(*)::int`,
            lastPosition: sql<number>`coalesce(max(${plans.position}) filter (where ${plans.leadType} = ${input.leadType}), -1)::int`,
          })
          .from(plans)
          .where(eq(plans.workspaceId, ctx.workspaceId));
        if ((counts?.total ?? 0) >= PLAN_LIMIT) return { kind: 'limit_reached' };

        const catalog = await loadPropertyCatalog(tx, 'plan');
        const edit = applyCustomValueEdits({
          properties: catalog.forType(input.leadType),
          current: {},
          edits: input.customValues,
        });
        if (!edit.ok) return { kind: 'invalid_custom_value', field: edit.field };

        const [record] = await tx
          .insert(plans)
          .values({
            workspaceId: ctx.workspaceId,
            leadType: input.leadType,
            name: input.name,
            priceMinor: input.priceMinor,
            billingPeriod: input.billingPeriod,
            paymentRequired: input.paymentRequired,
            active: input.active,
            requiredDocuments: input.requiredDocuments,
            customValues: edit.values,
            position: (counts?.lastPosition ?? -1) + 1,
            createdBy: ctx.actorId,
            updatedBy: ctx.actorId,
          })
          .returning();
        if (!record) throw new Error('plan insert did not return a row');
        const plan = toPlan(record);
        await auditPlan(tx, ctx, { action: 'plan.created', before: null, after: plan });
        return { kind: 'created', plan };
      });
    } catch (error) {
      if (isNameTaken(error)) return { kind: 'name_taken' };
      throw error;
    }
  }

  async update(
    ctx: PropertyContext,
    planId: string,
    input: UpdatePlanRequest,
  ): Promise<UpdatePlanOutcome> {
    try {
      return await this.database.withTenantTx(ctx, async (tx): Promise<UpdatePlanOutcome> => {
        await lockSitePlans(tx, ctx.workspaceId);
        const [record] = await tx
          .select()
          .from(plans)
          .where(and(eq(plans.workspaceId, ctx.workspaceId), eq(plans.id, planId)))
          .for('update');
        if (!record) return { kind: 'not_found' };
        if (record.version !== input.expectedVersion) return { kind: 'version_conflict' };
        const before = toPlan(record);

        const set: Partial<typeof plans.$inferInsert> = {};
        if (input.customValues !== undefined && Object.keys(input.customValues).length > 0) {
          const catalog = await loadPropertyCatalog(tx, 'plan');
          const edit = applyCustomValueEdits({
            properties: catalog.forType(before.leadType),
            current: storedValues(record.customValues),
            edits: input.customValues,
          });
          if (!edit.ok) return { kind: 'invalid_custom_value', field: edit.field };
          set.customValues = edit.values;
        }
        if (input.name !== undefined) set.name = input.name;
        if (input.priceMinor !== undefined) set.priceMinor = input.priceMinor;
        if (input.billingPeriod !== undefined) set.billingPeriod = input.billingPeriod;
        if (input.paymentRequired !== undefined) set.paymentRequired = input.paymentRequired;
        if (input.active !== undefined) set.active = input.active;
        if (input.requiredDocuments !== undefined) set.requiredDocuments = input.requiredDocuments;
        if (input.position !== undefined) set.position = input.position;

        const [updated] = await tx
          .update(plans)
          .set({
            ...set,
            version: sql`${plans.version} + 1`,
            updatedBy: ctx.actorId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(plans.workspaceId, ctx.workspaceId),
              eq(plans.id, planId),
              eq(plans.version, input.expectedVersion),
            ),
          )
          .returning();
        if (!updated) return { kind: 'version_conflict' };
        const plan = toPlan(updated);
        await auditPlan(tx, ctx, { action: 'plan.updated', before, after: plan });
        return { kind: 'updated', plan };
      });
    } catch (error) {
      if (isNameTaken(error)) return { kind: 'name_taken' };
      throw error;
    }
  }

  listForWebsite(ctx: TenantContext, leadType?: string): Promise<WebsitePlan[]> {
    return this.database.withTenantTx(ctx, async (tx) => {
      const visible = await websiteVisibleProperties(tx, ctx.workspaceId);
      const records = await selectPlans(
        tx,
        and(
          eq(plans.workspaceId, ctx.workspaceId),
          eq(plans.active, true),
          leadType === undefined ? undefined : eq(plans.leadType, leadType),
        ),
      );
      return records.map((record) => {
        const plan = toPlan(record);
        const values: Record<string, PropertyValue> = {};
        for (const property of visible) {
          const applies =
            property.leadTypes.length === 0 || property.leadTypes.includes(plan.leadType);
          const value = Object.hasOwn(plan.customValues, property.key)
            ? plan.customValues[property.key]
            : undefined;
          if (applies && value !== undefined) values[property.key] = value;
        }
        return {
          id: plan.id,
          leadType: plan.leadType,
          name: plan.name,
          priceMinor: plan.priceMinor,
          currency: plan.currency,
          billingPeriod: plan.billingPeriod,
          paymentRequired: plan.paymentRequired,
          requiredDocuments: plan.requiredDocuments,
          properties: values,
        };
      });
    });
  }

  options(ctx: TenantContext): Promise<PlanOption[]> {
    return this.database.withTenantTx(ctx, (tx) => loadPlanOptions(tx));
  }
}
