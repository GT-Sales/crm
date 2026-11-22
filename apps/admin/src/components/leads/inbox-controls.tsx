'use client';

import { type ReactNode } from 'react';
import {
  type AssignableMember,
  type FilterableLeadProperty,
  type LeadFieldOption,
} from '@gt-sales/contracts';
import { cn } from '@gt-sales/ui';
import { XIcon } from 'lucide-react';
import { memberName } from '../../lib/people';

/**
 * The small controls the leads inbox's toolbar and menus are made of: the
 * type tabs and their counts, an applied filter's chip, a menu's checkbox
 * row, and how a new property filter's draft starts.
 */

/** Compact icon controls in the inbox header; their panels hold all view settings. */
// An icon on narrow screens; from `xl` the button says what it is.
export const TOOLBAR_BUTTON =
  'relative h-8 w-8 shrink-0 gap-1.5 rounded-full p-0 xl:w-auto xl:px-3';
export const TOOLBAR_LABEL = 'hidden text-xs font-normal xl:inline';
export const TOOLBAR_ICON = 'size-3.5 text-muted-foreground';

export function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors',
        active
          ? 'border-primary font-medium text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

export function Count({ value }: { value: number | undefined }) {
  if (value === undefined) return null;
  return (
    <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground tabular-nums">
      {value}
    </span>
  );
}

/** A choice option the site no longer offers for new values (it still finds old leads). */
function isRetired(option: LeadFieldOption): boolean {
  return 'hidden' in option && option.hidden === true;
}

/** The option a new filter starts on: the first one still offered. */
function firstOfferedOption(prop: FilterableLeadProperty): LeadFieldOption | undefined {
  return prop.options?.find((option) => !isRetired(option)) ?? prop.options?.[0];
}

export function defaultDraftValueFor(prop: FilterableLeadProperty | undefined): string {
  if (!prop) return '';
  if (prop.kind === 'choice') return firstOfferedOption(prop)?.value ?? '';
  if (prop.kind === 'yesNo') return 'true';
  return '';
}

export function defaultDraftMultiFor(prop: FilterableLeadProperty): string[] {
  const first = firstOfferedOption(prop);
  return first ? [first.value] : [];
}

/** A choice option as the filter offers it, a retired one marked. */
export function optionLabel(option: LeadFieldOption): string {
  return isRetired(option) ? `${option.label} (retired)` : option.label;
}

/**
 * One applied filter, "Field: value ×", in the CRM chip style. Its button
 * names the filter whole ("Remove filter Stage: New"), so two filters on one
 * property are told apart.
 */
export function ActiveFilterChip({
  label,
  value,
  onRemove,
}: {
  label: string;
  value: string;
  onRemove(): void;
}) {
  return (
    <span className="inline-flex h-6 max-w-full items-center gap-1 rounded-[4px] border border-crm-chip-border bg-crm-chip pr-0.5 pl-2 text-[12px] text-crm-chip-foreground">
      <span className="shrink-0 font-medium">{label}:</span>
      <span className="min-w-0 truncate">{value}</span>
      <button
        type="button"
        aria-label={`Remove filter ${label}: ${value}`}
        title={`Remove filter ${label}: ${value}`}
        className="grid size-5 shrink-0 place-items-center rounded-[3px] outline-none hover:bg-crm-chip-border/50 focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onRemove}
      >
        <XIcon aria-hidden="true" className="size-3" />
      </button>
    </span>
  );
}

/** An assignee filter as the chip names it: `Me`, `Unassigned` or the member. */
export function assigneeFilterWords(value: string, members: readonly AssignableMember[]): string {
  if (value === 'me') return 'Me';
  if (value === 'none') return 'Unassigned';
  const member = members.find((entry) => entry.actorId === value);
  return member ? memberName(member) : 'A teammate';
}

/** One checkbox row of a menu panel, labelled by its text. */
export function CheckRow({
  id,
  label,
  checked,
  disabled,
  onToggle,
}: {
  id: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onToggle(): void;
}) {
  return (
    <button
      type="button"
      id={id}
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        'inline-flex min-h-7 max-w-full items-center rounded-full border px-2.5 py-1 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
        checked
          ? 'border-border bg-muted text-foreground'
          : 'border-border/50 text-muted-foreground hover:bg-accent',
      )}
    >
      <span className="truncate">{label}</span>
    </button>
  );
}
