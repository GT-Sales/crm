import { sql, type SQL } from 'drizzle-orm';
import {
  DEFAULT_LEAD_ORDER,
  normalizeLeadView,
  parseLeadSort,
  type LeadAssigneeFilter,
  type LeadPropertyFilter,
  type PropertyCatalog,
  type SiteProperty,
  type LeadStatus,
  type LeadView,
} from '@gt-sales/contracts';
import { orderLeadTypes } from '@gt-sales/types';
import { z } from 'zod';

/**
 * The WHERE and ORDER BY of the staff lead reads, as SQL on lead `l`: the
 * list's filters (type, stage, assignee, search, follow-ups due), a property
 * filter per storage and kind, and the sort. Every value is bound; the
 * automations evaluate a flow's property conditions through
 * `propertyFilterCondition` too.
 */

const calendarDaySchema = z.iso.date();

export function calendarDay(value: unknown): string | null {
  const parsed = calendarDaySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The first instant after the calendar day `day` (midnight UTC that ends
 * it): a task is due by `day` when its `due_at`, a calendar day stored at
 * noon UTC, falls before this. A validated literal, so a statement that
 * otherwise binds nothing stays at one round trip.
 */
export function dueCutoff(day: string): SQL {
  if (!calendarDaySchema.safeParse(day).success) throw new Error('dueBy must be YYYY-MM-DD');
  return sql.raw(`(('${day}'::date + 1)::timestamp at time zone 'UTC')`);
}

/** `%term%` for ILIKE, with the term's own wildcards escaped. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

export interface LeadFilters {
  workspaceId: string;
  actorId: string;
  status?: LeadStatus;
  leadType?: string;
  stage?: string;
  assignee?: LeadAssigneeFilter;
  search?: string;
  view?: LeadView;
  /** Only leads with an open task due on or before this calendar day. */
  dueBy?: string;
  /** Only leads nobody who works leads has opened yet (the inbox's "New" badge). */
  unopenedOnly?: boolean;
  /** Validated property filters combined with AND. */
  where?: readonly LeadPropertyFilter[];
  /** Validated sort string (`<field>:<asc|desc>`). */
  sort?: string;
  /** Validated property column keys (at most 6). */
  columns?: readonly string[];
  /** The site's property catalogue `where`, `sort` and `columns` were validated against. */
  catalog: PropertyCatalog;
}

/**
 * The property a filter or sort names, as the site's catalogue resolves it
 * for the list's type (visible, not sensitive), with the kind it is filtered
 * by there (`text` when a built-in's kind differs across types).
 */
export function resolvePropertyFor(
  catalog: PropertyCatalog,
  key: string,
  leadType: string | undefined,
): SiteProperty | undefined {
  const filterable = catalog.filterable(leadType).find((entry) => entry.key === key);
  const property = catalog.get(key);
  if (!filterable || !property) return undefined;
  return { ...property, kind: filterable.kind };
}

/**
 * A custom value as its kind reads it, or null when there is none or the
 * stored value does not fit the kind (a number where text belongs, a string
 * where a number does): so a malformed value matches no condition and sorts
 * last. `v` is the value as text, `j` as JSON.
 */
function customTyped(kind: SiteProperty['kind'], v: SQL, j: SQL): SQL {
  switch (kind) {
    case 'number':
    case 'money':
    case 'count':
      return sql`(case when jsonb_typeof(${j}) = 'number' then (${v})::numeric end)`;
    case 'yesNo':
      return sql`(case when jsonb_typeof(${j}) = 'boolean' then (${v})::boolean end)`;
    case 'date':
      return sql`(case when jsonb_typeof(${j}) = 'string' and ${v} ~ '^\\d{4}-\\d{2}-\\d{2}$' then ${v} end)`;
    case 'text':
    case 'longText':
    case 'choice':
    case 'email':
    case 'phone':
    case 'url':
    case 'dateTime':
      return sql`(case when jsonb_typeof(${j}) = 'string' then ${v} end)`;
  }
}

/** The order lead types, bound one value each, for the order storage's guard. */
const ORDER_LEAD_TYPES = sql.join(
  orderLeadTypes.map((leadType) => sql`${leadType}`),
  sql`, `,
);

/** Each order field's default (`DEFAULT_LEAD_ORDER`) as JSON text, for a lead whose order lacks it. */
const ORDER_DEFAULTS: ReadonlyMap<string, string> = new Map(
  Object.entries(DEFAULT_LEAD_ORDER).map(([key, value]) => [key, JSON.stringify(value)]),
);

/**
 * A property stored in a JSON column, as JSON (`j`) and as text (`v`):
 * `l.custom_values` for a custom property, `l.order_details` for an order one,
 * each under the key the property is stored as (`storageKey ?? key`, bound).
 * An order field a lead of an order type lacks reads as its default, as the
 * lead page shows it; a lead of any other type has no order, so every order
 * field is SQL null there. A null matches `empty`, so that condition is
 * limited to the order types too (`jsonFilterCondition`): a lead of another
 * type matches no order condition, in a list of one type or across types.
 */
function jsonStoredValue(property: SiteProperty): { v: SQL; j: SQL } {
  const key = property.storageKey ?? property.key;
  if (property.storage === 'order') {
    const fallback = ORDER_DEFAULTS.get(key) ?? 'null';
    const j = sql`(case when l.lead_type in (${ORDER_LEAD_TYPES}) then coalesce(l.order_details -> ${key}, ${fallback}::jsonb) end)`;
    return { j, v: sql`(${j} #>> '{}')` };
  }
  return { v: sql`(l.custom_values ->> ${key})`, j: sql`(l.custom_values -> ${key})` };
}

/**
 * A built-in property's form value as its kind reads it. Text and choice
 * kinds read whatever the form holds as text; a number, yes/no, date or date
 * and time that is malformed is null, so it matches no condition and sorts
 * last. `v` is the value as text, `j` as JSON.
 */
function formTyped(kind: SiteProperty['kind'], v: SQL, j: SQL): SQL {
  switch (kind) {
    case 'number':
    case 'money':
    case 'count':
      return sql`(case when jsonb_typeof(${j}) = 'number' then (${v})::numeric end)`;
    case 'yesNo':
      return sql`(case when jsonb_typeof(${j}) = 'boolean' then (${v})::boolean end)`;
    case 'date':
      return sql`(case when ${v} ~ '^\\d{4}-\\d{2}-\\d{2}$' then ${v} end)`;
    case 'dateTime':
      return sql`(case when ${v} ~ '^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])T([01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(\\.\\d+)?(Z|[+-]([01]\\d|2[0-3]):[0-5]\\d)$' then (${v})::timestamptz end)`;
    case 'text':
    case 'longText':
    case 'choice':
    case 'email':
    case 'phone':
    case 'url':
      return v;
  }
}

/**
 * A filter's comparison (every operator but `empty` and `notEmpty`) over
 * `typed`, the value as the property's kind reads it. An operator or a value
 * the kind does not take matches nothing.
 */
function kindCondition(filter: LeadPropertyFilter, kind: SiteProperty['kind'], typed: SQL): SQL {
  switch (kind) {
    case 'text':
    case 'longText':
    case 'email':
    case 'phone':
    case 'url': {
      if (typeof filter.value !== 'string') return sql`false`;
      if (filter.op === 'eq') return sql`lower(btrim(${typed})) = lower(btrim(${filter.value}))`;
      if (filter.op === 'contains') return sql`${typed} ilike ${likePattern(filter.value)}`;
      return sql`false`;
    }
    case 'choice': {
      if (filter.op === 'eq' && typeof filter.value === 'string') {
        return sql`${typed} = ${filter.value}`;
      }
      if (filter.op === 'in' && Array.isArray(filter.value) && filter.value.length > 0) {
        return sql`${typed} in (${sql.join(
          filter.value.map((item) => sql`${item}`),
          sql`, `,
        )})`;
      }
      return sql`false`;
    }
    case 'date': {
      if (typeof filter.value !== 'string') return sql`false`;
      if (filter.op === 'eq') return sql`${typed} = ${filter.value}`;
      if (filter.op === 'lte') return sql`${typed} <= ${filter.value}`;
      if (filter.op === 'gte') return sql`${typed} >= ${filter.value}`;
      return sql`false`;
    }
    case 'dateTime': {
      if (typeof filter.value !== 'string') return sql`false`;
      if (filter.op === 'lte') return sql`${typed} <= ${filter.value}::timestamptz`;
      if (filter.op === 'gte') return sql`${typed} >= ${filter.value}::timestamptz`;
      return sql`false`;
    }
    case 'number':
    case 'money':
    case 'count': {
      if (typeof filter.value !== 'number') return sql`false`;
      if (filter.op === 'eq') return sql`${typed} = ${filter.value}`;
      if (filter.op === 'lte') return sql`${typed} <= ${filter.value}`;
      if (filter.op === 'gte') return sql`${typed} >= ${filter.value}`;
      return sql`false`;
    }
    case 'yesNo': {
      if (typeof filter.value !== 'boolean') return sql`false`;
      if (filter.op === 'eq') return sql`${typed} = ${filter.value}`;
      return sql`false`;
    }
  }
}

/** A JSON-stored property's condition (custom and order storage alike) over the kind-checked value. */
function jsonFilterCondition(filter: LeadPropertyFilter, property: SiteProperty): SQL {
  const { v, j } = jsonStoredValue(property);
  const typed = customTyped(property.kind, v, j);
  const isText =
    property.kind !== 'number' &&
    property.kind !== 'money' &&
    property.kind !== 'count' &&
    property.kind !== 'yesNo';

  if (filter.op === 'empty') {
    // No value at all, or a blank text; a malformed value is not empty either.
    const empty = sql`(${j} is null or ${j} = 'null'::jsonb or (jsonb_typeof(${j}) = 'string' and btrim(${v}) = ''))`;
    // A lead of a type with no order is not an order with an empty field.
    return property.storage === 'order'
      ? sql`(l.lead_type in (${ORDER_LEAD_TYPES}) and ${empty})`
      : empty;
  }
  if (filter.op === 'notEmpty') {
    return isText ? sql`coalesce(btrim(${typed}), '') <> ''` : sql`${typed} is not null`;
  }
  // Neither a custom nor an order kind: no JSON-stored property is a date and time.
  if (property.kind === 'dateTime') return sql`false`;
  return kindCondition(filter, property.kind, typed);
}

/** A built-in property's condition over the lead's form. */
function formFilterCondition(filter: LeadPropertyFilter, property: SiteProperty): SQL {
  const v = sql`(l.payload -> 'payload' ->> ${filter.key})`;
  const j = sql`(l.payload -> 'payload' -> ${filter.key})`;

  if (filter.op === 'empty') {
    return sql`coalesce(btrim(${v}), '') = ''`;
  }
  if (filter.op === 'notEmpty') {
    return sql`coalesce(btrim(${v}), '') <> ''`;
  }
  return kindCondition(filter, property.kind, formTyped(property.kind, v, j));
}

/** One property filter on lead `l`, as the inbox applies it (bound values only). */
export function propertyFilterCondition(filter: LeadPropertyFilter, property: SiteProperty): SQL {
  return property.storage === 'form'
    ? formFilterCondition(filter, property)
    : jsonFilterCondition(filter, property);
}

/**
 * The WHERE conditions for lead `l`. Restricted leads are never listed,
 * whatever the view; `archived` (and its old name `trash`) lists the archived
 * ones.
 */
export function leadConditions(filters: LeadFilters): SQL {
  const archived = normalizeLeadView(filters.view) === 'archived';
  const conditions: SQL[] = [
    sql`l.workspace_id = ${filters.workspaceId}`,
    sql`l.customer_data_restricted_at is null`,
    archived ? sql`l.deleted_at is not null` : sql`l.deleted_at is null`,
  ];
  if (filters.status) conditions.push(sql`l.status = ${filters.status}`);
  if (filters.leadType) conditions.push(sql`l.lead_type = ${filters.leadType}`);
  if (filters.stage) conditions.push(sql`l.stage = ${filters.stage}`);
  if (filters.assignee === 'me') conditions.push(sql`l.assigned_actor_id = ${filters.actorId}`);
  else if (filters.assignee === 'none') conditions.push(sql`l.assigned_actor_id is null`);
  else if (filters.assignee) conditions.push(sql`l.assigned_actor_id = ${filters.assignee}`);
  if (filters.dueBy) {
    conditions.push(sql`exists (
      select 1 from app.lead_tasks due
      where due.workspace_id = l.workspace_id
        and due.lead_id = l.id
        and due.status in ('open', 'in_progress')
        and due.due_at < ${dueCutoff(filters.dueBy)}
    )`);
  }
  if (filters.unopenedOnly) {
    conditions.push(sql`not exists (
      select 1 from app.lead_activities opened
      where opened.workspace_id = l.workspace_id
        and opened.lead_id = l.id
        and opened.kind = 'system'
        and opened.data ->> 'event' = 'opened'
    )`);
  }
  if (filters.search) {
    const pattern = likePattern(filters.search);
    const matches: SQL[] = [
      sql`l.full_name ilike ${pattern}`,
      sql`l.email ilike ${pattern}`,
      sql`l.phone ilike ${pattern}`,
      sql`l.external_ref ilike ${pattern}`,
    ];
    // A phone typed as digits finds `+1 (604) 555-0100`; short digit runs
    // would match nearly every number, so only four or more count.
    const digits = filters.search.replace(/\D/g, '');
    if (digits.length >= 4) {
      matches.push(
        sql`regexp_replace(coalesce(l.phone, ''), '[^0-9]', '', 'g') like ${`%${digits}%`}`,
      );
    }
    conditions.push(sql`(${sql.join(matches, sql` or `)})`);
  }
  if (filters.where && filters.where.length > 0) {
    for (const filter of filters.where) {
      const property = resolvePropertyFor(filters.catalog, filter.key, filters.leadType);
      conditions.push(property ? propertyFilterCondition(filter, property) : sql`false`);
    }
  }
  return sql.join(conditions, sql` and `);
}

/** A lead's soonest active task, for ordering the follow-ups due before the page is cut. */
const NEXT_DUE = sql.raw(`(
  select min(task.due_at) from app.lead_tasks task
  where task.workspace_id = l.workspace_id and task.lead_id = l.id and task.status in ('open', 'in_progress')
)`);

/** A property's sort key: its value as its kind orders it, null (last) when absent or malformed. */
function propertySortExpression(key: string, property: SiteProperty): SQL {
  if (property.storage !== 'form') {
    const { v, j } = jsonStoredValue(property);
    const typed = customTyped(property.kind, v, j);
    return property.kind === 'number' ||
      property.kind === 'money' ||
      property.kind === 'count' ||
      property.kind === 'yesNo' ||
      property.kind === 'date'
      ? typed
      : sql`nullif(btrim(${typed}), '')`;
  }
  const v = sql`(l.payload -> 'payload' ->> ${key})`;
  const j = sql`(l.payload -> 'payload' -> ${key})`;
  switch (property.kind) {
    case 'count':
    case 'number':
    case 'money':
    case 'yesNo':
    case 'date':
      return formTyped(property.kind, v, j);
    default:
      return sql`nullif(btrim(${v}), '')`;
  }
}

export function sortOrderOf(filters: LeadFilters): { pageOrder: SQL; rowOrder: SQL } {
  if (filters.sort) {
    const parsed = parseLeadSort(filters.sort);
    if (parsed) {
      const dir =
        parsed.direction === 'asc' ? sql.raw('asc nulls last') : sql.raw('desc nulls last');
      let expr: SQL;
      if (parsed.field === 'createdAt') {
        expr = sql`l.created_at`;
      } else if (parsed.field === 'updatedAt') {
        expr = sql`l.updated_at`;
      } else if (parsed.field === 'fullName') {
        expr = sql`nullif(btrim(l.full_name), '')`;
      } else if (parsed.field === 'externalRef') {
        expr = sql`nullif(btrim(l.external_ref), '')`;
      } else if (parsed.propertyKey !== undefined) {
        const property = resolvePropertyFor(filters.catalog, parsed.propertyKey, filters.leadType);
        expr = property ? propertySortExpression(parsed.propertyKey, property) : sql`null`;
      } else {
        expr = sql`l.updated_at`;
      }
      const order = sql`${expr} ${dir}, l.id`;
      return { pageOrder: order, rowOrder: order };
    }
  }

  const archived = normalizeLeadView(filters.view) === 'archived';
  const pageOrder = archived
    ? sql.raw('l.deleted_at desc, l.id')
    : filters.dueBy
      ? sql`${NEXT_DUE} asc, l.id`
      : sql.raw('l.updated_at desc, l.id');
  const rowOrder = archived
    ? sql.raw('l.deleted_at desc, l.id')
    : filters.dueBy
      ? sql.raw('t.next_due asc, l.id')
      : sql.raw('l.updated_at desc, l.id');
  return { pageOrder, rowOrder };
}
