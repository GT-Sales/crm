'use client';

import { useState, type FormEvent } from 'react';
import type { LeadFieldDefinition, LeadFormEdit } from '@gt-sales/contracts';
import { Button, Input, NativeSelect, Textarea } from '@gt-sales/ui';

type Draft = Record<string, string>;

/** The editor's text for a stored value: yes/no as `yes`/`no`, an empty field as ''. */
function draftValue(definition: LeadFieldDefinition, value: unknown): string {
  if (definition.kind === 'yesNo') return value === true ? 'yes' : value === false ? 'no' : '';
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' ? value : '';
}

/** The value the backend stores for the editor's text; null clears the field. */
function editValue(
  definition: LeadFieldDefinition,
  draft: string,
): string | number | boolean | null {
  if (draft.trim() === '') return null;
  if (definition.kind === 'yesNo') return draft === 'yes';
  if (definition.kind === 'count') return Number(draft);
  return draft;
}

/**
 * Corrects a lead's form fields in place: one input per editable field, by
 * its kind. Saves only what changed, as the field's new value or null to
 * clear it; the backend checks every value again against the definitions.
 */
export function LeadFormEditor({
  fields,
  payload,
  saving,
  onSave,
  onCancel,
}: {
  fields: readonly LeadFieldDefinition[];
  payload: Readonly<Record<string, unknown>>;
  saving: boolean;
  onSave(edit: LeadFormEdit): void;
  onCancel(): void;
}) {
  const [draft, setDraft] = useState<Draft>(() =>
    Object.fromEntries(fields.map((field) => [field.key, draftValue(field, payload[field.key])])),
  );

  function submit(event: FormEvent) {
    event.preventDefault();
    const edit: LeadFormEdit = {};
    for (const field of fields) {
      const next = draft[field.key] ?? '';
      if (next.trim() === draftValue(field, payload[field.key]).trim()) continue;
      edit[field.key] = editValue(field, next);
    }
    if (Object.keys(edit).length === 0) onCancel();
    else onSave(edit);
  }

  const set = (key: string, value: string) => setDraft((current) => ({ ...current, [key]: value }));

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      {fields.map((field) => {
        const value = draft[field.key] ?? '';
        const id = `field-${field.key}`;
        return (
          <label key={field.key} htmlFor={id} className="text-xs text-muted-foreground">
            {field.label}
            {field.kind === 'choice' ? (
              <NativeSelect
                id={id}
                value={value}
                onChange={(event) => set(field.key, event.target.value)}
              >
                <option value="">—</option>
                {/* A stored value no longer offered (a retired plan) stays selectable as it is. */}
                {value && !field.options?.some((option) => option.value === value) ? (
                  <option value={value}>{value}</option>
                ) : null}
                {field.options?.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </NativeSelect>
            ) : field.kind === 'yesNo' ? (
              <NativeSelect
                id={id}
                value={value}
                onChange={(event) => set(field.key, event.target.value)}
              >
                <option value="">Not answered</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </NativeSelect>
            ) : field.kind === 'longText' ? (
              <Textarea
                id={id}
                value={value}
                maxLength={field.maxLength}
                rows={3}
                onChange={(event) => set(field.key, event.target.value)}
              />
            ) : (
              <Input
                id={id}
                type={field.kind === 'date' ? 'date' : field.kind === 'count' ? 'number' : 'text'}
                value={value}
                maxLength={field.kind === 'text' ? field.maxLength : undefined}
                onChange={(event) => set(field.key, event.target.value)}
              />
            )}
          </label>
        );
      })}
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
