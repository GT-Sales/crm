import { isDeepStrictEqual } from 'node:util';
import {
  codePropertyCatalog,
  DRAFT_SAVE_VALUE_MAX,
  propertyKeySchema,
  type LeadContact,
  type LeadForm,
  type PropertyCatalog,
} from '@gt-sales/contracts';
import { z } from 'zod';

/**
 * What a customer's draft save really changed, for the staff timeline (issue
 * #87, owner decision of 21 Nov 2026): the changed fields with the values the
 * customer filled in.
 *
 * The field keys go in the entry's `data` (never personal). The values are
 * personal data, so they go in the entry's `body`, the one place a timeline
 * entry keeps a customer's words: restricting the lead nulls it
 * (`app.erase_restricted_lead_data`, migration 0030; AGENTS.md rule 7), and
 * it is read only with the timeline, which travels with contact visibility
 * (rule 4). Nothing here is logged or put in an audit event.
 *
 * A value is kept only for a contact field, the order's plan and quantity,
 * and a form field the code catalogue lists for the lead's type that is not
 * sensitive. A sensitive answer (a date of birth) and any key the catalogue
 * does not know (a type with no modelled form takes any object, which could
 * carry a token or a file reference) are named, never kept.
 */

/** A value is cut to this many UTF-16 units; the timeline shows that it was. */
export const DRAFT_VALUE_MAX = DRAFT_SAVE_VALUE_MAX;
/** A timeline entry names at most this many fields (`leadActivitySchema`). */
export const DRAFT_FIELDS_MAX = 50;
/** `lead_activities_body_check`: a body is 1 to 4000 characters. */
const BODY_MAX = 4000;

export interface DraftValue {
  key: string;
  /** The new value in words; empty when the customer cleared the field. */
  value: string;
  cut?: true;
}

export interface DraftSaveChanges {
  /** Every field the save changed, in the order the customer's form has them. */
  fields: string[];
  /** The new value of each changed field whose value may be kept. */
  values: DraftValue[];
}

export interface DraftSaveBefore {
  contact: {
    fullName: string | null;
    email: string | null;
    phone: string | null;
    countryCode: string | null;
  };
  /** The stored form's `payload`, or null when the draft holds no form. */
  payload: Readonly<Record<string, unknown>> | null;
  planId: string | null;
  quantity: number;
}

const CONTACT_KEYS = ['fullName', 'email', 'phone', 'countryCode'] as const;
/** The order's plan and quantity, by their order property keys (`orderPropertyCatalog`). */
const ORDER_KEYS = new Set(['plan', 'quantity']);

function display(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return JSON.stringify(value) ?? '';
}

function kept(key: string, value: unknown): DraftValue {
  const text = display(value);
  if (text.length <= DRAFT_VALUE_MAX) return { key, value: text };
  // Never end on half of a two-unit character.
  const cut = text
    .slice(0, DRAFT_VALUE_MAX)
    .replace(/[\uD800-\uDBFF]$/, '')
    .trimEnd();
  return { key, value: cut, cut: true };
}

/** Whether the code catalogue lets a form field's value be kept for this lead type. */
function formValueKept(leadType: string, key: string): boolean {
  const property = codePropertyCatalog.forType(leadType).find((entry) => entry.key === key);
  return property !== undefined && property.storage === 'form' && !property.sensitive;
}

export function draftSaveChanges(input: {
  leadType: string;
  before: DraftSaveBefore;
  contact?: LeadContact;
  form?: LeadForm;
  order?: { planId?: string; quantity?: number };
  /** The name of the plan `order.planId` names, when the save names one. */
  planName?: string | null;
}): DraftSaveChanges {
  const fields: string[] = [];
  const values: DraftValue[] = [];
  const changed = (key: string, value: DraftValue | undefined) => {
    if (fields.length >= DRAFT_FIELDS_MAX || fields.includes(key)) return;
    fields.push(key);
    if (value) values.push(value);
  };

  for (const key of CONTACT_KEYS) {
    const next = input.contact?.[key];
    if (next !== undefined && next !== (input.before.contact[key] ?? undefined)) {
      changed(key, kept(key, next));
    }
  }

  if (input.form !== undefined) {
    const old = input.before.payload ?? {};
    const next = input.form.payload;
    // The new form's own order first, then what it no longer holds.
    for (const key of [...Object.keys(next), ...Object.keys(old).filter((k) => !(k in next))]) {
      if (isDeepStrictEqual(old[key], next[key])) continue;
      // A contact or order key in a form would read as that field's own change.
      if (!propertyKeySchema.safeParse(key).success || ORDER_KEYS.has(key)) continue;
      if (CONTACT_KEYS.some((contactKey) => contactKey === key)) continue;
      changed(key, formValueKept(input.leadType, key) ? kept(key, next[key]) : undefined);
    }
  }

  if (input.order?.planId !== undefined && input.order.planId !== input.before.planId) {
    // The plan's id tells staff nothing; without its name the field is only named.
    changed('plan', input.planName ? kept('plan', input.planName) : undefined);
  }
  if (input.order?.quantity !== undefined && input.order.quantity !== input.before.quantity) {
    changed('quantity', kept('quantity', input.order.quantity));
  }
  return { fields, values };
}

const storedValuesSchema = z.object({
  v: z.literal(1),
  values: z
    .array(
      z.object({
        key: propertyKeySchema,
        value: z.string().max(DRAFT_VALUE_MAX),
        cut: z.literal(true).optional(),
      }),
    )
    .max(DRAFT_FIELDS_MAX),
});

/**
 * The entry's `body`: the values as JSON, within what a body may hold. When
 * they do not all fit the last ones are left out whole (their fields are
 * still named); null when there is no value to keep.
 */
export function draftSaveBody(values: readonly DraftValue[]): string | null {
  for (let count = values.length; count > 0; count -= 1) {
    const body = JSON.stringify({ v: 1, values: values.slice(0, count) });
    if (body.length <= BODY_MAX) return body;
  }
  return null;
}

/** The values `draftSaveBody` stored; nothing once the body is erased or if it is not ours. */
export function draftSaveValuesOf(body: string | null): DraftValue[] | undefined {
  if (!body) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    return undefined;
  }
  const parsed = storedValuesSchema.safeParse(decoded);
  return parsed.success ? parsed.data.values : undefined;
}

/**
 * The stored values a reader is shown, by the site's catalogue as it is now:
 * a form value whose property the site has hidden or made sensitive since, or
 * no longer has, is left out (its field is still named).
 */
export function shownDraftValues(
  values: readonly DraftValue[],
  leadType: string,
  catalog: PropertyCatalog,
): DraftValue[] {
  const visible = new Map(catalog.forType(leadType).map((property) => [property.key, property]));
  return values.filter((entry) => {
    if (CONTACT_KEYS.some((key) => key === entry.key) || ORDER_KEYS.has(entry.key)) return true;
    const property = visible.get(entry.key);
    return property !== undefined && !property.sensitive && !property.hidden;
  });
}
