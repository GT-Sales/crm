import { and, asc, eq, isNull } from 'drizzle-orm';
import { contextWorkspaceId, properties, type TenantTransaction } from '@gt-sales/db';
import {
  buildPropertyCatalog,
  propertyRowSchema,
  type PropertyCatalog,
  type PropertyObject,
  type PropertyRow,
} from '@gt-sales/contracts';

/** A row of app.properties as Drizzle reads it. */
export type PropertyRecord = typeof properties.$inferSelect;

/**
 * The API form of a stored row with whether a plan property is shown on the
 * website (`website_visible`; false for lead properties).
 * TODO(task 2): `PropertyRow` gains `websiteVisible`; this becomes `PropertyRow`.
 */
export type StoredPropertyRow = PropertyRow & { websiteVisible?: boolean };

/** The API form of a stored row; parsing narrows its text columns to their enums. */
export function toPropertyRow(record: PropertyRecord): StoredPropertyRow {
  const row = propertyRowSchema.parse({
    object: record.object,
    key: record.key,
    origin: record.origin,
    label: record.label,
    kind: record.kind,
    options: record.options,
    staffOnly: record.staffOnly,
    sensitive: record.sensitive,
    hidden: record.hidden,
    leadTypes: record.leadTypes,
    position: record.position,
    version: record.version,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
  return { ...row, websiteVisible: record.websiteVisible };
}

/**
 * The site's live property rows of one object (tombstones left out), built-in
 * overrides first, then custom rows by position and key. The site is the
 * transaction's tenant context.
 */
export async function loadPropertyRows(
  tx: TenantTransaction,
  object: PropertyObject,
): Promise<StoredPropertyRow[]> {
  const records = await tx
    .select()
    .from(properties)
    .where(
      and(
        eq(properties.workspaceId, contextWorkspaceId),
        eq(properties.object, object),
        isNull(properties.deletedAt),
      ),
    )
    .orderBy(asc(properties.origin), asc(properties.position), asc(properties.key));
  return records.map(toPropertyRow);
}

/**
 * The site's catalogue of one object: the code catalogue merged with its rows.
 * TODO(task 2): take `options` (`{ plans }`) for the lead catalogue's plan choice.
 */
export async function loadPropertyCatalog(
  tx: TenantTransaction,
  object: PropertyObject = 'lead',
): Promise<PropertyCatalog> {
  return buildPropertyCatalog(await loadPropertyRows(tx, object), object);
}
