import { z } from 'zod';

import { isoDateTimeSchema, requestIdSchema } from './common';
import {
  ORDER_PROPERTY_KEYS,
  PROPERTY_OBJECTS,
  planOptionSchema,
  propertyKeySchema,
  sitePropertySchema,
  type PropertyCatalog,
  type SiteProperty,
} from './properties';

/**
 * Per-site, per-lead-type record layouts (spec §5.3): ordered, named sections
 * of property keys. A layout is a list of keys, never a copy of a definition,
 * so relabelling or hiding a property needs no layout change; keys the layout
 * does not know are resolved against the live catalogue when it is rendered.
 */

export const LAYOUT_MAX_SECTIONS = 20;
export const LAYOUT_MAX_KEYS = 200;

export const layoutSectionSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
    label: z.string().trim().min(1).max(80),
    keys: z.array(propertyKeySchema).max(LAYOUT_MAX_KEYS),
  })
  .strict();
export type LayoutSection = z.infer<typeof layoutSectionSchema>;

export const propertyLayoutSchema = z
  .object({ sections: z.array(layoutSectionSchema).min(1).max(LAYOUT_MAX_SECTIONS) })
  .strict()
  .superRefine((layout, ctx) => {
    const ids = new Set<string>();
    const keys = new Set<string>();
    let total = 0;
    layout.sections.forEach((section, sectionIndex) => {
      if (ids.has(section.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate section id "${section.id}"`,
          path: ['sections', sectionIndex, 'id'],
        });
      }
      ids.add(section.id);
      section.keys.forEach((key, keyIndex) => {
        total += 1;
        if (keys.has(key)) {
          ctx.addIssue({
            code: 'custom',
            message: `property "${key}" is placed more than once`,
            path: ['sections', sectionIndex, 'keys', keyIndex],
          });
        }
        keys.add(key);
      });
    });
    if (total > LAYOUT_MAX_KEYS) {
      ctx.addIssue({
        code: 'custom',
        message: `a layout holds at most ${LAYOUT_MAX_KEYS} properties`,
        path: ['sections'],
      });
    }
  });
export type PropertyLayout = z.infer<typeof propertyLayoutSchema>;

/**
 * A site's layout for one lead type. The default a site has not saved over
 * has `version` 0 and `updatedAt` null; the first save makes version 1.
 */
export const propertyLayoutRowSchema = z.object({
  object: z.enum(PROPERTY_OBJECTS),
  leadType: z.string(),
  layout: propertyLayoutSchema,
  version: z.number().int().min(0),
  updatedAt: isoDateTimeSchema.nullable(),
});
export type PropertyLayoutRow = z.infer<typeof propertyLayoutRowSchema>;

/**
 * `PATCH /properties/layouts/{leadType}`; `expectedVersion` is absent for the
 * first save and required after it (a save without one over a saved layout is
 * 409 `version_conflict`, never an overwrite).
 */
export const savePropertyLayoutRequestSchema = z
  .object({
    layout: propertyLayoutSchema,
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict();
export type SavePropertyLayoutRequest = z.infer<typeof savePropertyLayoutRequestSchema>;

/**
 * The layout a site gets before it saves one: Order (an order type's order
 * properties, `ORDER_PROPERTY_KEYS` in order), Request (built-in, not staff-only), Staff details (built-in,
 * staff-only) and Custom (custom properties of the type). Empty sections are
 * dropped; a type with no properties at all (`contact_message`) gets one empty
 * Request section, since a layout holds at least one section.
 */
export function defaultPropertyLayout(leadType: string, catalog: PropertyCatalog): PropertyLayout {
  const order: string[] = [];
  const request: string[] = [];
  const staff: string[] = [];
  const custom: string[] = [];
  for (const property of catalog.forType(leadType)) {
    if (property.origin === 'custom') custom.push(property.key);
    else if (property.storage === 'order') order.push(property.key);
    else if (property.staffOnly) staff.push(property.key);
    else request.push(property.key);
  }
  const sections: LayoutSection[] = [
    { id: 'order', label: 'Order', keys: order },
    { id: 'request', label: 'Request', keys: request },
    { id: 'staff', label: 'Staff details', keys: staff },
    { id: 'custom', label: 'Custom', keys: custom },
  ].filter((section) => section.keys.length > 0);
  if (sections.length === 0) return { sections: [{ id: 'request', label: 'Request', keys: [] }] };
  return { sections };
}

export interface RenderedSection {
  id: string;
  label: string;
  properties: readonly SiteProperty[];
}

/**
 * Resolves a layout's keys against the catalogue: unknown and hidden keys are
 * skipped; visible properties of the type missing from the layout go in a
 * final "Other" section so nothing a site adds is ever unreachable. A layout
 * saved before order types had order properties (phase 2) places none of
 * them: for such a layout the order properties open the record in an "Order"
 * section, as the default layout has them, rather than trail under "Other".
 * A layout saved in phase 3 places the four it knew (plan, quantity, payment
 * status, carrier commission), so the dispatch and activation details added
 * after it show under "Other" until the site places them.
 */
export function renderPropertyLayout(
  layout: PropertyLayout,
  leadType: string,
  catalog: PropertyCatalog,
): readonly RenderedSection[] {
  const visible = catalog.forType(leadType);
  const byKey = new Map(visible.map((property) => [property.key, property]));
  const placed = new Set<string>();
  const orderKeys: ReadonlySet<string> = new Set(ORDER_PROPERTY_KEYS);
  const placesOrder = layout.sections.some((section) =>
    section.keys.some((key) => orderKeys.has(key)),
  );
  const order = placesOrder
    ? []
    : ORDER_PROPERTY_KEYS.flatMap((key) => {
        const property = byKey.get(key);
        return property && property.storage === 'order' ? [property] : [];
      });
  const rendered: RenderedSection[] = [];
  if (order.length > 0) {
    for (const property of order) placed.add(property.key);
    const taken = new Set(layout.sections.map((section) => section.id));
    rendered.push({
      id: taken.has('order') ? 'order-details' : 'order',
      label: 'Order',
      properties: order,
    });
  }
  for (const section of layout.sections) {
    const properties: SiteProperty[] = [];
    for (const key of section.keys) {
      const property = byKey.get(key);
      if (property && !placed.has(key)) {
        placed.add(key);
        properties.push(property);
      }
    }
    rendered.push({ id: section.id, label: section.label, properties });
  }
  const unplaced = visible.filter((property) => !placed.has(property.key));
  if (unplaced.length > 0) rendered.push({ id: 'other', label: 'Other', properties: unplaced });
  return rendered;
}

/**
 * `?object=` on the five property routes: whose properties and layouts, the
 * lead's (the default) or the plan's. Plans have one layout, keyed `''`
 * (`PATCH /properties/layouts?object=plan`).
 */
export const propertyObjectQuerySchema = z.object({
  object: z.enum(PROPERTY_OBJECTS).default('lead'),
});
export type PropertyObjectQuery = z.infer<typeof propertyObjectQuerySchema>;
export type PropertyObjectQueryInput = z.input<typeof propertyObjectQuerySchema>;

/** `GET /properties`: the site's catalogue (hidden and sensitive included) and every saved layout by lead type. */
export const propertyModelResponseSchema = z.object({
  properties: z.array(sitePropertySchema),
  /**
   * Leads only: the site's plans, each with its lead type, which the order's
   * `plan` property offers (only a type's own on that type's record and
   * filters). Absent for plans.
   */
  plans: z.array(planOptionSchema).optional(),
  layouts: z.record(z.string(), propertyLayoutRowSchema),
  capabilities: z.object({ canManage: z.boolean() }),
  requestId: requestIdSchema,
});
export type PropertyModelResponse = z.infer<typeof propertyModelResponseSchema>;

export const propertyResponseSchema = z.object({
  property: sitePropertySchema,
  requestId: requestIdSchema,
});
export type PropertyResponse = z.infer<typeof propertyResponseSchema>;

export const deletePropertyResponseSchema = z.object({
  key: propertyKeySchema,
  requestId: requestIdSchema,
});
export type DeletePropertyResponse = z.infer<typeof deletePropertyResponseSchema>;

export const propertyLayoutResponseSchema = z.object({
  layout: propertyLayoutRowSchema,
  requestId: requestIdSchema,
});
export type PropertyLayoutResponse = z.infer<typeof propertyLayoutResponseSchema>;
