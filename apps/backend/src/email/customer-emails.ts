import { leadFields, type CustomerEmailTemplate } from '@gt-sales/contracts';
import { z } from 'zod';

/** What a customer mail is made from: the lead as it stands when staff send it. */
export interface CustomerEmailLead {
  leadType: string;
  fullName: string | null;
  email: string | null;
  externalRef: string | null;
  form: Readonly<Record<string, unknown>>;
}

export type CustomerEmailDraft =
  | {
      ok: true;
      jobType: 'lead_sim_number_email';
      toAddress: string;
      reference?: string;
      variables: Record<string, string>;
    }
  | { ok: false; missing: 'email' | 'simNumber' };

/** As Get Canada Sim's own mail names them; `pickup` is its mailed physical SIM. */
const DELIVERY_LABELS: Readonly<Record<string, string>> = {
  esim: 'Instant eSIM (delivered by email)',
  pickup: 'Physical SIM (shipped to your address)',
};

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** `Monday, November 2, 2026`, the old admin's arrival wording; nothing for a non-date. */
function arrivalLabel(value: unknown): string | undefined {
  if (typeof value !== 'string' || !z.iso.date().safeParse(value).success) return undefined;
  return new Date(`${value}T12:00:00Z`).toLocaleDateString('en-CA', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function planLabel(form: Readonly<Record<string, unknown>>): string | undefined {
  const stored = text(form.planLabel);
  if (stored) return stored;
  const plan = leadFields('sim_order').find((field) => field.key === 'planId');
  return plan?.options?.find((option) => option.value === form.planId)?.label;
}

/**
 * The mail `template` makes of this lead, or the field it still lacks. Only
 * small, display-ready values travel to the outbox: the address, the
 * website's number for the order and the template's variables.
 */
export function draftCustomerEmail(
  template: CustomerEmailTemplate,
  lead: CustomerEmailLead,
  site: { siteUrl?: string },
): CustomerEmailDraft {
  switch (template) {
    case 'sim_number_ready': {
      const simNumber = lead.leadType === 'sim_order' ? text(lead.form.simNumber) : undefined;
      if (!simNumber) return { ok: false, missing: 'simNumber' };
      const email = z.email().safeParse(lead.email?.trim());
      if (!email.success) return { ok: false, missing: 'email' };

      const variables: Record<string, string> = { simNumber };
      const firstName = lead.fullName?.trim().split(/\s+/)[0];
      if (firstName) variables.firstName = firstName;
      const plan = planLabel(lead.form);
      if (plan) variables.planLabel = plan;
      const delivery =
        typeof lead.form.delivery === 'string' ? DELIVERY_LABELS[lead.form.delivery] : undefined;
      if (delivery) variables.delivery = delivery;
      const arrival = arrivalLabel(lead.form.arrivalDate);
      if (arrival) variables.arrival = arrival;
      if (site.siteUrl) variables.trackUrl = `${site.siteUrl}/track`;
      return {
        ok: true,
        jobType: 'lead_sim_number_email',
        toAddress: email.data,
        reference: text(lead.externalRef),
        variables,
      };
    }
  }
}
