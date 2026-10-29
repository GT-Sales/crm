'use client';

import { useId, useMemo, useState, type JSX, type ReactNode } from 'react';
import {
  renderPropertyLayout,
  type PropertyCatalog,
  type PropertyLayout,
  type PropertyValue,
  type SiteProperty,
} from '@gt-sales/contracts';
import { Button, Card, CardContent } from '@gt-sales/ui';

import { CountdownLabel } from '../leads/lead-display';
import { extraFormFields, type FormField } from '../leads/lead-fields';
import { LeadFormEditor, storedValue, type PropertyEdits } from '../leads/lead-form-editor';
import { PropertyValueText } from './property-value';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-3 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

const isEmpty = (value: unknown) =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

/** How one property reads on the record: masked when sensitive and the viewer may not see it. */
function PropertyReading({
  property,
  value,
  form,
  canRevealSensitive,
}: {
  property: SiteProperty;
  value: unknown;
  form: Readonly<Record<string, unknown>>;
  canRevealSensitive: boolean;
}) {
  if (isEmpty(value)) return <span className="text-muted-foreground">—</span>;
  if (property.sensitive && !canRevealSensitive) {
    return (
      <span>
        <span aria-hidden="true">••••</span>
        <span className="sr-only">Hidden</span>
      </span>
    );
  }
  if (typeof value === 'object') return <span>{JSON.stringify(value)}</span>;
  // A choice no longer offered (a retired plan) reads by the label kept beside it.
  if (
    property.kind === 'choice' &&
    property.labelKey &&
    !property.options?.some((option) => option.value === value)
  ) {
    const kept = form[property.labelKey];
    if (typeof kept === 'string' && kept.trim() !== '') return <span>{kept}</span>;
  }
  return (
    <>
      <PropertyValueText property={property} value={value} />
      {property.countdown && typeof value === 'string' ? (
        <CountdownLabel day={value} className="ml-2" />
      ) : null}
    </>
  );
}

function PropertySection({
  label,
  properties,
  extras,
  form,
  customValues,
  canEdit,
  canRevealSensitive,
  onSave,
}: {
  label: string;
  properties: readonly SiteProperty[];
  extras: readonly (FormField & { key: string })[];
  form: Readonly<Record<string, unknown>>;
  customValues: Readonly<Record<string, unknown>>;
  canEdit: boolean;
  canRevealSensitive: boolean;
  onSave(edits: PropertyEdits): Promise<string | undefined>;
}) {
  const headingId = useId();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();

  // A value staff may not see is not theirs to overwrite either.
  const editable = canEdit
    ? properties.filter(
        (property) => property.editable && (!property.sensitive || canRevealSensitive),
      )
    : [];
  // An unanswered question from the website's form is left out; what staff
  // keep (staff-only and custom properties) shows even while empty.
  const rows = properties.filter(
    (property) =>
      property.staffOnly ||
      property.origin === 'custom' ||
      !isEmpty(storedValue(property, form, customValues)),
  );
  if (rows.length === 0 && extras.length === 0 && editable.length === 0) return null;

  async function save(edits: PropertyEdits) {
    setSaving(true);
    setMessage(undefined);
    const failure = await onSave(edits);
    setSaving(false);
    if (failure) setMessage(failure);
    else setEditing(false);
  }

  return (
    <Card>
      <CardContent>
        <section aria-labelledby={headingId} className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h2 id={headingId} className="text-base font-semibold">
              {label}
            </h2>
            {editable.length > 0 && !editing ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setMessage(undefined);
                  setEditing(true);
                }}
              >
                Edit
              </Button>
            ) : null}
          </div>
          {editing ? (
            <LeadFormEditor
              properties={editable}
              form={form}
              customValues={customValues}
              saving={saving}
              onSave={(edits) => void save(edits)}
              onCancel={() => {
                setMessage(undefined);
                setEditing(false);
              }}
            />
          ) : (
            <dl>
              {rows.map((property) => (
                <Row key={property.key} label={property.label}>
                  <PropertyReading
                    property={property}
                    value={storedValue(property, form, customValues)}
                    form={form}
                    canRevealSensitive={canRevealSensitive}
                  />
                </Row>
              ))}
              {extras.map((field) => (
                <Row key={field.key} label={field.label}>
                  {field.value}
                </Row>
              ))}
            </dl>
          )}
          {message ? (
            <p role="alert" className="text-sm text-destructive">
              {message}
            </p>
          ) : null}
        </section>
      </CardContent>
    </Card>
  );
}

/**
 * A lead's properties in the sections of the site's layout for its type
 * (`renderPropertyLayout`: hidden properties left out, unplaced ones in a
 * closing "Other"), each section edited in place. Sensitive values read as
 * `••••` unless the viewer may reveal them. Form answers the catalogue does
 * not describe close the "Other" section, read-only. `onSave` answers with
 * what went wrong, or nothing once the change is saved.
 */
export function PropertySections(props: {
  leadType: string;
  layout: PropertyLayout;
  catalog: PropertyCatalog;
  form: Record<string, unknown>;
  customValues: Record<string, unknown>;
  canEdit: boolean;
  canRevealSensitive: boolean;
  onSave(edits: {
    form?: Record<string, PropertyValue | null>;
    customValues?: Record<string, PropertyValue | null>;
  }): Promise<string | undefined>;
}): JSX.Element {
  const { leadType, layout, catalog, form } = props;
  const sections = useMemo(
    () => renderPropertyLayout(layout, leadType, catalog),
    [layout, leadType, catalog],
  );
  const extras = useMemo(() => extraFormFields(leadType, form, catalog), [leadType, form, catalog]);
  // `renderPropertyLayout` closes with the unplaced properties' "Other" when there are any.
  const hasOther = sections.at(-1)?.id === 'other';
  const shown =
    extras.length > 0 && !hasOther
      ? [...sections, { id: 'other', label: 'Other', properties: [] }]
      : sections;

  return (
    <>
      {shown.map((section, index) => (
        <PropertySection
          // A site may name its own section "other" beside the closing one.
          key={`${index}:${section.id}`}
          label={section.label}
          properties={section.properties}
          extras={index === shown.length - 1 ? extras : []}
          form={form}
          customValues={props.customValues}
          canEdit={props.canEdit}
          canRevealSensitive={props.canRevealSensitive}
          onSave={props.onSave}
        />
      ))}
    </>
  );
}
