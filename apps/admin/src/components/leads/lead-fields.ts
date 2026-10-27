/**
 * How a lead's submitted form reads on the lead page: each modelled type's
 * fields in the order staff check them, with labels and formatting. A key the
 * list does not know (a type not yet modelled, or a field a website added
 * later) still shows, after the known ones, under a label made from its name.
 */

export interface FormField {
  label: string;
  value: string;
}

type Formatter = (value: unknown) => string | undefined;

const text: Formatter = (value) =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;
const yesNo: Formatter = (value) =>
  typeof value === 'boolean' ? (value ? 'Yes' : 'No') : undefined;
const count: Formatter = (value) => (typeof value === 'number' ? String(value) : undefined);
const date: Formatter = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return text(value);
  return new Date(`${value}T12:00:00Z`).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
};
const dateTime: Formatter = (value) => {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return text(value);
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};
const simType: Formatter = (value) =>
  value === 'esim' ? 'eSIM' : value === 'physical' ? 'Physical SIM' : text(value);
// Get Canada Sim stores a mailed physical SIM as `pickup` (there is no pickup).
const delivery: Formatter = (value) =>
  value === 'esim' ? 'eSIM' : value === 'pickup' ? 'Physical SIM (mailed)' : text(value);
const PERMIT_TYPES: Record<string, string> = {
  newcomer: 'Newcomer / permanent resident',
  student: 'Study permit',
  worker: 'Work permit',
  tourist: 'Tourist / visitor',
};
const permit: Formatter = (value) =>
  typeof value === 'string' ? (PERMIT_TYPES[value] ?? text(value)) : undefined;

type FieldSpec = readonly [key: string, label: string, format: Formatter];

const FIELDS: Record<string, readonly FieldSpec[]> = {
  internet: [
    ['planLabel', 'Plan', text],
    ['planId', 'Plan id', text],
    ['streetAddress', 'Street address', text],
    ['aptUnit', 'Apt / unit', text],
    ['city', 'City', text],
    ['postalCode', 'Postal code', text],
    ['landingCity', 'Landing city', text],
    ['dateOfBirth', 'Date of birth', date],
    ['currentProvider', 'Current provider', text],
    ['preferredInstallationTime', 'Preferred installation', text],
    ['consent', 'Contact consent', yesNo],
    ['consentedAt', 'Consented at', dateTime],
  ],
  mobility: [
    ['planLabel', 'Plan', text],
    ['planId', 'Plan id', text],
    ['lineCount', 'Lines', count],
    ['firstName', 'First name', text],
    ['lastName', 'Last name', text],
    ['simType', 'SIM', simType],
    ['keepNumber', 'Keep current number', yesNo],
    ['currentProvider', 'Current provider', text],
    ['streetAddress', 'Street address', text],
    ['aptUnit', 'Apt / unit', text],
    ['city', 'City', text],
    ['postalCode', 'Postal code', text],
  ],
  sim_order: [
    ['planLabel', 'Plan', text],
    ['planId', 'Plan id', text],
    ['delivery', 'SIM type', delivery],
    ['arrivalDate', 'Arrival in Canada', date],
    ['permitType', 'Visa / permit type', permit],
    ['gotVisa', 'Has the visa', yesNo],
    ['flightBooked', 'Flight booked', yesNo],
    ['shippingAddress', 'Shipping address', text],
    ['canadaAddress', 'Address in Canada / City', text],
    ['reference', 'Reference', text],
    ['customerNotes', 'Customer notes', text],
  ],
  partner_application: [
    ['company', 'Company', text],
    ['businessType', 'Business type', text],
    ['country', 'Country', text],
    ['website', 'Website', text],
    ['volume', 'Expected volume', text],
    ['message', 'Message', text],
  ],
};

function labelFromKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function anyValue(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

/** The payload's fields, known ones first in order, empty ones left out. */
export function formFields(leadType: string, payload: Record<string, unknown>): FormField[] {
  const specs = FIELDS[leadType] ?? [];
  const known = new Set(specs.map(([key]) => key));
  const fields: FormField[] = [];
  for (const [key, label, format] of specs) {
    const value = format(payload[key]);
    if (value !== undefined) fields.push({ label, value });
  }
  for (const [key, raw] of Object.entries(payload)) {
    if (known.has(key)) continue;
    const value = anyValue(raw);
    if (value !== undefined) fields.push({ label: labelFromKey(key), value });
  }
  return fields;
}
