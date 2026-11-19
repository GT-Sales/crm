import {
  CUSTOMER_MAIL_ACTOR_ID,
  emailTemplateLabel,
  leadStageLabel,
  type LeadActivity,
  type LeadDetail,
  type LeadDocument,
  type PropertyCatalog,
  type SiteProperty,
  type StaffChangeRequest,
} from '@gt-sales/contracts';

import {
  DISPLAY_NAME_MAX,
  LABEL_MAX,
  LEAD_DETAILS_MAX,
  LEAD_DOCUMENTS_MAX,
  LONG_VALUE_MAX,
  activityKindWords,
  type ActivityProjection,
  type ChangeRequestProjection,
  type DocumentProjection,
  type LeadDetailsProjection,
  type LeadValueProjection,
} from './projections.js';
import { inertRecordLines, inertRecordText } from './record-text.js';

/**
 * A lead's page, as Ask AI may hand it to the model (C11).
 *
 * The input is exactly what the staff lead route reads (`selectLeadWithWork`);
 * the output keeps what a member who sees the lead page sees there, minus what
 * never goes to the AI provider: contact email, phone and address, hidden and
 * sensitive catalogue properties, documents' files, ids and links, mail and
 * reply bodies, tracking and activation numbers, a change request's values,
 * and raw ids. Every string a person typed is cleaned and bounded here.
 */

/**
 * Form properties that hold where a customer lives or a number that reaches
 * them. Their kind is `text` or `longText` in the catalogue, so the kind rule
 * alone would let them through; they are named here, once.
 */
const ADDRESS_OR_NUMBER_KEYS: ReadonlySet<string> = new Set([
  'streetAddress',
  'aptUnit',
  'city',
  'postalCode',
  'shippingAddress',
  'canadaAddress',
  'simNumber',
  // An id the person has no use for; the plan's name travels instead.
  'planId',
]);

/**
 * The one rule for a property's value reaching the model: the site shows it
 * (not hidden), it is not sensitive, and it is not a way to reach or find
 * the customer (an email, a phone, an address).
 */
export function isModelVisibleProperty(property: SiteProperty): boolean {
  return (
    !property.hidden &&
    !property.sensitive &&
    property.kind !== 'email' &&
    property.kind !== 'phone' &&
    !ADDRESS_OR_NUMBER_KEYS.has(property.key)
  );
}

const CONTACT_FIELD_LABELS: Readonly<Record<string, string>> = {
  fullName: 'Name',
  email: 'Email',
  phone: 'Phone',
  countryCode: 'Country code',
  planId: 'Plan',
};

function fieldLabel(key: string, catalog: PropertyCatalog): string {
  return (
    CONTACT_FIELD_LABELS[key] ??
    inertRecordText(catalog.get(key)?.label ?? null, LABEL_MAX) ??
    inertRecordText(key, LABEL_MAX) ??
    'field'
  );
}

const SYSTEM_EVENT_WORDS: Readonly<Record<string, string>> = {
  trashed: 'archived',
  restored: 'restored',
  opened: 'opened',
  submitted: 'submitted',
  customer_emailed: 'email sent',
  customer_replied: 'customer replied',
  change_requested: 'change requested',
  change_approved: 'change approved',
  change_rejected: 'change rejected',
  documents_override: 'documents override',
  unknown: 'system event',
};

export interface TimelineContext {
  readonly leadType: string;
  readonly catalog: PropertyCatalog;
  /** Display names of the site's members by actor id (null: no name set). */
  readonly names: ReadonlyMap<string, string | null>;
  /** Entries of an older kind (`call`, `email`, `merge`) by id, named by that kind. */
  readonly legacyKinds?: ReadonlyMap<string, string>;
}

function nameOf(actorId: string | null, names: TimelineContext['names']): string | null {
  if (actorId === null) return null;
  return inertRecordText(names.get(actorId) ?? 'A former member', DISPLAY_NAME_MAX);
}

/** Who made an entry, in words; absent when it was neither a member, a flow nor the customer. */
function byOf(entry: LeadActivity, names: TimelineContext['names']): string | undefined {
  if (entry.actorId === CUSTOMER_MAIL_ACTOR_ID) return 'Customer';
  if (entry.automation !== undefined) return 'Automation';
  if (!names.has(entry.actorId)) return undefined;
  return nameOf(entry.actorId, names) ?? undefined;
}

/**
 * One timeline entry with its meaning: a move's stages, an assignment's
 * names, an edit's field labels, a mail's template and how it went, a
 * review's document type and decision. Notes are left to the bounded notes
 * read; a mail's subject and words and a customer's reply never appear.
 */
export function projectTimelineEntry(
  entry: LeadActivity,
  context: TimelineContext,
): ActivityProjection | undefined {
  if (entry.kind === 'note') return undefined;
  const by = byOf(entry, context.names);
  const automation = inertRecordText(entry.automationName ?? entry.automation ?? null, LABEL_MAX);
  const legacy = context.legacyKinds?.get(entry.id);
  if (legacy !== undefined)
    return {
      kind: activityKindWords(legacy),
      at: entry.createdAt,
      ...(by === undefined ? {} : { by }),
    };
  const base = {
    kind: activityKindWords(entry.kind),
    at: entry.createdAt,
    ...(by === undefined ? {} : { by }),
    ...(automation === null ? {} : { automation }),
    ...(entry.viaAi === true ? { viaAi: true as const } : {}),
  };
  switch (entry.kind) {
    case 'status_change':
      return {
        ...base,
        from: inertRecordText(leadStageLabel(context.leadType, entry.from), DISPLAY_NAME_MAX),
        to: inertRecordText(leadStageLabel(context.leadType, entry.to), DISPLAY_NAME_MAX),
      };
    case 'assignment':
      return {
        ...base,
        from: nameOf(entry.from, context.names),
        to: nameOf(entry.to, context.names),
      };
    case 'edit':
      return {
        ...base,
        fields: entry.fields.slice(0, 20).map((key) => fieldLabel(key, context.catalog)),
      };
    case 'document':
      return { ...base, documentType: entry.documentType, decision: entry.decision };
    case 'system': {
      const event = SYSTEM_EVENT_WORDS[entry.event] ?? 'system event';
      const template =
        entry.template === undefined
          ? null
          : inertRecordText(emailTemplateLabel(entry.template, entry.templateName), LABEL_MAX);
      const documents = entry.event === 'documents_override' ? entry.missing : entry.documents;
      return {
        ...base,
        event,
        ...(entry.event === 'customer_emailed' && template !== null ? { template } : {}),
        ...(entry.event === 'customer_emailed' && entry.mailStatus !== undefined
          ? { mailStatus: entry.mailStatus }
          : {}),
        ...(entry.fields === undefined || entry.fields.length === 0
          ? {}
          : { fields: entry.fields.slice(0, 20).map((key) => fieldLabel(key, context.catalog)) }),
        ...(documents === undefined || documents.length === 0
          ? {}
          : { documents: documents.slice(0, 16) }),
        ...(entry.requestNo === undefined ? {} : { requestNo: entry.requestNo }),
      };
    }
  }
}

/** A lead's current documents: type, review state and dates, never the file. */
export function projectDocuments(documents: readonly LeadDocument[]): DocumentProjection[] {
  return documents.slice(0, LEAD_DOCUMENTS_MAX).map((document) => ({
    documentType: document.documentType,
    status: document.review?.decision ?? 'to_review',
    uploadedAt: document.createdAt,
    reviewedAt: document.review?.at ?? null,
  }));
}

/** Whether a change request waits, since when and its number; never what it asks for. */
export function projectChangeRequest(request: StaffChangeRequest | null): ChangeRequestProjection {
  return request === null
    ? { waiting: false }
    : { waiting: true, since: request.updatedAt, requestNo: request.requestNo };
}

/** A single-line value is cut to this many code points. */
const TEXT_VALUE_MAX = 200;

function plainValue(
  raw: unknown,
  property: SiteProperty,
): { value: string | number | boolean; valueLabel?: string } | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? { value: raw } : undefined;
  if (typeof raw === 'boolean') return { value: raw };
  if (typeof raw !== 'string') return undefined;
  const value =
    property.kind === 'longText'
      ? inertRecordLines(raw, LONG_VALUE_MAX)
      : inertRecordText(raw, TEXT_VALUE_MAX);
  if (value === null) return undefined;
  const option = property.options?.find((entry) => entry.value === raw);
  const valueLabel = option === undefined ? null : inertRecordText(option.label, LABEL_MAX);
  return { value, ...(valueLabel === null ? {} : { valueLabel }) };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A lead's form and custom values through the site's catalogue (C11): a value
 * is kept only when `isModelVisibleProperty` allows its property, in the
 * order the record page shows them, at most `LEAD_DETAILS_MAX`. `withheld`
 * says how many stored values the rule (or that cap) kept back, so the model can say some
 * details are only on the lead page. The order travels in the summary's own
 * `order` projection, never here.
 */
export function projectLeadValues(
  lead: LeadDetail,
  catalog: PropertyCatalog,
): LeadDetailsProjection {
  const form = isRecord(lead.form?.payload) ? lead.form.payload : {};
  const custom: Record<string, unknown> = lead.customValues ?? {};
  const shown = new Map(catalog.forType(lead.leadType).map((property) => [property.key, property]));
  const values: LeadValueProjection[] = [];
  let withheld = 0;
  for (const property of catalog.all) {
    if (property.storage !== 'form' && property.storage !== 'custom') continue;
    if (property.leadTypes.length > 0 && !property.leadTypes.includes(lead.leadType)) continue;
    const source = property.storage === 'form' ? form : custom;
    const storedKey = property.storageKey ?? property.key;
    if (!Object.hasOwn(source, storedKey)) continue;
    const typed = shown.get(property.key) ?? property;
    if (!isModelVisibleProperty(typed)) {
      withheld += 1;
      continue;
    }
    const plain = plainValue(source[storedKey], typed);
    if (plain === undefined) continue;
    if (values.length >= LEAD_DETAILS_MAX) {
      withheld += 1;
      continue;
    }
    values.push({
      key: property.key,
      label: inertRecordText(typed.label, LABEL_MAX) ?? property.key,
      source: property.storage,
      ...plain,
    });
  }
  // Rule order: the record page's order for the type, so the list reads as the page does.
  const position = new Map([...shown.keys()].map((key, index) => [key, index]));
  values.sort(
    (a, b) =>
      (position.get(a.key) ?? Number.MAX_SAFE_INTEGER) -
      (position.get(b.key) ?? Number.MAX_SAFE_INTEGER),
  );
  return { values, withheld };
}
