import { randomUUID } from 'node:crypto';

import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import {
  auditEvents,
  properties,
  propertyLayouts,
  withTenantTx,
  type DatabaseClient,
  type TenantContext,
  type TenantTransaction,
} from '@gt-sales/db';
import {
  BUILTIN_OVERRIDE_FIELDS,
  PROPERTY_LIMIT,
  ORDER_PROPERTY_KEYS,
  generatePropertyKey,
  leadPropertyCatalog,
  orderPropertyCatalog,
  propertyLayoutRowSchema,
  type CreateCustomProperty,
  type LeadPropertyDefinition,
  type PlanOption,
  type PropertyCatalog,
  type PropertyLayout,
  type PropertyLayoutRow,
  type PropertyObject,
  type PropertyOption,
  type PropertyRow,
  type PropertyUsage,
  type UpdateProperty,
} from '@gt-sales/contracts';

import { loadPlanOptions } from '../plans/options.js';
import {
  loadPropertyCatalog,
  loadPropertyRows,
  toPropertyRow,
  type PropertyRecord,
} from './catalog.js';

/**
 * A site's property definitions and record layouts (spec §5.2): custom
 * properties (tombstoned, never deleted, so a key is reserved forever),
 * relabels and hides of built-ins (an override row created on first change)
 * and one layout per object and lead type. Every write runs in one tenant
 * transaction that first takes the site's property lock, so two writes for
 * one site (two creates with the same label, a create racing the limit)
 * happen one after the other. Audit rows carry the definition, never a
 * lead's values.
 *
 * Plans (`object = 'plan'`) have no built-ins: every plan property is custom,
 * its values live in `app.plans.custom_values`, and a plan property may be
 * shown on the website (`websiteVisible`). The one site lock covers both
 * objects.
 */

export type CreatePropertyOutcome =
  { kind: 'created'; property: PropertyRow } | { kind: 'limit_reached' };
export type UpdatePropertyOutcome =
  | { kind: 'updated'; property: PropertyRow }
  | { kind: 'not_found' }
  | { kind: 'version_conflict' }
  | { kind: 'builtin_locked' }
  /** Options on a kind that has none, a choice left with none, or a repeated option value. */
  | { kind: 'invalid_options' }
  | ({ kind: 'option_in_use'; optionValue: string } & PropertyUsage);
export type RemovePropertyOutcome =
  | { kind: 'deleted' }
  | { kind: 'not_found' }
  | { kind: 'builtin' }
  | ({ kind: 'in_use' } & PropertyUsage);
export type SaveLayoutOutcome =
  | { kind: 'saved'; layout: PropertyLayoutRow }
  | { kind: 'version_conflict' }
  | { kind: 'unknown_key'; key: string };

export interface PropertyModel {
  rows: PropertyRow[];
  layouts: PropertyLayoutRow[];
  /** Leads only: the site's plans, which the order's `plan` property offers. */
  plans?: PlanOption[];
}

/** The tenant context, plus the request id the audit rows carry (a fresh one when absent). */
export interface PropertyContext extends TenantContext {
  requestId?: string;
}

export interface PropertyStore {
  catalog(ctx: PropertyContext, object?: PropertyObject): Promise<PropertyCatalog>;
  model(ctx: PropertyContext, object: PropertyObject): Promise<PropertyModel>;
  create(
    ctx: PropertyContext,
    object: PropertyObject,
    input: CreateCustomProperty,
  ): Promise<CreatePropertyOutcome>;
  update(
    ctx: PropertyContext,
    object: PropertyObject,
    key: string,
    input: UpdateProperty,
  ): Promise<UpdatePropertyOutcome>;
  remove(ctx: PropertyContext, object: PropertyObject, key: string): Promise<RemovePropertyOutcome>;
  saveLayout(
    ctx: PropertyContext,
    object: PropertyObject,
    leadType: string,
    layout: PropertyLayout,
    expectedVersion: number | undefined,
  ): Promise<SaveLayoutOutcome>;
}

type PropertyDatabase = Pick<DatabaseClient, 'withTenantTx'>;

const AUDIT_ACTOR_LABEL = 'staff actor';
const BUILTIN_OVERRIDES: ReadonlySet<string> = new Set(BUILTIN_OVERRIDE_FIELDS);

/** The site's property lock: every write takes it first. */
async function lockSiteProperties(tx: TenantTransaction, workspaceId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('properties:' || ${workspaceId}::text, 0))`,
  );
}

/**
 * The code definition of a built-in key of the object, if it is one: a form
 * property or one of the order properties, either of which a site may
 * relabel or hide. Plans have no built-ins.
 */
function builtinDefinition(
  object: PropertyObject,
  key: string,
): LeadPropertyDefinition | undefined {
  if (object !== 'lead') return undefined;
  if (Object.hasOwn(leadPropertyCatalog, key)) return leadPropertyCatalog[key];
  if (Object.hasOwn(orderPropertyCatalog, key)) return orderPropertyCatalog[key];
  return undefined;
}

function builtinKeys(object: PropertyObject): string[] {
  return object === 'lead' ? [...Object.keys(leadPropertyCatalog), ...ORDER_PROPERTY_KEYS] : [];
}

/** What an audit row records of a property: its definition, no timestamps, no values. */
function definitionOf(row: PropertyRow): Record<string, unknown> {
  return {
    object: row.object,
    key: row.key,
    origin: row.origin,
    label: row.label,
    kind: row.kind,
    options: row.options,
    staffOnly: row.staffOnly,
    sensitive: row.sensitive,
    hidden: row.hidden,
    leadTypes: row.leadTypes,
    websiteVisible: row.websiteVisible,
    position: row.position,
    version: row.version,
  };
}

/** The API form of a stored layout; parsing narrows the object and checks the layout's shape. */
function toLayoutRow(record: typeof propertyLayouts.$inferSelect): PropertyLayoutRow {
  return propertyLayoutRowSchema.parse({
    object: record.object,
    leadType: record.leadType,
    layout: record.layout,
    version: record.version,
    updatedAt: record.updatedAt.toISOString(),
  });
}

/** The rule `createCustomPropertySchema` applies: only a choice has options, at least one, each value once. */
function validOptions(kind: string, options: readonly PropertyOption[]): boolean {
  if (kind !== 'choice') return options.length === 0;
  const values = new Set(options.map((option) => option.value));
  return options.length > 0 && values.size === options.length;
}

/** The row of one key, tombstones included, locked for the rest of the transaction. */
async function lockPropertyRecord(
  tx: TenantTransaction,
  workspaceId: string,
  object: PropertyObject,
  key: string,
): Promise<PropertyRecord | undefined> {
  const [record] = await tx
    .select()
    .from(properties)
    .where(
      and(
        eq(properties.workspaceId, workspaceId),
        eq(properties.object, object),
        eq(properties.key, key),
      ),
    )
    .for('update');
  return record;
}

/**
 * Every record of the object in the site matching `holds`. For leads,
 * trashed and restricted ones are included (a value there still exists),
 * split so the owner knows what to do: active leads can be cleared, trashed
 * ones restored first, restricted ones never edited. A restricted lead counts
 * as restricted whether trashed or not. Plans are never archived or
 * restricted, so every plan holding the value is active (`planCount`).
 */
async function countUsage(
  tx: TenantTransaction,
  workspaceId: string,
  object: PropertyObject,
  holds: SQL,
): Promise<PropertyUsage> {
  if (object === 'plan') {
    const [plan] = await tx.execute<{ planCount: number }>(sql`
      select count(*)::int as "planCount"
      from app.plans
      where workspace_id = ${workspaceId} and ${holds}
    `);
    const planCount = plan?.planCount ?? 0;
    return { leadCount: 0, active: planCount, trashed: 0, restricted: 0, planCount };
  }
  const [row] = await tx.execute<PropertyUsage>(sql`
    select
      count(*)::int as "leadCount",
      count(*) filter (where customer_data_restricted_at is null and deleted_at is null)::int as active,
      count(*) filter (where customer_data_restricted_at is null and deleted_at is not null)::int as trashed,
      count(*) filter (where customer_data_restricted_at is not null)::int as restricted
    from app.leads
    where workspace_id = ${workspaceId} and ${holds}
  `);
  return row ?? { leadCount: 0, active: 0, trashed: 0, restricted: 0 };
}

/** Whether any record (lead or plan) still holds the value. */
function inUse(usage: PropertyUsage): boolean {
  return usage.leadCount > 0 || (usage.planCount ?? 0) > 0;
}

/** Records of the object in the site whose custom value for `key` is exactly the option `value`. */
function countRecordsWithOption(
  tx: TenantTransaction,
  workspaceId: string,
  object: PropertyObject,
  key: string,
  value: string,
): Promise<PropertyUsage> {
  return countUsage(
    tx,
    workspaceId,
    object,
    sql`custom_values -> ${key}::text = to_jsonb(${value}::text)`,
  );
}

/** Records of the object in the site holding any value (not null) for `key`. */
function countRecordsWithValue(
  tx: TenantTransaction,
  workspaceId: string,
  object: PropertyObject,
  key: string,
): Promise<PropertyUsage> {
  return countUsage(
    tx,
    workspaceId,
    object,
    sql`custom_values ? ${key}::text and custom_values -> ${key}::text <> 'null'::jsonb`,
  );
}

async function auditProperty(
  tx: TenantTransaction,
  ctx: PropertyContext,
  input: {
    action: 'property.created' | 'property.updated' | 'property.deleted';
    entityId: string;
    before: PropertyRow | null;
    after: PropertyRow | null;
  },
): Promise<void> {
  await tx.insert(auditEvents).values({
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    actorLabel: AUDIT_ACTOR_LABEL,
    action: input.action,
    entity: 'property',
    entityId: input.entityId,
    requestId: ctx.requestId ?? randomUUID(),
    before: input.before ? definitionOf(input.before) : null,
    after: input.after ? definitionOf(input.after) : null,
  });
}

export class DatabasePropertyStore implements PropertyStore {
  constructor(private readonly database: PropertyDatabase = { withTenantTx }) {}

  catalog(ctx: PropertyContext, object: PropertyObject = 'lead'): Promise<PropertyCatalog> {
    return this.database.withTenantTx(ctx, (tx) => loadPropertyCatalog(tx, object));
  }

  model(ctx: PropertyContext, object: PropertyObject): Promise<PropertyModel> {
    return this.database.withTenantTx(ctx, async (tx) => {
      const rows = await loadPropertyRows(tx, object);
      const layouts = await tx
        .select()
        .from(propertyLayouts)
        .where(
          and(eq(propertyLayouts.workspaceId, ctx.workspaceId), eq(propertyLayouts.object, object)),
        )
        .orderBy(asc(propertyLayouts.leadType));
      return {
        rows,
        layouts: layouts.map(toLayoutRow),
        ...(object === 'lead' ? { plans: await loadPlanOptions(tx) } : {}),
      };
    });
  }

  create(
    ctx: PropertyContext,
    object: PropertyObject,
    input: CreateCustomProperty,
  ): Promise<CreatePropertyOutcome> {
    return this.database.withTenantTx(ctx, async (tx) => {
      await lockSiteProperties(tx, ctx.workspaceId);

      const existing = await tx
        .select({
          key: properties.key,
          origin: properties.origin,
          position: properties.position,
          deletedAt: properties.deletedAt,
        })
        .from(properties)
        .where(and(eq(properties.workspaceId, ctx.workspaceId), eq(properties.object, object)));
      const custom = existing.filter((row) => row.origin === 'custom');
      if (custom.filter((row) => row.deletedAt === null).length >= PROPERTY_LIMIT) {
        return { kind: 'limit_reached' };
      }

      // Built-ins, live rows and tombstones: a key is never given out twice.
      const reserved = new Set([...builtinKeys(object), ...existing.map((row) => row.key)]);
      const key = generatePropertyKey(input.label, reserved);
      const position = custom.reduce((max, row) => Math.max(max, row.position), -1) + 1;

      const [record] = await tx
        .insert(properties)
        .values({
          workspaceId: ctx.workspaceId,
          object,
          key,
          origin: 'custom',
          label: input.label,
          kind: input.kind,
          options: input.options,
          staffOnly: input.staffOnly,
          sensitive: input.sensitive,
          leadTypes: input.leadTypes,
          websiteVisible: object === 'plan' && input.websiteVisible,
          position,
          createdBy: ctx.actorId,
          updatedBy: ctx.actorId,
        })
        .returning();
      if (!record) throw new Error('property insert did not return a row');
      const property = toPropertyRow(record);
      await auditProperty(tx, ctx, {
        action: 'property.created',
        entityId: record.id,
        before: null,
        after: property,
      });
      return { kind: 'created', property };
    });
  }

  update(
    ctx: PropertyContext,
    object: PropertyObject,
    key: string,
    input: UpdateProperty,
  ): Promise<UpdatePropertyOutcome> {
    return this.database.withTenantTx(ctx, async (tx) => {
      await lockSiteProperties(tx, ctx.workspaceId);
      const code = builtinDefinition(object, key);
      let record = await lockPropertyRecord(tx, ctx.workspaceId, object, key);
      const set: Partial<typeof properties.$inferInsert> = {};

      if (code) {
        const locked = Object.entries(input).some(
          ([field, value]) => value !== undefined && !BUILTIN_OVERRIDES.has(field),
        );
        if (locked) return { kind: 'builtin_locked' };
        if (record && record.origin !== 'builtin') return { kind: 'not_found' };
        if (!record) {
          // The code definition stands as version 1 until the site first changes it.
          if (input.expectedVersion !== 1) return { kind: 'version_conflict' };
          [record] = await tx
            .insert(properties)
            .values({
              workspaceId: ctx.workspaceId,
              object,
              key,
              origin: 'builtin',
              label: code.label,
              kind: code.kind,
              version: 1,
              createdBy: ctx.actorId,
              updatedBy: ctx.actorId,
            })
            .returning();
          if (!record) throw new Error('property override insert did not return a row');
        }
        if (record.version !== input.expectedVersion) return { kind: 'version_conflict' };
        if (input.label !== undefined) set.label = input.label;
        if (input.hidden !== undefined) set.hidden = input.hidden;
      } else {
        if (!record || record.origin !== 'custom' || record.deletedAt !== null) {
          return { kind: 'not_found' };
        }
        if (record.version !== input.expectedVersion) return { kind: 'version_conflict' };

        if (input.options !== undefined) {
          if (!validOptions(record.kind, input.options)) return { kind: 'invalid_options' };
          // Dropping an option some lead holds would orphan the value; hiding it never does.
          const kept = new Set(input.options.map((option) => option.value));
          for (const option of toPropertyRow(record).options) {
            if (kept.has(option.value)) continue;
            const usage = await countRecordsWithOption(
              tx,
              ctx.workspaceId,
              object,
              key,
              option.value,
            );
            if (inUse(usage)) {
              return { kind: 'option_in_use', optionValue: option.value, ...usage };
            }
          }
          set.options = input.options;
        }
        if (input.label !== undefined) set.label = input.label;
        if (input.staffOnly !== undefined) set.staffOnly = input.staffOnly;
        if (input.sensitive !== undefined) set.sensitive = input.sensitive;
        if (input.hidden !== undefined) set.hidden = input.hidden;
        if (input.leadTypes !== undefined) set.leadTypes = input.leadTypes;
        if (input.position !== undefined) set.position = input.position;
        if (object === 'plan' && input.websiteVisible !== undefined) {
          set.websiteVisible = input.websiteVisible;
        }
      }

      const before = toPropertyRow(record);
      const [updated] = await tx
        .update(properties)
        .set({
          ...set,
          version: sql`${properties.version} + 1`,
          updatedBy: ctx.actorId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(properties.workspaceId, ctx.workspaceId),
            eq(properties.id, record.id),
            eq(properties.version, input.expectedVersion),
          ),
        )
        .returning();
      if (!updated) return { kind: 'version_conflict' };
      const property = toPropertyRow(updated);
      await auditProperty(tx, ctx, {
        action: 'property.updated',
        entityId: updated.id,
        before,
        after: property,
      });
      return { kind: 'updated', property };
    });
  }

  remove(
    ctx: PropertyContext,
    object: PropertyObject,
    key: string,
  ): Promise<RemovePropertyOutcome> {
    return this.database.withTenantTx(ctx, async (tx) => {
      await lockSiteProperties(tx, ctx.workspaceId);
      if (builtinDefinition(object, key)) return { kind: 'builtin' };
      const record = await lockPropertyRecord(tx, ctx.workspaceId, object, key);
      if (!record || record.origin !== 'custom' || record.deletedAt !== null) {
        return { kind: 'not_found' };
      }

      const usage = await countRecordsWithValue(tx, ctx.workspaceId, object, key);
      if (inUse(usage)) return { kind: 'in_use', ...usage };

      await tx
        .update(properties)
        .set({ deletedAt: sql`now()`, updatedBy: ctx.actorId, updatedAt: new Date() })
        .where(and(eq(properties.workspaceId, ctx.workspaceId), eq(properties.id, record.id)));
      await auditProperty(tx, ctx, {
        action: 'property.deleted',
        entityId: record.id,
        before: toPropertyRow(record),
        after: null,
      });
      return { kind: 'deleted' };
    });
  }

  saveLayout(
    ctx: PropertyContext,
    object: PropertyObject,
    leadType: string,
    layout: PropertyLayout,
    expectedVersion: number | undefined,
  ): Promise<SaveLayoutOutcome> {
    return this.database.withTenantTx(ctx, async (tx) => {
      await lockSiteProperties(tx, ctx.workspaceId);

      // Hidden properties may stay in a layout (the record page skips them); unknown keys may not.
      const catalog = await loadPropertyCatalog(tx, object);
      for (const section of layout.sections) {
        const unknown = section.keys.find((key) => catalog.get(key) === undefined);
        if (unknown !== undefined) return { kind: 'unknown_key', key: unknown };
      }

      const [existing] = await tx
        .select()
        .from(propertyLayouts)
        .where(
          and(
            eq(propertyLayouts.workspaceId, ctx.workspaceId),
            eq(propertyLayouts.object, object),
            eq(propertyLayouts.leadType, leadType),
          ),
        )
        .for('update');
      // A first save (no version) needs no row yet; any later save names the version it read.
      // Without a version over a saved layout, the caller never saw that layout: a conflict,
      // never an overwrite.
      if (
        expectedVersion === undefined
          ? existing !== undefined
          : existing?.version !== expectedVersion
      ) {
        return { kind: 'version_conflict' };
      }

      const [saved] = await tx
        .insert(propertyLayouts)
        .values({
          workspaceId: ctx.workspaceId,
          object,
          leadType,
          layout,
          version: 1,
          updatedBy: ctx.actorId,
        })
        .onConflictDoUpdate({
          target: [propertyLayouts.workspaceId, propertyLayouts.object, propertyLayouts.leadType],
          set: {
            layout,
            version: sql`${propertyLayouts.version} + 1`,
            updatedBy: ctx.actorId,
            updatedAt: new Date(),
          },
          // A row that appeared since the check only matches the version read; a first save matches none.
          setWhere:
            expectedVersion === undefined
              ? sql`false`
              : eq(propertyLayouts.version, expectedVersion),
        })
        .returning();
      if (!saved) return { kind: 'version_conflict' };
      const row = toLayoutRow(saved);

      await tx.insert(auditEvents).values({
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        actorLabel: AUDIT_ACTOR_LABEL,
        action: 'property_layout.updated',
        entity: 'property_layout',
        entityId: saved.id,
        requestId: ctx.requestId ?? randomUUID(),
        before: existing
          ? { object, leadType, layout: existing.layout, version: existing.version }
          : null,
        after: { object, leadType, layout: row.layout, version: row.version },
      });
      return { kind: 'saved', layout: row };
    });
  }
}
