'use client';

import { useState, type JSX } from 'react';
import { formatPropertyValue, type PropertyValue, type SiteProperty } from '@gt-sales/contracts';
import { Input, NativeSelect, Textarea } from '@gt-sales/ui';

/**
 * One property value, read and edited by its kind. Money is stored as whole
 * cents and entered in dollars; a cleared control reports `null`. Checking a
 * value against its property (`parsePropertyValue`) is the caller's job when
 * it saves.
 */

const SAFE_LINK = /^https?:\/\//i;

/** A stored value as staff read it: a url opens in a new tab, an email starts a mail. */
export function PropertyValueText({
  property,
  value,
}: {
  property: Pick<SiteProperty, 'kind' | 'options'>;
  value: unknown;
}): JSX.Element {
  const text = formatPropertyValue(property, value);
  if (text === '') return <span className="text-muted-foreground">—</span>;
  if (property.kind === 'url' && typeof value === 'string' && SAFE_LINK.test(value)) {
    return (
      <a
        href={value}
        target="_blank"
        rel="noreferrer noopener"
        className="text-foreground underline-offset-2 hover:underline"
      >
        {text}
      </a>
    );
  }
  if (property.kind === 'email' && typeof value === 'string' && value.includes('@')) {
    return (
      <a href={`mailto:${value}`} className="text-foreground underline-offset-2 hover:underline">
        {text}
      </a>
    );
  }
  return <span>{text}</span>;
}

const MONEY = /^(-?)(\d+)(?:\.(\d{0,2}))?$/;

/** What a number draft holds: a value, nothing (`null`), or not a number yet. */
function parseNumberDraft(
  text: string,
  mode: 'number' | 'money' | 'count',
): number | null | 'invalid' {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (mode === 'money') {
    const match = MONEY.exec(trimmed);
    if (!match) return 'invalid';
    const cents = Number(match[2]) * 100 + Number((match[3] ?? '').padEnd(2, '0'));
    return match[1] === '-' ? -cents : cents;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return 'invalid';
  if (mode === 'count' && (!Number.isInteger(parsed) || parsed < 0)) return 'invalid';
  return parsed;
}

/** Dollars as staff type them (`19.99`) in whole cents, or undefined when it is not an amount. */
export function dollarsToCents(text: string): number | undefined {
  const cents = parseNumberDraft(text, 'money');
  return typeof cents === 'number' ? cents : undefined;
}

function numberText(value: PropertyValue | undefined, mode: 'number' | 'money' | 'count') {
  if (typeof value !== 'number') return '';
  return mode === 'money' ? (value / 100).toFixed(2) : String(value);
}

function NumberControl({
  id,
  mode,
  value,
  disabled,
  onChange,
}: {
  id: string;
  mode: 'number' | 'money' | 'count';
  value: PropertyValue | undefined;
  disabled?: boolean;
  onChange(value: PropertyValue | null): void;
}) {
  // The draft keeps what staff type ("12." on the way to "12.50"); a value
  // changed from outside replaces it, the draft's own echo does not.
  const [text, setText] = useState(() => numberText(value, mode));
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    const drafted = parseNumberDraft(text, mode);
    if ((drafted === null ? undefined : drafted) !== value) setText(numberText(value, mode));
  }
  return (
    <Input
      id={id}
      type="number"
      inputMode={mode === 'count' ? 'numeric' : 'decimal'}
      step={mode === 'money' ? 0.01 : mode === 'count' ? 1 : 'any'}
      min={mode === 'count' ? 0 : undefined}
      disabled={disabled}
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        const parsed = parseNumberDraft(event.target.value, mode);
        if (parsed !== 'invalid') onChange(parsed);
      }}
    />
  );
}

/** `YYYY-MM-DDTHH:mm` in the viewer's time for an ISO instant, for a datetime-local input. */
function localDateTime(value: PropertyValue | undefined): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return '';
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

const TEXT_INPUT_TYPE = { text: 'text', email: 'email', phone: 'tel', url: 'url' } as const;
const TEXT_MAX_LENGTH = { text: 200, email: 254, phone: 32, url: 2048 } as const;

/** A typed control for one property's value; label it with a `<label htmlFor={id}>`. */
export function PropertyValueControl({
  property,
  value,
  onChange,
  disabled,
  id,
}: {
  property: SiteProperty;
  value: PropertyValue | undefined;
  onChange(value: PropertyValue | null): void;
  disabled?: boolean;
  id: string;
}): JSX.Element {
  const textOf = (raw: string) => (raw === '' ? null : raw);
  switch (property.kind) {
    case 'number':
    case 'money':
    case 'count':
      return (
        <NumberControl
          id={id}
          mode={property.kind}
          value={value}
          disabled={disabled}
          onChange={onChange}
        />
      );
    case 'date':
      return (
        <Input
          id={id}
          type="date"
          disabled={disabled}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(textOf(event.target.value))}
        />
      );
    case 'dateTime':
      return (
        <Input
          id={id}
          type="datetime-local"
          disabled={disabled}
          value={localDateTime(value)}
          onChange={(event) => {
            const raw = event.target.value;
            if (raw === '') onChange(null);
            else if (!Number.isNaN(Date.parse(raw))) onChange(new Date(raw).toISOString());
          }}
        />
      );
    case 'yesNo':
      return (
        <NativeSelect
          id={id}
          disabled={disabled}
          value={typeof value === 'boolean' ? String(value) : ''}
          onChange={(event) =>
            onChange(event.target.value === '' ? null : event.target.value === 'true')
          }
        >
          <option value="">—</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </NativeSelect>
      );
    case 'choice': {
      const options = property.options ?? [];
      const current = typeof value === 'string' ? value : '';
      const known = options.some((option) => option.value === current);
      return (
        <NativeSelect
          id={id}
          disabled={disabled}
          value={current}
          onChange={(event) => onChange(textOf(event.target.value))}
        >
          <option value="">—</option>
          {options
            // A retired option stays only on a lead that holds it.
            .filter((option) => !option.hidden || option.value === current)
            .map((option) => (
              <option key={option.value} value={option.value}>
                {option.hidden ? `${option.label} (retired)` : option.label}
              </option>
            ))}
          {current !== '' && !known ? <option value={current}>{current}</option> : null}
        </NativeSelect>
      );
    }
    case 'longText':
      return (
        <Textarea
          id={id}
          disabled={disabled}
          maxLength={property.maxLength ?? 4000}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(textOf(event.target.value))}
        />
      );
    case 'text':
    case 'email':
    case 'phone':
    case 'url':
      return (
        <Input
          id={id}
          type={TEXT_INPUT_TYPE[property.kind]}
          disabled={disabled}
          maxLength={property.maxLength ?? TEXT_MAX_LENGTH[property.kind]}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(textOf(event.target.value))}
        />
      );
  }
}
