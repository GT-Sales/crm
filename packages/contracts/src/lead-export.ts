import { z } from 'zod';

import { leadStatusSchema, leadTypeSchema } from './leads';
import { isOrderLeadType, type PropertyCatalog, type SiteProperty } from './properties';
import {
  leadAssigneeFilterSchema,
  leadDueBySchema,
  leadPropertyFilterListSchema,
  leadSearchSchema,
  leadSortSchema,
  leadStageSchema,
  leadViewSchema,
} from './workspace-leads';

/**
 * Export leads to Excel: `POST /workspaces/:id/leads/export`. Caller: a staff
 * session with `lead.export` (the roles that see contact details: owner,
 * Leads, Orders, Finance; or the individual `bulk_export` permission, which an
 * individual deny also takes away). The body names the leads (the ticked ids,
 * or the inbox's own filters, read exactly as `GET /leads` reads them) and
 * the optional fields; the answer is the `.xlsx` file itself.
 *
 * The fields are defined once, here, so the admin's picker and the backend's
 * workbook agree: the admin shows only what `leadExportGroups` lists for the
 * caller's access, and the backend builds its columns from the same lists, so
 * a field the caller may not see is never written whatever the request says.
 */

/** The most leads one export writes; a larger selection is refused whole (`export_too_large`). */
export const LEAD_EXPORT_MAX_ROWS = 5000;
/** The most ticked leads one request names (the body stays under the API's 64 KiB limit). */
export const LEAD_EXPORT_MAX_IDS = 1000;
/** The most optional fields one request names. */
export const LEAD_EXPORT_MAX_FIELDS = 200;
/** Exports one member may start on one site per window. */
export const LEAD_EXPORT_RATE_LIMIT = { maxCount: 10, windowSeconds: 600 } as const;

export const LEAD_EXPORT_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** The response header that carries how many leads the file holds. */
export const LEAD_EXPORT_ROW_COUNT_HEADER = 'X-Export-Row-Count';

/** A fixed field (`updatedAt`) or a catalogue property (`prop.<key>`). */
export const leadExportFieldKeySchema = z
  .string()
  .regex(/^(?:[a-z][A-Za-z]{0,39}|prop\.[a-z][A-Za-z0-9_]{0,63})$/, 'export field key');

/** The inbox's filters, as the list endpoint takes them (`where` as a list, not a JSON string). */
export const leadExportFilterSchema = z
  .object({
    status: leadStatusSchema.optional(),
    type: leadTypeSchema.optional(),
    stage: leadStageSchema.optional(),
    assignee: leadAssigneeFilterSchema.optional(),
    q: leadSearchSchema.optional(),
    view: leadViewSchema.optional(),
    dueBy: leadDueBySchema.optional(),
    where: leadPropertyFilterListSchema.optional(),
    sort: leadSortSchema.optional(),
  })
  .strict();
export type LeadExportFilter = z.infer<typeof leadExportFilterSchema>;

export const leadExportScopeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('ids'),
      ids: z
        .array(z.uuid())
        .min(1)
        .max(LEAD_EXPORT_MAX_IDS)
        .refine((ids) => new Set(ids).size === ids.length, 'duplicate lead id'),
    })
    .strict(),
  z.object({ kind: z.literal('filter'), filter: leadExportFilterSchema }).strict(),
]);
export type LeadExportScope = z.infer<typeof leadExportScopeSchema>;

export const exportLeadsRequestSchema = z
  .object({
    scope: leadExportScopeSchema,
    /** The optional fields to add after the main ones; unknown or disallowed keys are left out. */
    fields: z.array(leadExportFieldKeySchema).max(LEAD_EXPORT_MAX_FIELDS),
  })
  .strict();
export type ExportLeadsRequest = z.infer<typeof exportLeadsRequestSchema>;

export const LEAD_EXPORT_GROUPS = [
  'main',
  'form',
  'custom',
  'order',
  'dates',
  'attribution',
  'tasks',
  'notes',
] as const;
export type LeadExportGroupKey = (typeof LEAD_EXPORT_GROUPS)[number];

const GROUP_LABELS: Record<LeadExportGroupKey, string> = {
  main: 'Main fields',
  form: 'Form answers',
  custom: 'Custom properties',
  order: 'Order details',
  dates: 'Dates',
  attribution: 'Attribution and source',
  tasks: 'Tasks summary',
  notes: 'Notes',
};

export function leadExportGroupLabel(group: LeadExportGroupKey): string {
  return GROUP_LABELS[group];
}

/** How a column's cells are written: text never becomes a number, a date is a real date. */
export type LeadExportValueKind = 'text' | 'number' | 'money' | 'date' | 'dateTime';

/** What a caller needs to be given a field: nothing more, contact details, or money (`revenue.view`). */
export type LeadExportNeed = 'none' | 'contacts' | 'revenue';

export interface LeadExportAccess {
  /** Sees names, emails, phones, forms, custom values and orders (as the lead page decides). */
  readonly contacts: boolean;
  /** Sees money: the frozen plan's commission (`revenue.view`, owner only). */
  readonly revenue: boolean;
}

export interface LeadExportField {
  readonly key: string;
  readonly label: string;
  readonly group: LeadExportGroupKey;
  readonly kind: LeadExportValueKind;
  readonly need: LeadExportNeed;
  /** The site's property behind a `prop.<key>` field, as the lead type resolves it. */
  readonly property?: SiteProperty;
}

export interface LeadExportGroup {
  readonly key: LeadExportGroupKey;
  readonly label: string;
  readonly fields: readonly LeadExportField[];
}

type FixedField = Omit<LeadExportField, 'property'> & {
  /** Only leads of an order type have one. */
  readonly orderOnly?: boolean;
};

const fixed = (
  group: LeadExportGroupKey,
  key: string,
  label: string,
  kind: LeadExportValueKind,
  need: LeadExportNeed,
  orderOnly = false,
): FixedField => ({ key, label, group, kind, need, ...(orderOnly ? { orderOnly } : {}) });

/**
 * The fields that are not catalogue properties, in sheet order. Timestamps
 * are UTC, as the API's own (`…Z`), and say so in their header: a workbook
 * has no time zone of its own.
 */
const MAIN_BEFORE_PLAN: readonly FixedField[] = [
  // The lead's `externalRef`: a SIM order's `MS-<n>`, a website's own reference.
  fixed('main', 'reference', 'Order / lead number', 'text', 'none'),
  fixed('main', 'createdAt', 'Created (UTC)', 'dateTime', 'none'),
  fixed('main', 'leadType', 'Lead type', 'text', 'none'),
  fixed('main', 'fullName', 'Name', 'text', 'contacts'),
  fixed('main', 'email', 'Email', 'text', 'contacts'),
  fixed('main', 'phone', 'Phone', 'text', 'contacts'),
  fixed('main', 'stage', 'Stage', 'text', 'none'),
  fixed('main', 'status', 'Status', 'text', 'none'),
  fixed('main', 'assignee', 'Assigned to', 'text', 'none'),
];

/** The two order properties every export of an order type carries, after the fields above. */
const MAIN_ORDER_PROPERTIES = ['plan', 'paymentStatus'] as const;

const ORDER_EXTRAS: readonly FixedField[] = [
  fixed('order', 'planPrice', 'Plan price (CAD)', 'money', 'contacts', true),
  fixed('order', 'planBillingPeriod', 'Billing period', 'text', 'contacts', true),
  fixed('order', 'planCommission', 'Commission (CAD)', 'money', 'revenue', true),
];

const DATE_FIELDS: readonly FixedField[] = [
  fixed('dates', 'updatedAt', 'Updated (UTC)', 'dateTime', 'none'),
  fixed('dates', 'stageChangedAt', 'Stage changed (UTC)', 'dateTime', 'contacts'),
  fixed('dates', 'lastActivityAt', 'Last activity (UTC)', 'dateTime', 'contacts'),
  fixed('dates', 'archivedAt', 'Archived (UTC)', 'dateTime', 'none'),
];

const ATTRIBUTION_FIELDS: readonly FixedField[] = [
  fixed('attribution', 'source', 'Source', 'text', 'none'),
  fixed('attribution', 'utmSource', 'UTM source', 'text', 'none'),
  fixed('attribution', 'utmMedium', 'UTM medium', 'text', 'none'),
  fixed('attribution', 'utmCampaign', 'UTM campaign', 'text', 'none'),
  fixed('attribution', 'utmTerm', 'UTM term', 'text', 'none'),
  fixed('attribution', 'utmContent', 'UTM content', 'text', 'none'),
  fixed('attribution', 'referrerHost', 'Referrer', 'text', 'none'),
  fixed('attribution', 'landingPath', 'Landing page', 'text', 'none'),
  fixed('attribution', 'partnerCode', 'Partner code', 'text', 'none'),
];

const TASK_FIELDS: readonly FixedField[] = [
  fixed('tasks', 'openTaskCount', 'Open tasks', 'number', 'none'),
  fixed('tasks', 'nextTaskDueAt', 'Next task due', 'date', 'none'),
];

const NOTE_FIELDS: readonly FixedField[] = [
  fixed('notes', 'noteCount', 'Notes', 'number', 'contacts'),
];

const allowed = (need: LeadExportNeed, access: LeadExportAccess): boolean =>
  need === 'none' || (need === 'contacts' ? access.contacts : access.contacts && access.revenue);

/** The `prop.<key>` field key of a catalogue property. */
export function leadExportPropertyField(propertyKey: string): string {
  return `prop.${propertyKey}`;
}

function kindOf(property: SiteProperty): LeadExportValueKind {
  switch (property.kind) {
    case 'number':
    case 'count':
      return 'number';
    case 'money':
      return 'money';
    case 'date':
      return 'date';
    case 'dateTime':
      return 'dateTime';
    // A phone, a postal code, a tracking number, a choice's label, yes or no: text.
    default:
      return 'text';
  }
}

function propertyField(property: SiteProperty, group: LeadExportGroupKey): LeadExportField {
  return {
    key: leadExportPropertyField(property.key),
    label: property.label,
    group,
    kind: kindOf(property),
    // Forms, custom values and orders travel with contact visibility, as on the lead page.
    need: 'contacts',
    property,
  };
}

/**
 * Every field one lead type's sheet may carry for this caller, in sheet
 * order: the main fields, then the form's answers, the site's custom
 * properties, the order details, dates, attribution, tasks and notes. Hidden
 * properties are left out, and a sensitive one (a date of birth; a sealed
 * identity number is not a property at all) is never exportable.
 */
export function leadExportFields(input: {
  catalog: PropertyCatalog;
  leadType: string;
  access: LeadExportAccess;
}): LeadExportField[] {
  const { catalog, leadType, access } = input;
  const isOrder = isOrderLeadType(leadType);
  const properties = catalog.forType(leadType).filter((property) => !property.sensitive);
  const mainOrder = isOrder
    ? MAIN_ORDER_PROPERTIES.flatMap((key) => {
        const property = properties.find((entry) => entry.key === key && entry.storage === 'order');
        return property ? [propertyField(property, 'main')] : [];
      })
    : [];
  const isMainOrder = (property: SiteProperty) =>
    property.storage === 'order' && MAIN_ORDER_PROPERTIES.some((key) => key === property.key);
  const fields: LeadExportField[] = [
    ...MAIN_BEFORE_PLAN,
    ...mainOrder,
    ...properties
      .filter((property) => property.storage === 'form')
      .map((property) => propertyField(property, 'form')),
    ...properties
      .filter((property) => property.storage === 'custom')
      .map((property) => propertyField(property, 'custom')),
    ...properties
      .filter((property) => property.storage === 'order' && !isMainOrder(property))
      .map((property) => propertyField(property, 'order')),
    ...ORDER_EXTRAS.filter(() => isOrder),
    ...DATE_FIELDS,
    ...ATTRIBUTION_FIELDS,
    ...TASK_FIELDS,
    ...NOTE_FIELDS,
  ];
  return fields.filter((field) => allowed(field.need, access));
}

/**
 * The picker's groups over several lead types (one, on a type's tab; every
 * type the site holds, on "All leads"): each field once, in the order the
 * first type that has it lists it.
 */
export function leadExportGroups(input: {
  catalog: PropertyCatalog;
  leadTypes: readonly string[];
  access: LeadExportAccess;
}): LeadExportGroup[] {
  const byGroup = new Map<LeadExportGroupKey, LeadExportField[]>(
    LEAD_EXPORT_GROUPS.map((key) => [key, []]),
  );
  const seen = new Set<string>();
  for (const leadType of input.leadTypes) {
    for (const field of leadExportFields({ ...input, leadType })) {
      if (seen.has(field.key)) continue;
      seen.add(field.key);
      byGroup.get(field.group)?.push(field);
    }
  }
  return LEAD_EXPORT_GROUPS.flatMap((key) => {
    const fields = byGroup.get(key) ?? [];
    return fields.length === 0 ? [] : [{ key, label: GROUP_LABELS[key], fields }];
  });
}

/**
 * One sheet's columns: the main fields always, then the requested ones the
 * lead type has and the caller may see, in sheet order. A key that names
 * nothing (a deleted property) or something the caller may not see is left
 * out, never an error.
 */
export function leadExportColumns(input: {
  catalog: PropertyCatalog;
  leadType: string;
  access: LeadExportAccess;
  fields: readonly string[];
}): LeadExportField[] {
  const requested = new Set(input.fields);
  return leadExportFields(input).filter(
    (field) => field.group === 'main' || requested.has(field.key),
  );
}

/** `Get Canada Sim` → `get-canada-sim`; only letters, digits and hyphens survive. */
function fileNamePart(value: string, fallback: string): string {
  const part = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return part === '' ? fallback : part;
}

/**
 * `<site>-leads-<lead type>-YYYY-MM-DD.xlsx`: the site's slug, the one lead
 * type the file holds (`all` when it spans several) and the day it was made.
 * Only `[a-z0-9-]`, so it is safe in a `Content-Disposition` header as it is.
 */
export function leadExportFileName(input: {
  siteSlug: string;
  leadType: string | undefined;
  day: string;
}): string {
  const type = input.leadType === undefined ? 'all' : fileNamePart(input.leadType, 'all');
  const day = /^\d{4}-\d{2}-\d{2}$/.test(input.day) ? input.day : 'undated';
  return `${fileNamePart(input.siteSlug, 'site')}-leads-${type}-${day}.xlsx`;
}
