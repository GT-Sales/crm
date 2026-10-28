import { z } from 'zod';

import { isoDateTimeSchema, pageInfoSchema, requestIdSchema } from './common';
import { isCalendarDate } from './lead-fields';
import {
  LEAD_PROPERTY_OPERATORS,
  filterableLeadProperties,
  leadPropertyOperators,
} from './lead-properties';
import {
  attributionSchema,
  leadContactSchema,
  leadExternalRefSchema,
  leadStatusSchema,
  leadTypeSchema,
} from './leads';

/**
 * Staff lead visibility — `GET /workspaces/:id/leads` and the board. Caller:
 * staff session with `workspace.read` (every role); contact details are
 * included only for roles that work leads or money, and only those roles may
 * search, filter by properties, sort by name or a property, or request property
 * columns, since those reveal contact or form details. Leads are created and updated by the website
 * flow in `leads.ts`; staff work them through `lead-work.ts`.
 */

/** A working stage key (`new`, `contacted`, `won`…); the type's catalogue entry lists the valid ones. */
export const leadStageSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/, 'lower_snake_case stage');
export type LeadStage = z.infer<typeof leadStageSchema>;

/** `me`, `none` (unassigned) or one member's actor id. */
export const leadAssigneeFilterSchema = z.union([z.enum(['me', 'none']), z.uuid()]);
export type LeadAssigneeFilter = z.infer<typeof leadAssigneeFilterSchema>;

/** Active leads, or the soft-deleted ones (the trash). */
export const leadViewSchema = z.enum(['active', 'trash']);
export type LeadView = z.infer<typeof leadViewSchema>;

/** Free-text search over name, email, phone and external reference. */
export const leadSearchSchema = z.string().trim().min(1).max(100);

/**
 * A calendar day, `YYYY-MM-DD`, by which a follow-up counts as due: the
 * viewer's own today, sent by the admin, since task due dates are calendar
 * days (stored at noon UTC) and "today" depends on where staff are.
 */
export const leadDueBySchema = z.iso.date();

const propertyKeySchema = z.string().regex(/^[a-z][A-Za-z0-9]{0,63}$/, 'a property key');

export const leadPropertyFilterValueSchema = z.union([
  z.string().max(200),
  z.number().int().min(0).max(10_000),
  z.boolean(),
  z.array(z.string().min(1).max(200)).min(1).max(20),
]);
export type LeadPropertyFilterValue = z.infer<typeof leadPropertyFilterValueSchema>;

export const leadPropertyFilterSchema = z
  .object({
    key: propertyKeySchema,
    op: z.enum(LEAD_PROPERTY_OPERATORS),
    value: leadPropertyFilterValueSchema.optional(),
  })
  .strict()
  .superRefine((filter, ctx) => {
    if (filter.op === 'empty' || filter.op === 'notEmpty') {
      if (filter.value !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: `${filter.op} does not take a value`,
          path: ['value'],
        });
      }
      return;
    }
    if (filter.value === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `${filter.op} requires a value`,
        path: ['value'],
      });
      return;
    }
    if (filter.op === 'in') {
      if (!Array.isArray(filter.value)) {
        ctx.addIssue({
          code: 'custom',
          message: 'in requires an array of 1 to 20 values',
          path: ['value'],
        });
      }
      return;
    }
    if (Array.isArray(filter.value)) {
      ctx.addIssue({
        code: 'custom',
        message: `${filter.op} does not accept an array value`,
        path: ['value'],
      });
    }
  });
export type LeadPropertyFilter = z.infer<typeof leadPropertyFilterSchema>;

export const leadPropertyFilterListSchema = z.array(leadPropertyFilterSchema).max(10);

export const leadWhereSchema = z
  .string()
  .max(2000)
  .transform((raw, ctx): unknown => {
    try {
      return JSON.parse(raw);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'invalid JSON filter list' });
      return z.NEVER;
    }
  })
  .pipe(leadPropertyFilterListSchema);

export const LEAD_SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type LeadSortDirection = (typeof LEAD_SORT_DIRECTIONS)[number];

export const LEAD_BUILTIN_SORT_FIELDS = [
  'createdAt',
  'updatedAt',
  'fullName',
  'externalRef',
] as const;
export type LeadBuiltinSortField = (typeof LEAD_BUILTIN_SORT_FIELDS)[number];
export type LeadSortField = LeadBuiltinSortField | `prop.${string}`;

export const leadSortSchema = z
  .string()
  .regex(
    /^(?:createdAt|updatedAt|fullName|externalRef|prop\.[a-z][A-Za-z0-9]{0,63}):(?:asc|desc)$/,
    'sort must be <field>:<asc|desc>',
  );
export type LeadSort = z.infer<typeof leadSortSchema>;

export interface ParsedLeadSort {
  readonly field: LeadSortField;
  readonly propertyKey?: string;
  readonly direction: LeadSortDirection;
}

export function parseLeadSort(sort: string): ParsedLeadSort | undefined {
  const checked = leadSortSchema.safeParse(sort);
  if (!checked.success) return undefined;
  const colon = checked.data.lastIndexOf(':');
  const fieldPart = checked.data.slice(0, colon);
  const dirPart = checked.data.slice(colon + 1);
  const direction: LeadSortDirection = dirPart === 'asc' ? 'asc' : 'desc';
  if (
    fieldPart === 'createdAt' ||
    fieldPart === 'updatedAt' ||
    fieldPart === 'fullName' ||
    fieldPart === 'externalRef'
  ) {
    return { field: fieldPart, direction };
  }
  if (fieldPart.startsWith('prop.')) {
    const propertyKey = fieldPart.slice('prop.'.length);
    return { field: `prop.${propertyKey}`, propertyKey, direction };
  }
  return undefined;
}

export const leadColumnsListSchema = z.array(propertyKeySchema).min(1).max(6);

export const leadColumnsSchema = z
  .string()
  .min(1)
  .max(400)
  .transform((raw) => raw.split(','))
  .pipe(leadColumnsListSchema)
  .transform((keys) => [...new Set(keys)]);

/**
 * Checks one parsed filter against the shared property catalogue (and the
 * given lead type, when present).
 */
export function isValidLeadPropertyFilter(filter: LeadPropertyFilter, leadType?: string): boolean {
  const property = filterableLeadProperties(leadType).find((entry) => entry.key === filter.key);
  if (!property) return false;
  if (!leadPropertyOperators(property.kind).includes(filter.op)) return false;

  if (filter.op === 'empty' || filter.op === 'notEmpty') {
    return filter.value === undefined;
  }

  const value = filter.value;
  if (value === undefined) return false;

  switch (property.kind) {
    case 'text':
    case 'longText':
      return typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
    case 'choice': {
      const allowed =
        leadType !== undefined && property.options
          ? new Set(property.options.map((option) => option.value))
          : undefined;
      if (filter.op === 'eq') {
        if (typeof value !== 'string' || value.length === 0 || value.length > 200) return false;
        return allowed ? allowed.has(value) : true;
      }
      if (filter.op === 'in') {
        if (!Array.isArray(value) || value.length === 0 || value.length > 20) return false;
        return value.every(
          (item) =>
            typeof item === 'string' &&
            item.length > 0 &&
            item.length <= 200 &&
            (allowed ? allowed.has(item) : true),
        );
      }
      return false;
    }
    case 'date':
      return typeof value === 'string' && isCalendarDate(value);
    case 'dateTime':
      return typeof value === 'string' && z.iso.datetime().safeParse(value).success;
    case 'count':
      return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10_000;
    case 'yesNo':
      return typeof value === 'boolean';
  }
}

export function areValidLeadPropertyFilters(
  filters: readonly LeadPropertyFilter[],
  leadType?: string,
): boolean {
  return filters.every((filter) => isValidLeadPropertyFilter(filter, leadType));
}

export function isValidLeadSort(sort: string, leadType?: string): boolean {
  const parsed = parseLeadSort(sort);
  if (!parsed) return false;
  if (parsed.propertyKey === undefined) return true;
  return filterableLeadProperties(leadType).some((entry) => entry.key === parsed.propertyKey);
}

export function areValidLeadColumns(columns: readonly string[], leadType?: string): boolean {
  if (columns.length > 6) return false;
  const allowed = new Set(filterableLeadProperties(leadType).map((entry) => entry.key));
  return columns.every((key) => allowed.has(key));
}

export const listWorkspaceLeadsQuerySchema = z.object({
  status: leadStatusSchema.optional(),
  type: leadTypeSchema.optional(),
  stage: leadStageSchema.optional(),
  assignee: leadAssigneeFilterSchema.optional(),
  q: leadSearchSchema.optional(),
  view: leadViewSchema.optional(),
  /** Only leads with an open task due on or before this day (a follow-up due), most overdue first. */
  dueBy: leadDueBySchema.optional(),
  /** JSON-encoded array of up to 10 property filters combined with AND. */
  where: leadWhereSchema.optional(),
  /** Sort order: `<field>:<asc|desc>` where field is `createdAt`, `updatedAt`, `fullName`, `externalRef`, or `prop.<key>`. */
  sort: leadSortSchema.optional(),
  /** Comma-separated property keys to include in each row's `properties` map (at most 6). */
  columns: leadColumnsSchema.optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(200).optional(),
});
export type ListWorkspaceLeadsQuery = z.infer<typeof listWorkspaceLeadsQuerySchema>;
export type ListWorkspaceLeadsQueryInput = Omit<ListWorkspaceLeadsQuery, 'where' | 'columns'> & {
  where?: string | readonly LeadPropertyFilter[];
  columns?: string | readonly string[];
};

/**
 * What the caller may do with this workspace's leads, so the admin shows only
 * the controls that will work: `contacts` — see names, emails, phones, form
 * details, notes and tasks (and search); `manage` — change stage, assignee and
 * contact details, write notes and tasks, move to the trash.
 */
export const leadAccessSchema = z.object({
  contacts: z.boolean(),
  manage: z.boolean(),
  /** May open a sealed identity number (a SIN): owners only. Absent means no. */
  revealSensitive: z.boolean().optional(),
  /** May email the lead's customer (works leads, and the site can send mail). Absent means no. */
  emailCustomer: z.boolean().optional(),
  /** May view and download the lead's documents (`document.download`). Absent means no. */
  downloadDocuments: z.boolean().optional(),
});
export type LeadAccess = z.infer<typeof leadAccessSchema>;

export const leadPropertyValueSchema = z.union([z.string(), z.number(), z.boolean()]);
export type LeadPropertyValue = z.infer<typeof leadPropertyValueSchema>;

/**
 * One row of the admin leads list. `source` is a short human-readable label
 * derived from `attribution` (e.g. `utm:google/cpc`, `referrer:facebook.com`,
 * `partner:MAPLE10` or `direct`) so the list has a source column without every
 * consumer re-deriving it from the raw attribution fields. `openTaskCount` and
 * `nextTaskDueAt` summarise the lead's open tasks (a count and a date, never a
 * task's text, so every role may see them).
 */
export const leadListItemSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  leadType: leadTypeSchema,
  status: leadStatusSchema,
  stage: leadStageSchema,
  contact: leadContactSchema,
  contactId: z.uuid().nullable(),
  assignedActorId: z.uuid().nullable(),
  externalRef: leadExternalRefSchema.nullable(),
  source: z.string().min(1).max(160),
  attribution: attributionSchema,
  consentVersion: z.string().max(64).nullable(),
  openTaskCount: z.int().nonnegative(),
  nextTaskDueAt: isoDateTimeSchema.nullable(),
  /** No one who works leads has opened it yet: the "New" badge. Absent means no. */
  isNew: z.boolean().optional(),
  /**
   * The type's countdown date from the form (a SIM order's arrival in
   * Canada, `leadCountdownField`), for "6 days left" on lists. Form details:
   * only for roles that see contacts, like the contact fields.
   */
  countdownDate: z.iso.date().nullable().optional(),
  /** Requested optional property column values; only for callers with contact access. */
  properties: z.record(z.string(), leadPropertyValueSchema).optional(),
  deletedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type LeadListItem = z.infer<typeof leadListItemSchema>;

export const listWorkspaceLeadsResponseSchema = z.object({
  leads: z.array(leadListItemSchema),
  page: pageInfoSchema,
  access: leadAccessSchema,
  requestId: requestIdSchema,
});
export type ListWorkspaceLeadsResponse = z.infer<typeof listWorkspaceLeadsResponseSchema>;

/**
 * The board — `GET /workspaces/:id/leads/board?type=…`: one type's active
 * leads by stage, a column per catalogue stage in order (plus a trailing
 * column for any stored stage the catalogue no longer lists, so no lead
 * disappears from the board). Each column carries its full count and its
 * newest `perStage` leads.
 */
export const leadBoardQuerySchema = z.object({
  type: leadTypeSchema,
  assignee: leadAssigneeFilterSchema.optional(),
  q: leadSearchSchema.optional(),
  /** JSON-encoded array of up to 10 property filters combined with AND. */
  where: leadWhereSchema.optional(),
  perStage: z.coerce.number().int().positive().max(100).optional(),
});
export type LeadBoardQuery = z.infer<typeof leadBoardQuerySchema>;
export type LeadBoardQueryInput = Omit<LeadBoardQuery, 'where'> & {
  where?: string | readonly LeadPropertyFilter[];
};

export const leadBoardColumnSchema = z.object({
  stage: leadStageSchema,
  total: z.int().nonnegative(),
  leads: z.array(leadListItemSchema),
});
export type LeadBoardColumn = z.infer<typeof leadBoardColumnSchema>;

export const leadBoardResponseSchema = z.object({
  leadType: leadTypeSchema,
  columns: z.array(leadBoardColumnSchema),
  access: leadAccessSchema,
  requestId: requestIdSchema,
});
export type LeadBoardResponse = z.infer<typeof leadBoardResponseSchema>;

/**
 * Lead counts for the inbox's type tabs — `GET /workspaces/:id/leads/summary`.
 * Only types with at least one active lead appear; `trash` counts the
 * soft-deleted ones.
 */
export const leadTypeCountSchema = z.object({
  leadType: leadTypeSchema,
  total: z.int().nonnegative(),
  /** Active leads of the type no one who works leads has opened yet. */
  unopened: z.int().nonnegative().optional(),
  /** With the summary's `dueBy`: active leads of the type with an open task due by then. */
  followUpsDue: z.int().nonnegative().optional(),
});
export type LeadTypeCount = z.infer<typeof leadTypeCountSchema>;

export const leadsSummaryQuerySchema = z.object({
  /** Also count each type's leads with a follow-up due on or before this day. */
  dueBy: leadDueBySchema.optional(),
});
export type LeadsSummaryQuery = z.infer<typeof leadsSummaryQuerySchema>;

export const leadsSummaryResponseSchema = z.object({
  types: z.array(leadTypeCountSchema),
  trash: z.int().nonnegative(),
  access: leadAccessSchema,
  requestId: requestIdSchema,
});
export type LeadsSummaryResponse = z.infer<typeof leadsSummaryResponseSchema>;

/** The dashboard's windows, in days back from now (Get Canada Sim's 7 days, 30 days, 3 months). */
export const LEAD_STATS_WINDOWS = [7, 30, 90] as const;

/** `GET /workspaces/:id/leads/stats`: one type's leads in a window; no window is all time. */
export const leadStatsQuerySchema = z
  .object({
    leadType: leadTypeSchema,
    days: z.coerce
      .number()
      .pipe(z.literal([...LEAD_STATS_WINDOWS]))
      .optional(),
  })
  .strict();
export type LeadStatsQuery = z.infer<typeof leadStatsQuerySchema>;

/**
 * Counts only, so every role may read them (as the summary): the type's
 * active leads received in the window by stage, per day (UTC) and by partner
 * code, the type's lost stages left out of those two as Get Canada Sim's
 * dashboard leaves out cancellations. A partner is named by its partner
 * application's company when the site has one under that code.
 */
export const leadStatsResponseSchema = z.object({
  leadType: leadTypeSchema,
  days: z.int().positive().nullable(),
  total: z.int().nonnegative(),
  stages: z.array(z.object({ stage: leadStageSchema, total: z.int().nonnegative() })),
  daily: z.array(z.object({ day: z.iso.date(), total: z.int().nonnegative() })),
  partners: z
    .array(
      z.object({
        code: z.string().min(1).max(64),
        name: z.string().min(1).max(200).nullable(),
        total: z.int().nonnegative(),
      }),
    )
    .max(10),
  requestId: requestIdSchema,
});
export type LeadStatsResponse = z.infer<typeof leadStatsResponseSchema>;
