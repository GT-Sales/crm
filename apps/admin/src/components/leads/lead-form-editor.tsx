'use client';

import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { parsePropertyValue, type PropertyValue, type SiteProperty } from '@gt-sales/contracts';
import { Button } from '@gt-sales/ui';

import { PropertyValueControl } from '../properties/property-value';

/**
 * One save of a record section: built-in answers go in `form`, custom ones in
 * `customValues` and order details in `order`, each keyed by property key.
 */
export interface PropertyEdits {
  form?: Record<string, PropertyValue | null>;
  customValues?: Record<string, PropertyValue | null>;
  order?: Record<string, PropertyValue | null>;
}

type Draft = Record<string, PropertyValue | null>;

const isPropertyValue = (value: unknown): value is PropertyValue =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

/**
 * A property's stored value on the lead, where its storage keeps it: the
 * form, the custom values or the order details (under `storageKey`, so the
 * order's `plan` reads `order.planId`, never the form's own `planId`).
 */
export function storedValue(
  property: Pick<SiteProperty, 'key' | 'storage' | 'storageKey'>,
  form: Readonly<Record<string, unknown>>,
  customValues: Readonly<Record<string, unknown>>,
  order: Readonly<Record<string, unknown>> = {},
): unknown {
  const source =
    property.storage === 'custom' ? customValues : property.storage === 'order' ? order : form;
  const key = property.storageKey ?? property.key;
  return Object.hasOwn(source, key) ? source[key] : undefined;
}

/** How a choice option no longer offered reads: a plan is inactive, another option retired. */
const hiddenOptionLabel = (property: SiteProperty) =>
  property.storage === 'order' && property.key === 'plan' ? 'inactive' : 'retired';

/**
 * Corrects a lead's properties in place: one control per property, by its
 * kind (`PropertyValueControl`). Saves only what changed, as the new value or
 * null to clear it, each checked against its property first; built-in
 * answers, custom values and order details go out together in one change.
 * The backend checks every value again. `hints` puts a line beneath a
 * property's control, by key.
 */
export function LeadFormEditor({
  properties,
  form,
  customValues,
  order = {},
  hints = {},
  saving,
  onSave,
  onCancel,
}: {
  properties: readonly SiteProperty[];
  form: Readonly<Record<string, unknown>>;
  customValues: Readonly<Record<string, unknown>>;
  order?: Readonly<Record<string, unknown>>;
  hints?: Readonly<Record<string, ReactNode>>;
  saving: boolean;
  onSave(edits: PropertyEdits): void;
  onCancel(): void;
}) {
  const idPrefix = useId();
  const stored = (property: SiteProperty): PropertyValue | undefined => {
    const value = storedValue(property, form, customValues, order);
    return isPropertyValue(value) ? value : undefined;
  };
  const [draft, setDraft] = useState<Draft>(() =>
    Object.fromEntries(properties.map((property) => [property.key, stored(property) ?? null])),
  );
  const [problem, setProblem] = useState<string>();

  function submit(event: FormEvent) {
    event.preventDefault();
    const formEdits: Record<string, PropertyValue | null> = {};
    const customEdits: Record<string, PropertyValue | null> = {};
    const orderEdits: Record<string, PropertyValue | null> = {};
    for (const property of properties) {
      const target =
        property.storage === 'custom'
          ? customEdits
          : property.storage === 'order'
            ? orderEdits
            : formEdits;
      const before = stored(property);
      const after = draft[property.key] ?? null;
      if (after === null || (typeof after === 'string' && after.trim() === '')) {
        if (before !== undefined) target[property.key] = null;
        continue;
      }
      // An option the site has since retired stays as long as nobody changes it.
      if (after === before) continue;
      const parsed = parsePropertyValue(property, after);
      if (!parsed.ok) {
        setProblem(`Check ${property.label}: that value cannot be saved.`);
        return;
      }
      if (parsed.value !== before) target[property.key] = parsed.value;
    }
    setProblem(undefined);
    const edits: PropertyEdits = {
      ...(Object.keys(formEdits).length > 0 ? { form: formEdits } : {}),
      ...(Object.keys(customEdits).length > 0 ? { customValues: customEdits } : {}),
      ...(Object.keys(orderEdits).length > 0 ? { order: orderEdits } : {}),
    };
    if (edits.form === undefined && edits.customValues === undefined && edits.order === undefined) {
      onCancel();
    } else onSave(edits);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      {properties.map((property) => {
        const id = `${idPrefix}-${property.key}`;
        const hint = hints[property.key];
        const control = (
          <label
            key={property.key}
            htmlFor={id}
            className="flex flex-col gap-1 text-xs text-muted-foreground"
          >
            {property.label}
            <PropertyValueControl
              id={id}
              property={property}
              value={draft[property.key] ?? undefined}
              disabled={saving}
              hiddenOptionLabel={hiddenOptionLabel(property)}
              onChange={(value) => setDraft((current) => ({ ...current, [property.key]: value }))}
            />
          </label>
        );
        // The hint sits beneath the control, outside its label, so the control keeps its name.
        return hint ? (
          <div key={property.key} className="flex flex-col gap-1">
            {control}
            {hint}
          </div>
        ) : (
          control
        );
      })}
      {problem ? (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}
      <div className="flex gap-2 pt-1">
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
