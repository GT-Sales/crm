import { z } from 'zod';

import {
  leadPropertyCatalog,
  leadTypeProperties,
  resolveLeadTypeProperty,
} from './lead-properties';

/**
 * The fields of each lead type's form, in the order staff check them: how
 * the lead page shows them and which ones staff may correct. Derived from the
 * shared property catalogue (`./lead-properties`) merged with each type's
 * property list (`leadTypeProperties`). Values live in the lead's
 * `form.payload`; `staffOnly` fields (a SIM number) are kept there by staff
 * and never sent by the website.
 */

export type LeadFieldKind =
  'text' | 'longText' | 'date' | 'dateTime' | 'count' | 'yesNo' | 'choice';

export interface LeadFieldOption {
  readonly value: string;
  readonly label: string;
}

export interface LeadFieldDefinition {
  readonly key: string;
  readonly label: string;
  readonly kind: LeadFieldKind;
  /** For `choice`: the stored values, as staff read them. */
  readonly options?: readonly LeadFieldOption[];
  /** For `choice`: also keep the chosen option's label under this key (a plan's `planLabel`). */
  readonly labelKey?: string;
  /** Staff may correct it on the lead page. */
  readonly editable?: boolean;
  /** Kept by staff; the website never sends it. */
  readonly staffOnly?: boolean;
  /** Longest accepted text, for the text kinds. */
  readonly maxLength?: number;
  /** Required whenever another field holds this value (a mailed SIM needs an address). */
  readonly requiredWhen?: { readonly key: string; readonly value: string };
  /** A date the order counts down to, shown as "in 5 days" on lists and the lead page. */
  readonly countdown?: boolean;
}

function buildLeadFieldCatalog(): Readonly<Record<string, readonly LeadFieldDefinition[]>> {
  const catalog: Record<string, readonly LeadFieldDefinition[]> = {};
  for (const [leadType, uses] of Object.entries(leadTypeProperties)) {
    catalog[leadType] = uses.map((use) => {
      const property = leadPropertyCatalog[use.key];
      if (!property) {
        throw new Error(`Unknown lead property "${use.key}" in leadTypeProperties.${leadType}`);
      }
      return resolveLeadTypeProperty(property, use);
    });
  }
  return catalog;
}

export const leadFieldCatalog: Readonly<Record<string, readonly LeadFieldDefinition[]>> =
  buildLeadFieldCatalog();

/** The type's fields, or none for a type the catalogue does not describe. */
export function leadFields(leadType: string): readonly LeadFieldDefinition[] {
  return leadFieldCatalog[leadType] ?? [];
}

/** The type's date field that orders count down to (Get Canada Sim's arrival), if any. */
export function leadCountdownField(leadType: string): LeadFieldDefinition | undefined {
  return leadFields(leadType).find((entry) => entry.countdown);
}

const fieldKeySchema = z.string().regex(/^[a-z][A-Za-z0-9]{0,63}$/, 'a field key');

/**
 * Staff corrections to a lead's form: each field's new value, or null to
 * clear it. Which keys a type accepts, and what each holds, is
 * `applyLeadFormEdit`'s check against the type's definitions.
 */
export const leadFormEditSchema = z
  .record(fieldKeySchema, z.union([z.string().max(4000), z.boolean(), z.number(), z.null()]))
  .refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 40, {
    message: 'one to forty fields',
  });
export type LeadFormEdit = z.infer<typeof leadFormEditSchema>;

export type LeadFormEditResult =
  { ok: true; payload: Record<string, unknown>; changed: string[] } | { ok: false; field: string };

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Control characters, bidi overrides and line separators; a long text may keep its newlines. */
function hasControlCharacter(text: string, allowNewline: boolean): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x0a && allowNewline) continue;
    if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      return true;
    }
  }
  return false;
}

export function isCalendarDate(value: string): boolean {
  const match = DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    year >= 1900 &&
    year <= 2200 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

type Checked = { ok: true; value: unknown } | { ok: false };

/** The stored form of one edited value; `undefined` value means "clear the field". */
function checkValue(definition: LeadFieldDefinition, raw: unknown): Checked {
  if (raw === null) return { ok: true, value: undefined };
  switch (definition.kind) {
    case 'text':
    case 'longText': {
      if (typeof raw !== 'string') return { ok: false };
      const text = raw.replace(/\r\n?/g, '\n').trim();
      if (text === '') return { ok: true, value: undefined };
      if (text.length > (definition.maxLength ?? 200)) return { ok: false };
      if (hasControlCharacter(text, definition.kind === 'longText')) return { ok: false };
      return { ok: true, value: text };
    }
    case 'date':
      return typeof raw === 'string' && isCalendarDate(raw)
        ? { ok: true, value: raw }
        : { ok: false };
    case 'dateTime':
      return typeof raw === 'string' && z.iso.datetime().safeParse(raw).success
        ? { ok: true, value: raw }
        : { ok: false };
    case 'count':
      return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 10_000
        ? { ok: true, value: raw }
        : { ok: false };
    case 'yesNo':
      return typeof raw === 'boolean' ? { ok: true, value: raw } : { ok: false };
    case 'choice':
      return typeof raw === 'string' && definition.options?.some((option) => option.value === raw)
        ? { ok: true, value: raw }
        : { ok: false };
  }
}

const isEmpty = (value: unknown) => value === undefined || value === null || value === '';

/**
 * Applies staff corrections to a form, field by field, against the type's
 * definitions: only editable fields, each value of its kind, a cleared field
 * removed, a chosen option's label kept beside it, and the cross-field rules
 * checked on the result. `changed` names the fields that really changed,
 * never their values; a refusal names the first field at fault.
 */
export function applyLeadFormEdit(
  leadType: string,
  current: Readonly<Record<string, unknown>>,
  edits: Readonly<Record<string, unknown>>,
): LeadFormEditResult {
  const definitions = new Map(leadFields(leadType).map((entry) => [entry.key, entry]));
  const payload: Record<string, unknown> = { ...current };
  const changed: string[] = [];
  for (const [key, raw] of Object.entries(edits)) {
    const definition = definitions.get(key);
    if (!definition?.editable) return { ok: false, field: key };
    const checked = checkValue(definition, raw);
    if (!checked.ok) return { ok: false, field: key };
    const before = payload[key];
    if (checked.value === undefined) delete payload[key];
    else payload[key] = checked.value;
    if (definition.labelKey) {
      const option = definition.options?.find((entry) => entry.value === checked.value);
      if (option) payload[definition.labelKey] = option.label;
      else if (checked.value === undefined) delete payload[definition.labelKey];
    }
    if (before !== payload[key]) changed.push(key);
  }
  // A rule is checked when the edit touches either side of it, so correcting
  // one field never fails on another the order already lacked.
  for (const definition of definitions.values()) {
    const rule = definition.requiredWhen;
    if (!rule || !(definition.key in edits || rule.key in edits)) continue;
    if (payload[rule.key] === rule.value && isEmpty(payload[definition.key])) {
      return { ok: false, field: definition.key };
    }
  }
  return { ok: true, payload, changed };
}
