'use client';

import {
  leadCountdownField,
  leadTypeEntry,
  type LeadDocument,
  type LeadOrder,
  type LeadTask,
} from '@gt-sales/contracts';
import { AlertCircleIcon, CalendarClockIcon, FileWarningIcon, ListTodoIcon } from 'lucide-react';
import { cn } from '@gt-sales/ui';
import type { JSX } from 'react';

import { countdown, dayLabel, daysFromToday, dueDay } from '../../lib/dates';
import { documentTypeLabel } from '../plans/document-types';

/** The cards the strip can take staff to. */
export type LeadAttentionTarget = 'change-request' | 'documents' | 'tasks' | 'order';

export interface LeadAttentionItem {
  readonly key: string;
  readonly label: string;
  readonly target: LeadAttentionTarget;
  readonly tone: 'urgent' | 'warning';
}

const listOf = (keys: readonly string[]) =>
  keys.map((key) => documentTypeLabel(key).toLowerCase()).join(', ');

const capitalized = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/**
 * What on this lead is waiting on staff, most pressing first: a customer's
 * change request, documents that are missing, rejected or not yet reviewed
 * (against the frozen plan's required list), overdue follow-ups, and an
 * arrival close at hand for an order not yet dispatched. Pure, so the rules
 * are tested apart from the page. An archived lead asks for nothing.
 */
export function leadAttention(input: {
  readonly lead: {
    readonly leadType: string;
    readonly stage: string;
    readonly deletedAt: string | null;
    readonly order?: Pick<LeadOrder, 'plan' | 'dispatchedAt'> | undefined;
  };
  readonly formPayload: Readonly<Record<string, unknown>>;
  readonly documents: readonly LeadDocument[];
  readonly tasks: readonly LeadTask[];
  readonly changeRequestNo?: number | undefined;
  /** Whether this member sees the customer's details: requests and tasks are theirs. */
  readonly contacts: boolean;
  readonly now?: Date;
}): LeadAttentionItem[] {
  const { lead, documents, contacts } = input;
  const now = input.now ?? new Date();
  if (lead.deletedAt !== null) return [];
  const items: LeadAttentionItem[] = [];

  if (contacts && input.changeRequestNo !== undefined) {
    items.push({
      key: 'change-request',
      label: `Change request #${input.changeRequestNo} waiting`,
      target: 'change-request',
      tone: 'urgent',
    });
  }

  const required = lead.order?.plan?.requiredDocuments ?? [];
  const present = new Set(documents.map((document) => document.documentType));
  const missing = required.filter((key) => !present.has(key));
  const rejected = documents
    .filter((document) => document.review?.decision === 'rejected')
    .map((document) => document.documentType);
  const unreviewed = documents
    .filter((document) => document.review === null)
    .map((document) => document.documentType);
  if (missing.length > 0)
    items.push({
      key: 'documents-missing',
      label: `Missing: ${listOf(missing)}`,
      target: 'documents',
      tone: 'urgent',
    });
  if (rejected.length > 0)
    items.push({
      key: 'documents-rejected',
      label: `Rejected, needs a new upload: ${listOf(rejected)}`,
      target: 'documents',
      tone: 'warning',
    });
  if (unreviewed.length > 0)
    items.push({
      key: 'documents-unreviewed',
      label: `${capitalized(listOf(unreviewed))} not reviewed`,
      target: 'documents',
      tone: 'warning',
    });

  if (contacts) {
    const overdue = input.tasks.filter(
      (task) => task.status === 'open' && task.dueAt && daysFromToday(dueDay(task.dueAt), now) < 0,
    ).length;
    if (overdue > 0)
      items.push({
        key: 'tasks-overdue',
        label: `${overdue} ${overdue === 1 ? 'task' : 'tasks'} overdue`,
        target: 'tasks',
        tone: 'urgent',
      });
  }

  // An arrival matters until the order is on its way, and never for one that
  // is finished or lost.
  const field = leadCountdownField(lead.leadType);
  const day = field ? input.formPayload[field.key] : undefined;
  const outcomes = leadTypeEntry(lead.leadType)?.outcomes;
  const settled = [...(outcomes?.done.stages ?? []), ...(outcomes?.lost.stages ?? [])];
  if (
    field &&
    typeof day === 'string' &&
    !lead.order?.dispatchedAt &&
    !settled.includes(lead.stage)
  ) {
    const left = countdown(day, now);
    if (left && left.tone !== 'upcoming')
      items.push({
        key: 'arrival',
        label: `${field.label} ${left.tone === 'today' ? 'today' : `${dayLabel(day, now)} (${left.label})`}, not dispatched`,
        target: 'order',
        tone: left.tone === 'today' ? 'urgent' : 'warning',
      });
  }

  return items;
}

const ICONS: Record<LeadAttentionTarget, typeof AlertCircleIcon> = {
  'change-request': AlertCircleIcon,
  documents: FileWarningIcon,
  tasks: ListTodoIcon,
  order: CalendarClockIcon,
};

/**
 * The strip under a lead's header: each waiting item is a button that takes
 * staff to the card where it is done. Nothing is rendered when nothing waits.
 */
export function LeadAttentionStrip({
  items,
  onJump,
}: {
  items: readonly LeadAttentionItem[];
  onJump(target: LeadAttentionTarget): void;
}): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <section
      aria-label="Needs attention"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2"
    >
      <span className="text-xs font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-200">
        Needs attention
      </span>
      {items.map((item) => {
        const Icon = ICONS[item.target];
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => onJump(item.target)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              item.tone === 'urgent'
                ? 'border-rose-500/40 bg-rose-500/10 text-rose-800 hover:bg-rose-500/20 dark:text-rose-200'
                : 'border-amber-500/40 bg-amber-500/10 text-amber-900 hover:bg-amber-500/20 dark:text-amber-100',
            )}
          >
            <Icon className="size-3.5" aria-hidden="true" />
            {item.label}
          </button>
        );
      })}
    </section>
  );
}
