import type { LeadFieldDefinition, LeadFieldKind, LeadFieldOption } from './lead-fields';
import { codePropertyCatalog, type PropertyCatalog } from './properties';

/**
 * Shared catalogue of lead form properties across every GT Sales website and
 * lead type. Each property key is defined once here; `leadTypeProperties`
 * declares which properties each lead type uses, in display order, along with
 * per-type options and editability rules. `leadFieldCatalog` and `leadFields`
 * in `./lead-fields` are derived from these two structures.
 */

export interface LeadPropertyDefinition {
  readonly key: string;
  readonly label: string;
  readonly kind: LeadFieldKind;
  readonly options?: readonly LeadFieldOption[];
  readonly maxLength?: number;
  /** Identity-like properties (`dateOfBirth`) are never filterable, sortable or shown as list columns. */
  readonly sensitive?: boolean;
}

export interface LeadTypePropertyUse {
  readonly key: string;
  readonly label?: string;
  /** A lead type may only override `text` to `choice` (with `options`). */
  readonly kind?: LeadFieldKind;
  readonly options?: readonly LeadFieldOption[];
  readonly labelKey?: string;
  readonly editable?: boolean;
  readonly staffOnly?: boolean;
  readonly maxLength?: number;
  readonly requiredWhen?: { readonly key: string; readonly value: string };
  readonly countdown?: boolean;
}

export interface FilterableLeadProperty {
  readonly key: string;
  readonly label: string;
  readonly kind: LeadFieldKind;
  readonly options?: readonly LeadFieldOption[];
  readonly maxLength?: number;
}

export const LEAD_PROPERTY_OPERATORS = [
  'eq',
  'contains',
  'in',
  'lte',
  'gte',
  'empty',
  'notEmpty',
] as const;

export type LeadPropertyOperator = (typeof LEAD_PROPERTY_OPERATORS)[number];

const OPERATORS_BY_KIND: Readonly<Record<LeadFieldKind, readonly LeadPropertyOperator[]>> = {
  text: ['eq', 'contains', 'empty', 'notEmpty'],
  longText: ['eq', 'contains', 'empty', 'notEmpty'],
  choice: ['eq', 'in', 'empty', 'notEmpty'],
  date: ['eq', 'lte', 'gte', 'empty', 'notEmpty'],
  dateTime: ['lte', 'gte', 'empty', 'notEmpty'],
  count: ['eq', 'lte', 'gte', 'empty', 'notEmpty'],
  number: ['eq', 'lte', 'gte', 'empty', 'notEmpty'],
  money: ['eq', 'lte', 'gte', 'empty', 'notEmpty'],
  yesNo: ['eq', 'empty'],
  email: ['eq', 'contains', 'empty', 'notEmpty'],
  phone: ['eq', 'contains', 'empty', 'notEmpty'],
  url: ['eq', 'contains', 'empty', 'notEmpty'],
};

/** Get Canada Sim's plans as its `data.ts` names them (`planLabel`), by slug. */
const SIM_PLANS: readonly LeadFieldOption[] = [
  { value: 'unlimited-data-120gb-rogers', label: 'Unlimited Data · $50, Rogers' },
  { value: 'unlimited-data-rogers', label: 'Unlimited Data · $40, Rogers' },
  { value: '75gb-fido', label: '75GB · $35, Fido' },
  { value: '95gb-chatr', label: '90GB · $40, Chatr' },
  { value: '25gb-chatr', label: '50GB · $35, Chatr' },
  { value: '75gb-chatr', label: '75GB · $75, Chatr' },
];

/** Get Canada Sim's visa / permit types (`PERMIT_TYPES` there). */
const PERMIT_TYPES: readonly LeadFieldOption[] = [
  { value: 'newcomer', label: 'Newcomer / permanent resident' },
  { value: 'student', label: 'Study permit' },
  { value: 'worker', label: 'Work permit' },
  { value: 'tourist', label: 'Tourist / visitor' },
];

const MOBILITY_SIM_TYPES: readonly LeadFieldOption[] = [
  { value: 'esim', label: 'eSIM' },
  { value: 'physical', label: 'Physical SIM' },
];

// Get Canada Sim stores a mailed physical SIM as `pickup`; there is no pickup.
const SIM_ORDER_DELIVERY_OPTIONS: readonly LeadFieldOption[] = [
  { value: 'esim', label: 'eSIM' },
  { value: 'pickup', label: 'Physical SIM (mailed)' },
];

// The commission the carrier pays on the order, tracked by hand (Get Canada
// Sim's `commission_status`); unset means not tracked yet. It voids nothing.
const COMMISSION_STATUS_OPTIONS: readonly LeadFieldOption[] = [
  { value: 'invoiced', label: 'Invoiced' },
  { value: 'commission_received', label: 'Commission received' },
  { value: 'claw_back', label: 'Clawback' },
];

const prop = (
  key: string,
  label: string,
  kind: LeadFieldKind,
  extra: Omit<LeadPropertyDefinition, 'key' | 'label' | 'kind'> = {},
): LeadPropertyDefinition => ({ key, label, kind, ...extra });

export const leadPropertyCatalog: Readonly<Record<string, LeadPropertyDefinition>> = {
  planLabel: prop('planLabel', 'Plan', 'text'),
  planId: prop('planId', 'Plan id', 'text'),
  streetAddress: prop('streetAddress', 'Street address', 'text'),
  aptUnit: prop('aptUnit', 'Apt / unit', 'text'),
  city: prop('city', 'City', 'text'),
  postalCode: prop('postalCode', 'Postal code', 'text'),
  landingCity: prop('landingCity', 'Landing city', 'text'),
  dateOfBirth: prop('dateOfBirth', 'Date of birth', 'date', { sensitive: true }),
  currentProvider: prop('currentProvider', 'Current provider', 'text'),
  preferredInstallationTime: prop('preferredInstallationTime', 'Preferred installation', 'text'),
  consent: prop('consent', 'Contact consent', 'yesNo'),
  consentedAt: prop('consentedAt', 'Consented at', 'dateTime'),
  lineCount: prop('lineCount', 'Lines', 'count'),
  firstName: prop('firstName', 'First name', 'text'),
  lastName: prop('lastName', 'Last name', 'text'),
  simType: prop('simType', 'SIM', 'choice'),
  keepNumber: prop('keepNumber', 'Keep current number', 'yesNo'),
  delivery: prop('delivery', 'SIM type', 'choice'),
  arrivalDate: prop('arrivalDate', 'Arrival in Canada', 'date'),
  permitType: prop('permitType', 'Visa / permit type', 'choice'),
  gotVisa: prop('gotVisa', 'Has the visa', 'yesNo'),
  flightBooked: prop('flightBooked', 'Flight booked', 'yesNo'),
  shippingAddress: prop('shippingAddress', 'Shipping address', 'longText', { maxLength: 400 }),
  canadaAddress: prop('canadaAddress', 'Address in Canada / City', 'text', { maxLength: 300 }),
  reference: prop('reference', 'Reference', 'text', { maxLength: 120 }),
  customerNotes: prop('customerNotes', 'Customer notes', 'longText'),
  simNumber: prop('simNumber', 'SIM number', 'text', { maxLength: 40 }),
  commissionStatus: prop('commissionStatus', 'Carrier commission', 'choice'),
  company: prop('company', 'Company', 'text'),
  businessType: prop('businessType', 'Business type', 'text'),
  country: prop('country', 'Country', 'text'),
  website: prop('website', 'Website', 'text'),
  volume: prop('volume', 'Expected volume', 'text'),
  message: prop('message', 'Message', 'longText'),
};

export const leadTypeProperties: Readonly<Record<string, readonly LeadTypePropertyUse[]>> = {
  internet: [
    { key: 'planLabel' },
    { key: 'planId' },
    { key: 'streetAddress' },
    { key: 'aptUnit' },
    { key: 'city' },
    { key: 'postalCode' },
    { key: 'landingCity' },
    { key: 'dateOfBirth' },
    { key: 'currentProvider' },
    { key: 'preferredInstallationTime' },
    { key: 'consent' },
    { key: 'consentedAt' },
  ],
  mobility: [
    { key: 'planLabel' },
    { key: 'planId' },
    { key: 'lineCount' },
    { key: 'firstName' },
    { key: 'lastName' },
    { key: 'simType', options: MOBILITY_SIM_TYPES },
    { key: 'keepNumber' },
    { key: 'currentProvider' },
    { key: 'streetAddress' },
    { key: 'aptUnit' },
    { key: 'city' },
    { key: 'postalCode' },
  ],
  sim_order: [
    {
      key: 'planId',
      label: 'Plan',
      kind: 'choice',
      options: SIM_PLANS,
      labelKey: 'planLabel',
      editable: true,
    },
    {
      key: 'delivery',
      options: SIM_ORDER_DELIVERY_OPTIONS,
      editable: true,
    },
    { key: 'arrivalDate', editable: true, countdown: true },
    { key: 'permitType', options: PERMIT_TYPES, editable: true },
    { key: 'gotVisa', editable: true },
    { key: 'flightBooked', editable: true },
    {
      key: 'shippingAddress',
      editable: true,
      maxLength: 400,
      requiredWhen: { key: 'delivery', value: 'pickup' },
    },
    { key: 'canadaAddress', editable: true, maxLength: 300 },
    { key: 'reference', editable: true, maxLength: 120 },
    { key: 'customerNotes' },
    { key: 'simNumber', editable: true, staffOnly: true, maxLength: 40 },
    {
      key: 'commissionStatus',
      options: COMMISSION_STATUS_OPTIONS,
      editable: true,
      staffOnly: true,
    },
  ],
  partner_application: [
    { key: 'company' },
    { key: 'businessType' },
    { key: 'country' },
    { key: 'website' },
    { key: 'volume' },
    { key: 'message' },
  ],
};

/**
 * Merges a shared property definition with a lead type's use of it.
 * Only `text` -> `choice` (with non-empty options) is permitted as a kind override.
 */
export function resolveLeadTypeProperty(
  property: LeadPropertyDefinition,
  use: LeadTypePropertyUse,
): LeadFieldDefinition {
  if (use.key !== property.key) {
    throw new Error(`Property key mismatch: expected ${property.key}, received ${use.key}`);
  }
  if (use.kind !== undefined && use.kind !== property.kind) {
    if (
      property.kind !== 'text' ||
      use.kind !== 'choice' ||
      !use.options ||
      use.options.length === 0
    ) {
      throw new Error(
        `Invalid kind override on property "${property.key}": ${property.kind} -> ${use.kind}`,
      );
    }
  }
  const kind = use.kind ?? property.kind;
  const label = use.label ?? property.label;
  const options = use.options ?? property.options;
  const maxLength = use.maxLength ?? property.maxLength;

  return {
    key: property.key,
    label,
    kind,
    ...(options !== undefined ? { options } : {}),
    ...(use.labelKey !== undefined ? { labelKey: use.labelKey } : {}),
    ...(use.editable !== undefined ? { editable: use.editable } : {}),
    ...(use.staffOnly !== undefined ? { staffOnly: use.staffOnly } : {}),
    ...(maxLength !== undefined ? { maxLength } : {}),
    ...(use.requiredWhen !== undefined ? { requiredWhen: use.requiredWhen } : {}),
    ...(use.countdown !== undefined ? { countdown: use.countdown } : {}),
  };
}

/** The shared definition for a property key, or `undefined` when unknown. */
export function leadProperty(key: string): LeadPropertyDefinition | undefined {
  return Object.hasOwn(leadPropertyCatalog, key) ? leadPropertyCatalog[key] : undefined;
}

/** The property keys used by a lead type, in display order. */
export function leadTypePropertyKeys(leadType: string): readonly string[] {
  const uses = Object.hasOwn(leadTypeProperties, leadType)
    ? leadTypeProperties[leadType]
    : undefined;
  return uses ? uses.map((entry) => entry.key) : [];
}

/**
 * Non-sensitive, visible properties used by `leadType`, or by any lead type
 * when omitted, each with the effective kind and options for that scope (when
 * no type is given and kinds differ across types, `text` semantics are used).
 * The site's `catalog` adds its custom properties and hides what it hides;
 * without one this is the code catalogue.
 */
export function filterableLeadProperties(
  leadType?: string,
  catalog: PropertyCatalog = codePropertyCatalog,
): readonly FilterableLeadProperty[] {
  return catalog.filterable(leadType);
}

/** Allowed filter operators for a property kind. */
export function leadPropertyOperators(kind: LeadFieldKind): readonly LeadPropertyOperator[] {
  return OPERATORS_BY_KIND[kind];
}
