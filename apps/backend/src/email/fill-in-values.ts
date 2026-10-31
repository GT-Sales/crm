import {
  EMAIL_FILL_IN_KEYS,
  formatPropertyValue,
  type EmailFillInKey,
  type LeadOrder,
  type PlanSnapshot,
  type PropertyCatalog,
  type SiteProperty,
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
  leadType: string;
  fullName: string | null;
  /** The order number (`MS-1042`) for `{order number}`. */
  externalRef: string | null;
  form: Readonly<Record<string, unknown>>;
  customValues: Readonly<Record<string, unknown>>;
  order: LeadOrder | null;
}

/** Who reads a property's value: a customer (a mail) or staff (a task title). */
export type PropertyAudience = 'customer' | 'staff';

/** A field of a stored object by name, or `undefined`. */
function fieldOf(record: object | null, key: string): unknown {
  if (record === null || !Object.hasOwn(record, key)) return undefined;
  const value: unknown = Reflect.get(record, key);
  return value;
}

/** Whether `audience` may read `property`: never a sensitive one, and a customer never a staff-only one. */
function readableBy(property: SiteProperty, audience: PropertyAudience): boolean {
  if (property.sensitive) return false;
  return audience === 'staff' || !property.staffOnly;
}

/**
 * A property's value as the record page shows it, or undefined when absent
 * or not usable by `audience` (hidden, sensitive, or staff-only for a
 * customer, or not a property of the lead's type).
 */
export function leadPropertyText(
  lead: FillInLead,
  catalog: PropertyCatalog,
  key: string,
  audience: PropertyAudience,
): string | undefined {
  const property = catalog.forType(lead.leadType).find((entry) => entry.key === key);
  if (!property || !readableBy(property, audience)) return undefined;
  const field = property.storageKey ?? property.key;
  const value =
    property.storage === 'form'
      ? fieldOf(lead.form, field)
      : property.storage === 'custom'
        ? fieldOf(lead.customValues, field)
        : fieldOf(lead.order, field);
  const shown = formatPropertyValue(property, value).trim();
  return shown === '' ? undefined : shown;
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
function defined(
  values: Readonly<Record<EmailFillInKey, string | undefined>>,
): Partial<Record<EmailFillInKey, string>> {
  const result: Partial<Record<EmailFillInKey, string>> = {};
  for (const key of EMAIL_FILL_IN_KEYS) {
    const value = values[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/**
 * The fill-in values of a lead of `site`. With `options`, also the customer
 * values of the `{prop:…}` keys a site-made template uses (one a customer may
 * not see is left out, so the mail is skipped as missing it).
 */
export function fillInValuesForLead(
  lead: FillInLead,
  site: { siteName: string; siteUrl: string | null },
  options?: { catalog: PropertyCatalog; propertyKeys: readonly string[] },
): FillInValues {
  const [firstWord, ...otherWords] = text(lead.fullName)?.split(/\s+/) ?? [];
  const plan = lead.order?.plan ?? null;
  const props: Record<string, string> = {};
  for (const key of options?.propertyKeys ?? []) {
    const value = options ? leadPropertyText(lead, options.catalog, key, 'customer') : undefined;
    if (value !== undefined) props[key] = value;
  }
  const values = defined({
    'first name': text(lead.form.firstName) ?? firstWord,
    'last name': text(lead.form.lastName) ?? text(otherWords.join(' ')),
    'site name': text(site.siteName),
    plan: plan ? text(plan.name) : text(lead.form.planLabel),
    price: plan ? formatPlanPrice(plan) : undefined,
    'SIM number': text(lead.form.simNumber),
    courier: text(lead.order?.courier),
    'tracking number': text(lead.order?.trackingNumber),
    'tracking link': trackingLink(site.siteUrl),
    'order number': text(lead.externalRef),
    code: undefined,
  });
  return options && options.propertyKeys.length > 0 ? { ...values, props } : values;
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
    'order number': 'MS-1042',
    code: '483920',
  };
}
