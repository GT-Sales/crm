'use client';

import { useState, type JSX } from 'react';
import {
  CUSTOM_PROPERTY_KINDS,
  createCustomPropertySchema,
  updatePropertySchema,
  type CreateCustomProperty,
  type PropertyKind,
  type PropertyOption,
  type SiteProperty,
  type UpdateProperty,
} from '@gt-sales/contracts';
import { Button, Checkbox, FormField, Input, Label, NativeSelect } from '@gt-sales/ui';

type CustomKind = (typeof CUSTOM_PROPERTY_KINDS)[number];

/** How staff name each kind, for the kind selector and the property list. */
export const PROPERTY_KIND_LABELS: Record<PropertyKind, string> = {
  text: 'Text',
  longText: 'Long text',
  number: 'Number',
  money: 'Money',
  date: 'Date',
  dateTime: 'Date and time',
  count: 'Count',
  yesNo: 'Yes or no',
  choice: 'Choice',
  email: 'Email',
  phone: 'Phone',
  url: 'URL',
};

function customKind(kind: PropertyKind): CustomKind | undefined {
  return CUSTOM_PROPERTY_KINDS.find((entry) => entry === kind);
}

function customKindFromValue(value: string): CustomKind | undefined {
  return CUSTOM_PROPERTY_KINDS.find((entry) => entry === value);
}

interface OptionDraft {
  /** Local identity only; the stored `value` is permanent once an option exists. */
  id: number;
  value: string | undefined;
  label: string;
  hidden: boolean;
}

const VALUE_MAX_LENGTH = 64;

function slug(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'option'
  );
}

/** Each new option's value from its label (`bronze_plan`, then `bronze_plan_2`…), never one already taken. */
function optionsFromDrafts(drafts: readonly OptionDraft[]): PropertyOption[] {
  const taken = new Set(drafts.flatMap((draft) => (draft.value ? [draft.value] : [])));
  return drafts.map((draft) => {
    const label = draft.label.trim();
    if (draft.value) return { value: draft.value, label, hidden: draft.hidden };
    const base = slug(label);
    let value = base.slice(0, VALUE_MAX_LENGTH);
    for (let counter = 2; taken.has(value); counter += 1) {
      const suffix = `_${counter}`;
      value = `${base.slice(0, VALUE_MAX_LENGTH - suffix.length)}${suffix}`;
    }
    taken.add(value);
    return { value, label, hidden: draft.hidden };
  });
}

/**
 * Adds a custom property, or edits one. The kind is chosen once: it is locked
 * on an existing property because leads already hold values of that kind.
 * For a plan property (`object` 'plan') there are no lead types, and the
 * _Show on website_ switch decides whether the website's plan listing carries
 * the value. `onSave` answers the reason a save was refused, or nothing when
 * it worked.
 */
export function PropertyEditor({
  initial,
  leadTypes,
  object = 'lead',
  onSave,
}: {
  initial?: SiteProperty;
  leadTypes: readonly { key: string; label: string }[];
  object?: 'lead' | 'plan';
  onSave(input: CreateCustomProperty | UpdateProperty): Promise<string | undefined>;
}): JSX.Element {
  const [label, setLabel] = useState(initial?.label ?? '');
  const [kind, setKind] = useState<CustomKind>(
    (initial ? customKind(initial.kind) : undefined) ?? 'text',
  );
  const [nextId, setNextId] = useState(initial?.options?.length ?? 0);
  const [options, setOptions] = useState<OptionDraft[]>(() =>
    (initial?.options ?? []).map((option, index) => ({
      id: index,
      value: option.value,
      label: option.label,
      hidden: option.hidden,
    })),
  );
  const [staffOnly, setStaffOnly] = useState(initial?.staffOnly ?? false);
  const [sensitive, setSensitive] = useState(initial?.sensitive ?? false);
  const [websiteVisible, setWebsiteVisible] = useState(initial?.websiteVisible ?? false);
  const [selectedTypes, setSelectedTypes] = useState<readonly string[]>(initial?.leadTypes ?? []);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const changeOption = (id: number, change: Partial<OptionDraft>) =>
    setOptions((current) =>
      current.map((option) => (option.id === id ? { ...option, ...change } : option)),
    );

  const toggleType = (key: string, checked: boolean) =>
    setSelectedTypes((current) =>
      checked
        ? current.includes(key)
          ? current
          : [...current, key]
        : current.filter((entry) => entry !== key),
    );

  async function save() {
    setError(undefined);
    if (label.trim() === '') {
      setError('Enter a label.');
      return;
    }
    if (kind === 'choice') {
      if (options.length === 0) {
        setError('Add at least one option.');
        return;
      }
      if (options.some((option) => option.label.trim() === '')) {
        setError('Give every option a label.');
        return;
      }
    }
    const built = kind === 'choice' ? optionsFromDrafts(options) : [];
    let input: CreateCustomProperty | UpdateProperty;
    if (initial) {
      const parsed = updatePropertySchema.safeParse({
        expectedVersion: initial.version ?? 1,
        label: label.trim(),
        ...(kind === 'choice' ? { options: built } : {}),
        ...(object === 'plan'
          ? { websiteVisible }
          : { staffOnly, sensitive, leadTypes: selectedTypes }),
      });
      if (!parsed.success) {
        setError('Check the fields and try again.');
        return;
      }
      input = parsed.data;
    } else {
      const parsed = createCustomPropertySchema.safeParse({
        label: label.trim(),
        kind,
        options: built,
        ...(object === 'plan'
          ? { websiteVisible }
          : { staffOnly, sensitive, leadTypes: selectedTypes }),
      });
      if (!parsed.success) {
        setError('Check the fields and try again.');
        return;
      }
      input = parsed.data;
    }
    setBusy(true);
    try {
      setError(await onSave(input));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <FormField id="property-label" label="Label">
        <Input maxLength={80} value={label} onChange={(event) => setLabel(event.target.value)} />
      </FormField>

      <FormField
        id="property-kind"
        label="Kind"
        {...(initial ? { hint: 'The kind cannot change after the property is created.' } : {})}
      >
        <NativeSelect
          disabled={initial !== undefined}
          value={kind}
          onChange={(event) => {
            const next = customKindFromValue(event.target.value);
            if (next) setKind(next);
          }}
        >
          {CUSTOM_PROPERTY_KINDS.map((entry) => (
            <option key={entry} value={entry}>
              {PROPERTY_KIND_LABELS[entry]}
            </option>
          ))}
        </NativeSelect>
      </FormField>

      {kind === 'choice' ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Options</legend>
          {options.map((option, index) => (
            <div key={option.id} className="flex flex-wrap items-center gap-2">
              <Input
                className="min-w-40 flex-1"
                aria-label={`Option ${index + 1} label`}
                maxLength={80}
                value={option.label}
                onChange={(event) => changeOption(option.id, { label: event.target.value })}
              />
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  aria-label={`Hide option ${index + 1}`}
                  checked={option.hidden}
                  onCheckedChange={(checked) =>
                    changeOption(option.id, { hidden: checked === true })
                  }
                />
                Hidden
              </label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Remove option ${index + 1}`}
                onClick={() =>
                  setOptions((current) => current.filter((entry) => entry.id !== option.id))
                }
              >
                Remove
              </Button>
            </div>
          ))}
          <p className="text-sm text-muted-foreground">
            Hide an option to stop offering it. Leads that already hold it keep it.
          </p>
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setOptions((current) => [
                  ...current,
                  { id: nextId, value: undefined, label: '', hidden: false },
                ]);
                setNextId(nextId + 1);
              }}
            >
              Add option
            </Button>
          </div>
        </fieldset>
      ) : null}

      {object === 'plan' ? (
        <>
          <div className="flex items-center gap-2">
            <Checkbox
              id="property-website-visible"
              checked={websiteVisible}
              onCheckedChange={(checked) => setWebsiteVisible(checked === true)}
            />
            <Label htmlFor="property-website-visible">Show on website</Label>
          </div>
          <p className="-mt-3 text-sm text-muted-foreground">
            The website&rsquo;s plan listing carries this value. Leave it off for details only staff
            should see, such as a carrier cost.
          </p>
        </>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <Checkbox
              id="property-staff-only"
              checked={staffOnly}
              onCheckedChange={(checked) => setStaffOnly(checked === true)}
            />
            <Label htmlFor="property-staff-only">Staff only</Label>
          </div>
          <p className="-mt-3 text-sm text-muted-foreground">
            Websites never send it; staff fill it in on the lead.
          </p>

          <div className="flex items-center gap-2">
            <Checkbox
              id="property-sensitive"
              checked={sensitive}
              onCheckedChange={(checked) => setSensitive(checked === true)}
            />
            <Label htmlFor="property-sensitive">Sensitive</Label>
          </div>
          <p className="-mt-3 text-sm text-muted-foreground">
            Left out of filters, sorting and columns.
          </p>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">Lead types</legend>
            {leadTypes.map((leadType) => (
              <div key={leadType.key} className="flex items-center gap-2">
                <Checkbox
                  id={`property-type-${leadType.key}`}
                  checked={selectedTypes.includes(leadType.key)}
                  onCheckedChange={(checked) => toggleType(leadType.key, checked === true)}
                />
                <Label htmlFor={`property-type-${leadType.key}`}>{leadType.label}</Label>
              </div>
            ))}
            <p className="text-sm text-muted-foreground">
              Leave all unchecked to use the property on every lead type.
            </p>
          </fieldset>
        </>
      )}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save property'}
        </Button>
      </div>
    </form>
  );
}
