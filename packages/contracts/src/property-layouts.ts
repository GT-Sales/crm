import { z } from 'zod';

import { isoDateTimeSchema, requestIdSchema } from './common';
import {
  PROPERTY_OBJECTS,
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

/** `PATCH /properties/layouts/{leadType}`; `expectedVersion` is absent for the first save. */
export const savePropertyLayoutRequestSchema = z
  .object({
    layout: propertyLayoutSchema,
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict();
export type SavePropertyLayoutRequest = z.infer<typeof savePropertyLayoutRequestSchema>;

/**
 * The layout a site gets before it saves one: Request (built-in, not
 * staff-only), Staff details (built-in, staff-only) and Custom (custom
 * properties of the type). Empty sections are dropped.
 */
export function defaultPropertyLayout(leadType: string, catalog: PropertyCatalog): PropertyLayout {
  const request: string[] = [];
  const staff: string[] = [];
  const custom: string[] = [];
  for (const property of catalog.forType(leadType)) {
    if (property.origin === 'custom') custom.push(property.key);
    else if (property.staffOnly) staff.push(property.key);
    else request.push(property.key);
  }
  const sections: LayoutSection[] = [
    { id: 'request', label: 'Request', keys: request },
    { id: 'staff', label: 'Staff details', keys: staff },
    { id: 'custom', label: 'Custom', keys: custom },
  ].filter((section) => section.keys.length > 0);
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
 * final "Other" section so nothing a site adds is ever unreachable.
 */
export function renderPropertyLayout(
  layout: PropertyLayout,
  leadType: string,
  catalog: PropertyCatalog,
): readonly RenderedSection[] {
  const visible = catalog.forType(leadType);
  const byKey = new Map(visible.map((property) => [property.key, property]));
  const placed = new Set<string>();
  const rendered: RenderedSection[] = layout.sections.map((section) => {
    const properties: SiteProperty[] = [];
    for (const key of section.keys) {
      const property = byKey.get(key);
      if (property && !placed.has(key)) {
        placed.add(key);
        properties.push(property);
      }
    }
    return { id: section.id, label: section.label, properties };
  });
  const unplaced = visible.filter((property) => !placed.has(property.key));
  if (unplaced.length > 0) rendered.push({ id: 'other', label: 'Other', properties: unplaced });
  return rendered;
}

/** `GET /properties`: the site's catalogue (hidden and sensitive included) and every saved layout by lead type. */
export const propertyModelResponseSchema = z.object({
  properties: z.array(sitePropertySchema),
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
