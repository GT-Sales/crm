import { z } from 'zod';

import { isoDateTimeSchema, requestIdSchema } from './common';
import { isLeadStage } from './lead-types';
import { propertyKeySchema, type PropertyCatalog } from './properties';
import { leadTypeSchema } from './leads';
import {
  leadAssigneeFilterSchema,
  leadPropertyFilterListSchema,
  leadSortSchema,
  leadStageSchema,
  parseLeadSort,
} from './workspace-leads';

/**
 * Private saved views of the leads list (spec §5.4): a named, per-staff-member
 * snapshot of the list's layout, filters, sort and columns. Never the search
 * text and never the page, so opening a view always starts from page one of
 * the current data.
 */

/** The optional table columns, in display order; the admin labels them (`view-preferences.ts`). */
export const LEAD_TABLE_COLUMNS = [
  'type',
  'stage',
  'assignee',
  'nextTask',
  'countdown',
  'source',
  'created',
  'activity',
] as const;
export type LeadTableColumn = (typeof LEAD_TABLE_COLUMNS)[number];

export const savedViewObjectSchema = z.enum(['lead']);
export type SavedViewObject = z.infer<typeof savedViewObjectSchema>;

export const savedViewStateSchema = z
  .object({
    layout: z.enum(['table', 'board']),
    leadType: leadTypeSchema.optional(),
    trash: z.boolean(),
    stage: leadStageSchema.optional(),
    assignee: leadAssigneeFilterSchema.optional(),
    due: z.boolean(),
    where: leadPropertyFilterListSchema,
    sort: leadSortSchema.optional(),
    columns: z.array(propertyKeySchema).max(6),
    hiddenColumns: z.array(z.enum(LEAD_TABLE_COLUMNS)).max(LEAD_TABLE_COLUMNS.length),
  })
  .strict();
export type SavedViewState = z.infer<typeof savedViewStateSchema>;

export const DEFAULT_LEAD_VIEW_STATE: SavedViewState = {
  layout: 'table',
  trash: false,
  due: false,
  where: [],
  columns: [],
  hiddenColumns: [],
};

export const savedViewNameSchema = z.string().trim().min(1).max(60);

/** The most views one staff member keeps per site and object. */
export const SAVED_VIEW_LIMIT = 30;

export const savedViewSchema = z.object({
  id: z.uuid(),
  object: savedViewObjectSchema,
  name: savedViewNameSchema,
  state: savedViewStateSchema,
  version: z.number().int().positive(),
  updatedAt: isoDateTimeSchema,
});
export type SavedView = z.infer<typeof savedViewSchema>;

export const listSavedViewsQuerySchema = z.object({
  object: savedViewObjectSchema.default('lead'),
});
export type ListSavedViewsQuery = z.infer<typeof listSavedViewsQuerySchema>;

export const listSavedViewsResponseSchema = z.object({
  views: z.array(savedViewSchema).max(SAVED_VIEW_LIMIT),
  requestId: requestIdSchema,
});
export type ListSavedViewsResponse = z.infer<typeof listSavedViewsResponseSchema>;

export const createSavedViewRequestSchema = z
  .object({
    object: savedViewObjectSchema.default('lead'),
    name: savedViewNameSchema,
    state: savedViewStateSchema,
  })
  .strict();
export type CreateSavedViewRequest = z.infer<typeof createSavedViewRequestSchema>;
export type CreateSavedViewRequestInput = z.input<typeof createSavedViewRequestSchema>;

export const updateSavedViewRequestSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    name: savedViewNameSchema.optional(),
    state: savedViewStateSchema.optional(),
  })
  .strict()
  .refine((body) => body.name !== undefined || body.state !== undefined, {
    message: 'nothing to change',
  });
export type UpdateSavedViewRequest = z.infer<typeof updateSavedViewRequestSchema>;

export const savedViewResponseSchema = z.object({
  view: savedViewSchema,
  requestId: requestIdSchema,
});
export type SavedViewResponse = z.infer<typeof savedViewResponseSchema>;

export const deleteSavedViewResponseSchema = z.object({
  viewId: z.uuid(),
  requestId: requestIdSchema,
});
export type DeleteSavedViewResponse = z.infer<typeof deleteSavedViewResponseSchema>;

/**
 * A saved view as it can be applied today: drops filters, columns and the sort
 * whose property the catalogue does not know, hides, or marks sensitive (a
 * property may be hidden or deleted after the view was saved), and a stage the
 * view's lead type does not have. Assignee, due, trash and layout are never
 * touched. Pure. The backend stores a view's state cleaned (create and
 * update) and cleans it again on every read; the admin cleans before applying.
 */
export function cleanSavedViewState(
  state: SavedViewState,
  catalog: PropertyCatalog,
): SavedViewState {
  const usable = new Set(catalog.filterable(state.leadType).map((property) => property.key));
  const { sort, stage, ...rest } = state;
  const parsedSort = sort === undefined ? undefined : parseLeadSort(sort);
  const keepSort =
    sort !== undefined &&
    parsedSort !== undefined &&
    (parsedSort.propertyKey === undefined || usable.has(parsedSort.propertyKey));
  const keepStage =
    stage !== undefined && (state.leadType === undefined || isLeadStage(state.leadType, stage));
  return {
    ...rest,
    ...(keepStage ? { stage } : {}),
    ...(keepSort ? { sort } : {}),
    where: state.where.filter((filter) => usable.has(filter.key)),
    columns: state.columns.filter((key) => usable.has(key)),
  };
}
