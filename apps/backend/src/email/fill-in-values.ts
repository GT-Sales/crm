import {
  EMAIL_FILL_IN_KEYS,
  type EmailFillInKey,
  type LeadOrder,
  type PlanSnapshot,
} from '@gt-sales/contracts';

import type { FillInValues } from './layout.js';

/**
 * What a customer mail's fill-ins are replaced with: from a lead (its form,
 * its name and its order details) or, for a preview or a test send, samples.
 * A value the lead does not have is left out, so the layout reports it
 * missing; `code` (the one-time tracking code) never comes from a lead.
 */

/** What the fill-ins of a lead are read from. */
export interface FillInLead {
  fullName: string | null;
  form: Readonly<Record<string, unknown>>;
  order: LeadOrder | null;
}

const PERIOD_SUFFIX: Readonly<Record<PlanSnapshot['billingPeriod'], string>> = {
  one_time: '',
  month: '/month',
  '30_days': '/30 days',
  '90_days': '/90 days',
  year: '/year',
};

const cad = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });

/** `$40.00/month`: the plan's price in Canadian dollars and its billing period. */
export function formatPlanPrice(plan: Pick<PlanSnapshot, 'priceMinor' | 'billingPeriod'>): string {
  return `${cad.format(plan.priceMinor / 100)}${PERIOD_SUFFIX[plan.billingPeriod]}`;
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** `${siteUrl}/track`, without doubling a trailing slash; nothing for a site with no address. */
function trackingLink(siteUrl: string | null): string | undefined {
  const base = text(siteUrl)?.replace(/\/+$/, '');
  return base ? `${base}/track` : undefined;
}

/** Drops the fill-ins with no value. */
function defined(values: Readonly<Record<EmailFillInKey, string | undefined>>): FillInValues {
  const result: FillInValues = {};
  for (const key of EMAIL_FILL_IN_KEYS) {
    const value = values[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/** The fill-in values of a lead of `site`. */
export function fillInValuesForLead(
  lead: FillInLead,
  site: { siteName: string; siteUrl: string | null },
): FillInValues {
  const [firstWord, ...otherWords] = text(lead.fullName)?.split(/\s+/) ?? [];
  const plan = lead.order?.plan ?? null;
  return defined({
    'first name': text(lead.form.firstName) ?? firstWord,
    'last name': text(lead.form.lastName) ?? text(otherWords.join(' ')),
    'site name': text(site.siteName),
    plan: plan ? text(plan.name) : text(lead.form.planLabel),
    price: plan ? formatPlanPrice(plan) : undefined,
    'SIM number': text(lead.form.simNumber),
    courier: text(lead.order?.courier),
    'tracking number': text(lead.order?.trackingNumber),
    'tracking link': trackingLink(site.siteUrl),
    code: undefined,
  });
}

/** A value for every fill-in, for the editor's preview and a staff test send. */
export function sampleFillInValues(site: {
  siteName: string;
  siteUrl: string | null;
}): FillInValues {
  return {
    'first name': 'Nadia',
    'last name': 'Khan',
    'site name': site.siteName,
    plan: 'Rogers 60GB',
    price: formatPlanPrice({ priceMinor: 4000, billingPeriod: 'month' }),
    'SIM number': '+1 647 555 0123',
    courier: 'Canada Post',
    'tracking number': 'LX123456789CA',
    'tracking link': trackingLink(site.siteUrl) ?? 'https://example.com/track',
    code: '483920',
  };
}
