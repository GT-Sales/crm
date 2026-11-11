import {
  commissionMinorOf,
  isCalendarDate,
  leadStageLabel,
  leadTypeLabel,
  type LeadExportField,
  type LeadExportValueKind,
} from '@gt-sales/contracts';
import type { BillingPeriod } from '@gt-sales/types';

import type { LeadExportRow } from '../staff-queries.js';

/**
 * One cell of the export, typed so the workbook writes it as what it is: a
 * text cell is never read as a number (a phone, a postal code and an order
 * number keep their zeros and never turn into `6.05E+10`), a date is a real
 * date and a number a number.
 */
export type ExportCell =
  | { type: 'text'; value: string }
  | { type: 'number'; value: number }
  | { type: 'money'; value: number }
  | { type: 'date'; value: Date }
  | { type: 'dateTime'; value: Date }
  | null;

/** The most characters one Excel cell holds. */
const CELL_TEXT_MAX = 32_767;

/** Characters XML 1.0 cannot carry (every control but tab, line feed and carriage return). */
// eslint-disable-next-line no-control-regex
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

/** A phone as people write one: a sign, then only digits, spaces and phone punctuation. */
const SIGNED_PHONE_OR_NUMBER = /^[+-][\d\s().,/-]*(?:\s?(?:ext\.?|x)\s?\d+)?$/i;

/**
 * Customer-written text as a spreadsheet may safely hold it. Every text cell
 * is already written as a string, never a formula; but a file saved on as CSV
 * and opened again would run `=HYPERLINK(…)` or `@SUM(…)`, so a value that
 * starts with `=`, `@`, a tab or a carriage return, or with `+` or `-` and is
 * not just a signed number or a phone, gets a leading apostrophe (the
 * spreadsheet convention for "this is text"). A phone such as
 * `+1 604 555 0100` is left exactly as given.
 */
export function safeSpreadsheetText(value: string): string {
  const cleaned = value.replace(XML_INVALID, '').slice(0, CELL_TEXT_MAX);
  const first = cleaned.charAt(0);
  const risky =
    first === '=' ||
    first === '@' ||
    first === '\t' ||
    first === '\r' ||
    ((first === '+' || first === '-') && !SIGNED_PHONE_OR_NUMBER.test(cleaned));
  return risky ? `'${cleaned}`.slice(0, CELL_TEXT_MAX) : cleaned;
}

const text = (value: string | null | undefined): ExportCell =>
  value === null || value === undefined || value === ''
    ? null
    : { type: 'text', value: safeSpreadsheetText(value) };

const number = (value: number | null | undefined): ExportCell =>
  typeof value === 'number' && Number.isFinite(value) ? { type: 'number', value } : null;

/** Cents as dollars, for a money column. */
const money = (minor: number | null | undefined): ExportCell =>
  typeof minor === 'number' && Number.isFinite(minor)
    ? { type: 'money', value: minor / 100 }
    : null;

/** An ISO instant (`…Z`) as a date-and-time cell, in UTC. */
function instant(value: string | null | undefined): ExportCell {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? text(value) : { type: 'dateTime', value: date };
}

/** A calendar day (`YYYY-MM-DD`) as a date cell: midnight UTC, so no zone can move the day. */
function day(value: string | null | undefined): ExportCell {
  if (!value) return null;
  return isCalendarDate(value)
    ? { type: 'date', value: new Date(`${value}T00:00:00.000Z`) }
    : text(value);
}

const BILLING_PERIOD_LABELS: Record<BillingPeriod, string> = {
  one_time: 'One-time',
  month: 'Monthly',
  '30_days': '30 days',
  '90_days': '90 days',
  year: 'Yearly',
};

const STATUS_LABELS: Record<string, string> = {
  incomplete: 'Incomplete',
  submitted: 'Submitted',
};

export interface CellContext {
  /** Display names of the site's members, by actor id. */
  memberNames: ReadonlyMap<string, string>;
}

/** The assignee as the inbox names one: their chosen name, or that they have left. */
function assignee(actorId: string | null, context: CellContext): ExportCell {
  if (actorId === null) return null;
  return text(context.memberNames.get(actorId) ?? 'Former teammate');
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A stored value as its column's kind writes it; one that does not fit the kind stays text. */
function typed(kind: LeadExportValueKind, raw: unknown): ExportCell {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'boolean') return text(raw ? 'Yes' : 'No');
  if (kind === 'number' && typeof raw === 'number') return number(raw);
  if (kind === 'money' && typeof raw === 'number') return money(raw);
  if (kind === 'date' && typeof raw === 'string') return day(raw);
  if (kind === 'dateTime' && typeof raw === 'string') return instant(raw);
  if (typeof raw === 'string') return text(raw);
  if (typeof raw === 'number') return text(String(raw));
  return null;
}

/** A catalogue property's value on one lead, read from the storage the property names. */
function propertyCell(field: LeadExportField, row: LeadExportRow): ExportCell {
  const property = field.property;
  if (!property) return null;
  const storedKey = property.storageKey ?? property.key;
  const source: unknown =
    property.storage === 'order'
      ? row.order
      : property.storage === 'custom'
        ? row.custom
        : row.form;
  if (!isRecord(source)) return null;
  const raw = Object.hasOwn(source, storedKey) ? source[storedKey] : undefined;

  // The order's plan reads as the name frozen on the order, as the lead page shows it.
  if (property.storage === 'order' && property.key === 'plan') {
    if (row.order?.plan) return text(row.order.plan.name);
  }
  if (property.kind === 'choice' && typeof raw === 'string') {
    const option = property.options?.find((entry) => entry.value === raw);
    if (option) return text(option.label);
    // A form's own label for a value its options no longer list (`planLabel` beside `planId`).
    const labelled =
      property.labelKey && isRecord(row.form) ? row.form[property.labelKey] : undefined;
    return text(typeof labelled === 'string' && labelled !== '' ? labelled : raw);
  }
  return typed(field.kind, raw);
}

/** One lead's value for one export field. A field the row was not read for is empty. */
export function leadExportCell(
  field: LeadExportField,
  row: LeadExportRow,
  context: CellContext,
): ExportCell {
  if (field.property) return propertyCell(field, row);
  const { lead } = row;
  switch (field.key) {
    case 'reference':
      return text(lead.externalRef);
    case 'createdAt':
      return instant(lead.createdAt);
    case 'leadType':
      return text(leadTypeLabel(lead.leadType));
    case 'fullName':
      return text(lead.contact.fullName);
    case 'email':
      return text(lead.contact.email);
    case 'phone':
      return text(lead.contact.phone);
    case 'stage':
      return text(leadStageLabel(lead.leadType, lead.stage));
    case 'status':
      return text(STATUS_LABELS[lead.status] ?? lead.status);
    case 'assignee':
      return assignee(lead.assignedActorId, context);
    case 'planPrice':
      return money(row.order?.plan?.priceMinor);
    case 'planBillingPeriod':
      return text(row.order?.plan ? BILLING_PERIOD_LABELS[row.order.plan.billingPeriod] : null);
    case 'planCommission': {
      const plan = row.order?.plan;
      if (!plan?.commission || !row.order) return null;
      return money(commissionMinorOf(plan.commission, plan.priceMinor, row.order.quantity));
    }
    case 'updatedAt':
      return instant(lead.updatedAt);
    case 'stageChangedAt':
      return instant(row.stageChangedAt);
    case 'lastActivityAt':
      return instant(row.lastActivityAt);
    case 'archivedAt':
      return instant(lead.deletedAt);
    case 'source':
      return text(lead.source);
    case 'utmSource':
      return text(lead.attribution.utmSource);
    case 'utmMedium':
      return text(lead.attribution.utmMedium);
    case 'utmCampaign':
      return text(lead.attribution.utmCampaign);
    case 'utmTerm':
      return text(lead.attribution.utmTerm);
    case 'utmContent':
      return text(lead.attribution.utmContent);
    case 'referrerHost':
      return text(lead.attribution.referrerHost);
    case 'landingPath':
      return text(lead.attribution.landingPath);
    case 'partnerCode':
      return text(lead.attribution.partnerCode);
    case 'openTaskCount':
      return number(lead.openTaskCount);
    // A task is due on a calendar day, stored at noon UTC.
    case 'nextTaskDueAt':
      return day(lead.nextTaskDueAt?.slice(0, 10));
    case 'noteCount':
      return number(row.noteCount);
    default:
      return null;
  }
}
