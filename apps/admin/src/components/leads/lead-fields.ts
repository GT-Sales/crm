import { leadFields, type LeadFieldDefinition } from '@gt-sales/contracts';

/**
 * How a lead's form reads on the lead page: the type's fields from the
 * contracts' definitions (`leadFields`), in the order staff check them, with
 * labels and formatting. A key the definitions do not know (a type not yet
 * described, or a field a website added later) still shows, after the known
 * ones, under a label made from its name. Staff-only fields (a SIM number)
 * read separately, in their own card.
 */

export interface FormField {
  label: string;
  value: string;
  /** For the type's countdown field (a SIM order's arrival): the day it counts down to. */
  countdownDay?: string;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function dateLabel(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return text(value);
  return new Date(`${value}T12:00:00Z`).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function dateTimeLabel(value: unknown): string | undefined {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return text(value);
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** One field's value as staff read it, or undefined when it is empty. */
export function fieldValue(
  definition: LeadFieldDefinition,
  payload: Readonly<Record<string, unknown>>,
): string | undefined {
  const value = payload[definition.key];
  switch (definition.kind) {
    case 'text':
    case 'longText':
      return text(value);
    case 'date':
      return dateLabel(value);
    case 'dateTime':
      return dateTimeLabel(value);
    case 'count':
      return typeof value === 'number' ? String(value) : undefined;
    case 'yesNo':
      return typeof value === 'boolean' ? (value ? 'Yes' : 'No') : undefined;
    case 'choice': {
      const option = definition.options?.find((entry) => entry.value === value);
      if (option) return option.label;
      // A value no longer offered (a retired plan) reads as it was stored.
      return (definition.labelKey ? text(payload[definition.labelKey]) : undefined) ?? text(value);
    }
  }
}

function labelFromKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function anyValue(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

/** The customer's form: known fields first in order, then unknown keys; empty ones left out. */
export function formFields(leadType: string, payload: Record<string, unknown>): FormField[] {
  const definitions = leadFields(leadType);
  const known = new Set<string>();
  for (const definition of definitions) {
    known.add(definition.key);
    if (definition.labelKey) known.add(definition.labelKey);
  }
  const fields: FormField[] = [];
  for (const definition of definitions) {
    if (definition.staffOnly) continue;
    const value = fieldValue(definition, payload);
    if (value === undefined) continue;
    const raw = payload[definition.key];
    fields.push(
      definition.countdown && typeof raw === 'string'
        ? { label: definition.label, value, countdownDay: raw }
        : { label: definition.label, value },
    );
  }
  for (const [key, raw] of Object.entries(payload)) {
    if (known.has(key)) continue;
    const value = anyValue(raw);
    if (value !== undefined) fields.push({ label: labelFromKey(key), value });
  }
  return fields;
}

/** The fields staff keep on the lead (a SIM number), each shown even while empty. */
export function staffFields(
  leadType: string,
  payload: Record<string, unknown>,
): Array<FormField & { key: string }> {
  return leadFields(leadType)
    .filter((definition) => definition.staffOnly)
    .map((definition) => ({
      key: definition.key,
      label: definition.label,
      value: fieldValue(definition, payload) ?? '—',
    }));
}

/** How a form edit names a field on the timeline ("plan, arrival in canada"). */
export function fieldLabel(leadType: string, key: string): string {
  const definition = leadFields(leadType).find((entry) => entry.key === key);
  return (definition?.label ?? labelFromKey(key)).toLowerCase();
}
