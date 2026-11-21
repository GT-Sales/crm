'use client';

import { useEffect, useState, type FormEvent } from 'react';
import {
  type GetWorkspaceLeadResponse,
  type LeadContactEdit,
  type LeadContactExpected,
} from '@gt-sales/contracts';
import { Button, Input } from '@gt-sales/ui';

const CONTACT_FIELDS = ['fullName', 'email', 'phone'] as const;
type ContactField = (typeof CONTACT_FIELDS)[number];
const CONTACT_FIELD_WORDS: Record<ContactField, string> = {
  fullName: 'name',
  email: 'email',
  phone: 'phone',
};

/** The sentence a contact save refused as stale shows: which fields, and that the typing is kept. */
export function contactConflictText(fields: readonly string[]): string {
  const named = CONTACT_FIELDS.filter((field) => fields.includes(field)).map(
    (field) => CONTACT_FIELD_WORDS[field],
  );
  const what = named.length > 0 ? `the ${named.join(' and ')}` : 'this contact';
  return `Someone else changed ${what} while you were editing. What you typed is kept: check it against the saved value and save again.`;
}

type ContactValues = Record<ContactField, string>;
type LeadContactValues = GetWorkspaceLeadResponse['lead']['contact'];

function contactValues(contact: LeadContactValues): ContactValues {
  return {
    fullName: contact.fullName ?? '',
    email: contact.email ?? '',
    phone: contact.phone ?? '',
  };
}

/**
 * Edits the lead's name, email and phone (#89). A save sends only the fields
 * staff changed, each with the value it was compared against
 * (`expectedContact`), so the backend refuses it if someone else changed that
 * field meanwhile. A record reload while the editor is open moves the fields
 * staff did not touch to the new values; a touched field keeps what was typed
 * and says what is saved now, and its next save is compared to that.
 */
export function ContactEditor({
  contact,
  saving,
  onSave,
  onCancel,
}: {
  contact: LeadContactValues;
  saving: boolean;
  onSave(edit: LeadContactEdit, expected: LeadContactExpected): void;
  onCancel(): void;
}) {
  const [values, setValues] = useState<ContactValues>(() => contactValues(contact));
  // What each field was when the editor opened, or the latest saved value seen since.
  const [base, setBase] = useState<ContactValues>(() => contactValues(contact));
  // A touched field someone else changed: the value saved now.
  const [elsewhere, setElsewhere] = useState<Partial<ContactValues>>({});
  const { fullName, email, phone } = contact;

  useEffect(() => {
    const saved = contactValues({ fullName, email, phone });
    const moved = CONTACT_FIELDS.filter((field) => base[field] !== saved[field]);
    if (moved.length === 0) return;
    const untouched = moved.filter((field) => values[field] === base[field]);
    const touched = moved.filter((field) => values[field] !== base[field]);
    setValues((typed) => ({
      ...typed,
      ...Object.fromEntries(untouched.map((field) => [field, saved[field]])),
    }));
    setElsewhere((notices) => ({
      ...notices,
      ...Object.fromEntries(touched.map((field) => [field, saved[field]])),
    }));
    setBase(saved);
    // Only a new saved value re-bases the editor; typing never does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullName, email, phone]);

  function change(field: ContactField, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const edit: LeadContactEdit = {};
    const expected: LeadContactExpected = {};
    for (const field of CONTACT_FIELDS) {
      const value = values[field].trim();
      if (!value || value === base[field]) continue;
      edit[field] = value;
      expected[field] = base[field] === '' ? null : base[field];
    }
    if (Object.keys(edit).length === 0) onCancel();
    else onSave(edit, expected);
  }

  /** The saved value of a touched field someone else changed, while it differs from the typing. */
  function notice(field: ContactField) {
    const saved = elsewhere[field];
    if (saved === undefined || saved === values[field]) return null;
    return (
      <p className="-mt-1 text-xs text-amber-700 dark:text-amber-400">
        Now saved as: {saved === '' ? '(empty)' : saved}
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <label className="text-xs text-muted-foreground">
        Name
        <Input
          value={values.fullName}
          onChange={(event) => change('fullName', event.target.value)}
          maxLength={160}
        />
      </label>
      {notice('fullName')}
      <label className="text-xs text-muted-foreground">
        Email
        <Input
          type="email"
          value={values.email}
          onChange={(event) => change('email', event.target.value)}
          maxLength={254}
        />
      </label>
      {notice('email')}
      <label className="text-xs text-muted-foreground">
        Phone
        <Input
          type="tel"
          value={values.phone}
          onChange={(event) => change('phone', event.target.value)}
          maxLength={40}
        />
      </label>
      {notice('phone')}
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
