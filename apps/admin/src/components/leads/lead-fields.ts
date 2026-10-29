import {
  filterableLeadProperties,
  leadFields,
  leadProperty,
  type LeadFieldDefinition,
  type LeadFieldKind,
  type LeadPropertyFilter,
  type LeadPropertyOperator,
} from '@gt-sales/contracts';

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

function propertyFieldDefinition(
  leadType: string | undefined,
  key: string,
): LeadFieldDefinition | undefined {
  if (leadType) {
    const byType = leadFields(leadType).find((entry) => entry.key === key);
    if (byType) return byType;
  }
  const filterable = filterableLeadProperties(leadType).find((entry) => entry.key === key);
  if (filterable) {
    return {
      key: filterable.key,
      label: filterable.label,
      kind: filterable.kind,
      ...(filterable.options ? { options: filterable.options } : {}),
    };
  }
  const shared = leadProperty(key);
  if (shared) {
    return {
      key: shared.key,
      label: shared.label,
      kind: shared.kind,
      ...(shared.options ? { options: shared.options } : {}),
    };
  }
  return undefined;
}

/** Column header label for an optional property column on the leads table. */
export function propertyColumnLabel(leadType: string | undefined, key: string): string {
  return propertyFieldDefinition(leadType, key)?.label ?? labelFromKey(key);
}

/** Formats one optional property column cell using `fieldValue`. */
export function propertyColumnValue(
  leadType: string,
  key: string,
  properties?: Readonly<Record<string, unknown>>,
): string | undefined {
  if (!properties) return undefined;
  const definition = propertyFieldDefinition(leadType, key);
  if (!definition) return anyValue(properties[key]);
  return fieldValue(definition, properties);
}

/** Plain-English label for a filter operator given the property's kind. */
export function propertyOperatorLabel(kind: LeadFieldKind, op: LeadPropertyOperator): string {
  switch (op) {
    case 'eq':
      return 'is';
    case 'contains':
      return 'contains';
    case 'in':
      return 'is any of';
    case 'lte':
      return kind === 'count' ? 'at most' : 'on or before';
    case 'gte':
      return kind === 'count' ? 'at least' : 'on or after';
    case 'empty':
      return 'is empty';
    case 'notEmpty':
      return 'is not empty';
  }
}

/** Human-readable text for an active filter chip (e.g. `Visa / permit type is Study permit`). */
export function propertyFilterSummary(
  leadType: string | undefined,
  filter: LeadPropertyFilter,
): string {
  const definition = propertyFieldDefinition(leadType, filter.key);
  const label = definition?.label ?? labelFromKey(filter.key);
  const kind = definition?.kind ?? 'text';
  const opLabel = propertyOperatorLabel(kind, filter.op);
  if (filter.op === 'empty' || filter.op === 'notEmpty') {
    return `${label} ${opLabel}`;
  }
  if (filter.op === 'in' && Array.isArray(filter.value)) {
    const items = filter.value.map(
      (item) =>
        (definition ? fieldValue(definition, { [filter.key]: item }) : undefined) ?? String(item),
    );
    return `${label} ${opLabel} ${items.join(', ')}`;
  }
  const formatted =
    (definition ? fieldValue(definition, { [filter.key]: filter.value }) : undefined) ??
    String(filter.value ?? '');
  return `${label} ${opLabel} ${formatted}`;
}
