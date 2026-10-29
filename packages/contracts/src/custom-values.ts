import { parsePropertyValue, type PropertyValue, type SiteProperty } from './properties';

export type CustomValueEditsResult =
  | { ok: true; values: Record<string, PropertyValue>; changedKeys: string[] }
  | { ok: false; field: string };

const isPropertyValue = (value: unknown): value is PropertyValue =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

/**
 * Staff edits to a lead's custom values (`leads.custom_values`), checked
 * against the properties the lead's type shows (`catalog.forType(leadType)`).
 * `null` clears (removes the key); empty string is invalid; a hidden choice
 * option is kept only when unchanged; keys must be custom properties visible
 * for the type. A refusal names the field, never the value. `values` is the
 * whole result (stored values that are not a plain value are left out of
 * it); `changedKeys` lists, in edit order, the keys whose value changed.
 * Pure, so the admin can run the same check before it sends.
 */
export function applyCustomValueEdits(input: {
  properties: readonly SiteProperty[];
  current: Record<string, unknown>;
  edits: Record<string, PropertyValue | null>;
}): CustomValueEditsResult {
  const values: Record<string, PropertyValue> = {};
  for (const [key, value] of Object.entries(input.current)) {
    if (isPropertyValue(value)) values[key] = value;
  }
  const changedKeys: string[] = [];

  for (const [key, edit] of Object.entries(input.edits)) {
    const property = input.properties.find((entry) => entry.key === key);
    if (!property || property.storage !== 'custom' || property.hidden) {
      return { ok: false, field: key };
    }
    const stored = Object.hasOwn(input.current, key) ? input.current[key] : undefined;

    if (edit === null) {
      if (stored !== undefined) {
        delete values[key];
        changedKeys.push(key);
      }
      continue;
    }
    if (edit === '') return { ok: false, field: key };

    // A lead keeps an option staff have since hidden, but nobody picks it anew.
    if (property.kind === 'choice' && edit === stored) continue;

    const parsed = parsePropertyValue(property, edit);
    if (!parsed.ok) return { ok: false, field: key };
    if (parsed.value === stored) continue;
    values[key] = parsed.value;
    changedKeys.push(key);
  }

  return { ok: true, values, changedKeys };
}
