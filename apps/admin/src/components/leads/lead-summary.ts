import {
  leadStageLabel,
  leadTypeEntry,
  leadTypeLabel,
  type GetWorkspaceLeadResponse,
} from '@gt-sales/contracts';

import { documentLabel } from './lead-documents';
import { formFields, staffFields } from './lead-fields';

type LeadRecordData = Pick<GetWorkspaceLeadResponse, 'lead' | 'documents'>;

/**
 * The lead as plain text, for pasting into a chat or an email to a partner
 * (Get Canada Sim's "Copy Info"): its number and stage, the customer, every
 * answer and staff field as the lead page shows them, and which documents
 * are on file. Only what the page already shows the reader.
 */
export function leadSummaryText({ lead, documents }: LeadRecordData): string {
  const payload = lead.form?.payload ?? {};
  const lines = [
    `${lead.externalRef ?? lead.id} · ${leadTypeLabel(lead.leadType)}`,
    `Stage: ${leadStageLabel(lead.leadType, lead.stage)}`,
    `Received: ${new Date(lead.createdAt).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })}`,
  ];
  if (lead.contact.fullName) lines.push(`Customer: ${lead.contact.fullName}`);
  if (lead.contact.email) lines.push(`Email: ${lead.contact.email}`);
  if (lead.contact.phone) lines.push(`Phone: ${lead.contact.phone}`);
  for (const field of [
    ...formFields(lead.leadType, payload),
    // Staff fields show "—" while empty on the page; a copy leaves them out.
    ...staffFields(lead.leadType, payload).filter((entry) => entry.value !== '—'),
  ]) {
    lines.push(`${field.label}: ${field.value}`);
  }
  if (documents.length > 0) {
    lines.push(
      `Documents: ${documents.map((entry) => documentLabel(entry.documentType)).join(', ')}`,
    );
  }
  lines.push(`Source: ${lead.source}`);
  return lines.join('\n');
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** `Nov 2, 2026` for a calendar day, read in UTC so it never shifts a day. */
function letterDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  return new Date(`${value}T00:00:00Z`).toLocaleDateString('en-CA', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * The website's printable mailer for this order, filled the way the site's
 * own admin fills it (Get Canada Sim's `getDeliveryLetterUrl`), or undefined
 * for a lead type that has none. The page renders from its query and sends
 * nothing anywhere.
 */
export function deliveryLetterUrl({
  lead,
}: Pick<GetWorkspaceLeadResponse, 'lead'>): string | undefined {
  const base = leadTypeEntry(lead.leadType)?.deliveryLetterUrl;
  if (!base) return undefined;
  const payload = lead.form?.payload ?? {};
  const name = lead.contact.fullName?.trim() ?? '';
  const plan = text(payload.planLabel) || text(payload.planId);
  const params = new URLSearchParams({
    first_name: name.split(/\s+/)[0] ?? '',
    recipient_name: name.toUpperCase(),
    address_line1: text(payload.shippingAddress),
    address_line2: '',
    address_line3: '',
    phone: lead.contact.phone ?? '',
    order_id: lead.externalRef ?? '',
    plan_name: plan,
    // The plan's price as its label carries it (`Unlimited Data · $40, Rogers`).
    plan_price: /·\s*(\$\d+(?:\.\d{2})?)/.exec(plan)?.[1] ?? '',
    carrier: /fido/i.test(text(payload.planId)) ? 'Fido · 4G LTE' : 'Rogers · 5G',
    sim_type: payload.delivery === 'esim' ? 'eSIM' : 'Physical SIM',
    billing_email: lead.contact.email ?? '',
    arrival_date: letterDate(payload.arrivalDate),
    canada_address: text(payload.canadaAddress),
  });
  return `${base}?${params.toString()}`;
}
