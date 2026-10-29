import { describe, expect, it } from 'vitest';
import {
  buildPropertyCatalog,
  codePropertyCatalog,
  defaultPropertyLayout,
  propertyRowSchema,
  type GetWorkspaceLeadResponse,
  type LeadDetail,
  type PropertyCatalog,
  type PropertyRow,
} from '@gt-sales/contracts';

import { deliveryLetterUrl, leadSummaryText, type LeadSummaryView } from './lead-summary';

const STAMP = '2026-10-29T12:00:00.000Z';

function propertyRow(
  overrides: Partial<PropertyRow> & Pick<PropertyRow, 'key' | 'origin' | 'label'>,
): PropertyRow {
  return propertyRowSchema.parse({
    object: 'lead',
    kind: 'text',
    options: [],
    staffOnly: false,
    sensitive: false,
    hidden: false,
    leadTypes: [],
    position: 0,
    version: 1,
    createdAt: STAMP,
    updatedAt: STAMP,
    ...overrides,
  });
}

/** The page's view of a SIM order on a site with `catalog`, in its default layout. */
function viewOf(catalog: PropertyCatalog = codePropertyCatalog): LeadSummaryView {
  return {
    layout: defaultPropertyLayout('sim_order', catalog),
    catalog,
    canRevealSensitive: true,
  };
}

const order: LeadDetail = {
  id: '90000000-0000-4000-8000-000000000101',
  workspaceId: '10000000-0000-4000-8000-000000000101',
  leadType: 'sim_order',
  status: 'submitted',
  stage: 'verified',
  contact: { fullName: 'Arjun Kumar Patel', email: 'arjun@example.test', phone: '+91 99999 00001' },
  contactId: null,
  assignedActorId: null,
  externalRef: 'MS-101',
  source: 'partner:PT-7',
  attribution: { partnerCode: 'PT-7' },
  consentVersion: 'gcs-legacy-import',
  openTaskCount: 0,
  nextTaskDueAt: null,
  deletedAt: null,
  createdAt: '2026-10-20T09:00:00.000Z',
  updatedAt: '2026-10-20T09:00:00.000Z',
  form: {
    schemaVersion: 1,
    payload: {
      planId: '75gb-fido',
      planLabel: '75GB · $35, Fido',
      delivery: 'pickup',
      arrivalDate: '2026-11-02',
      shippingAddress: '1 Bay St\nToronto ON',
      canadaAddress: 'Toronto',
      simNumber: '4165550104',
    },
  },
};

const record = (
  lead: LeadDetail,
  documents: GetWorkspaceLeadResponse['documents'] = [],
): Pick<GetWorkspaceLeadResponse, 'lead' | 'documents'> => ({ lead, documents });

describe('leadSummaryText', () => {
  it('reads like the lead page: number, stage, customer, answers, staff fields, documents', () => {
    const text = leadSummaryText(
      record(order, [
        {
          id: '50000000-0000-4000-8000-000000000101',
          documentType: 'passport',
          contentType: 'application/pdf',
          sizeBytes: 1000,
          revision: 1,
          createdAt: '2026-10-20T09:00:00.000Z',
        },
      ]),
      viewOf(),
    );
    const lines = text.split('\n');
    expect(lines[0]).toBe('MS-101 · SIM order');
    expect(lines).toContain('Stage: Verified');
    expect(lines).toContain('Customer: Arjun Kumar Patel');
    expect(lines).toContain('Phone: +91 99999 00001');
    expect(lines).toContain('Plan: 75GB · $35, Fido');
    expect(lines).toContain('SIM type: Physical SIM (mailed)');
    expect(lines).toContain('SIM number: 4165550104');
    expect(lines).toContain('Documents: Passport');
    expect(lines.at(-1)).toBe('Source: partner:PT-7');
    // An empty staff field is left out rather than copied as a dash.
    expect(text).not.toContain('Carrier commission');
  });

  it('leaves out what the reader was not shown', () => {
    const text = leadSummaryText(record({ ...order, contact: {}, form: null }), viewOf());
    expect(text).not.toContain('Customer:');
    expect(text).not.toContain('Plan:');
  });

  it('reads the site catalogue and layout: its labels, no hidden built-in, custom values included', () => {
    const catalog = buildPropertyCatalog([
      // The site renamed one built-in and hid another.
      propertyRow({ key: 'simNumber', origin: 'builtin', label: 'SIM card number', version: 2 }),
      propertyRow({
        key: 'canadaAddress',
        origin: 'builtin',
        label: 'Address in Canada',
        hidden: true,
        version: 2,
      }),
      propertyRow({ key: 'custom_referral_code', origin: 'custom', label: 'Referral code' }),
      propertyRow({
        key: 'custom_budget',
        origin: 'custom',
        label: 'Budget',
        kind: 'money',
        position: 1,
      }),
      propertyRow({ key: 'custom_empty', origin: 'custom', label: 'Left blank', position: 2 }),
    ]);
    const layout = {
      sections: [
        { id: 'main', label: 'Main', keys: ['custom_referral_code', 'simNumber', 'planId'] },
      ],
    };
    const text = leadSummaryText(
      record({
        ...order,
        customValues: { custom_referral_code: 'FRIEND-7', custom_budget: 4500 },
      }),
      { layout, catalog, canRevealSensitive: true },
    );
    const lines = text.split('\n');

    expect(lines).toContain('SIM card number: 4165550104');
    expect(text).not.toContain('SIM number:');
    expect(lines).toContain('Referral code: FRIEND-7');
    expect(lines).toContain('Budget: $45.00');
    // A hidden built-in is not on the page, so not in the copy.
    expect(lines).not.toContain('Address in Canada: Toronto');
    expect(lines).not.toContain('Canada address: Toronto');
    expect(text).not.toContain('Left blank');
    // The layout's order first; what it does not place follows, as under "Other".
    expect(lines.indexOf('Referral code: FRIEND-7')).toBeLessThan(
      lines.indexOf('SIM card number: 4165550104'),
    );
    expect(lines.indexOf('SIM card number: 4165550104')).toBeLessThan(
      lines.indexOf('Budget: $45.00'),
    );
  });

  it('copies a sensitive value only for a reader the page shows it to', () => {
    const catalog = buildPropertyCatalog([
      propertyRow({
        key: 'custom_passport',
        origin: 'custom',
        label: 'Passport no.',
        sensitive: true,
      }),
    ]);
    const lead = { ...order, customValues: { custom_passport: 'X1234567' } };
    expect(leadSummaryText(record(lead), viewOf(catalog))).toContain('Passport no.: X1234567');
    expect(
      leadSummaryText(record(lead), { ...viewOf(catalog), canRevealSensitive: false }),
    ).not.toContain('X1234567');
  });
});

describe('deliveryLetterUrl', () => {
  it('fills Get Canada Sim’s mailer as its own admin does', () => {
    const url = new URL(deliveryLetterUrl(record(order)) ?? '');
    expect(`${url.origin}${url.pathname}`).toBe('https://getcanadasim.com/delivery-letter.html');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      first_name: 'Arjun',
      recipient_name: 'ARJUN KUMAR PATEL',
      address_line1: '1 Bay St\nToronto ON',
      address_line2: '',
      address_line3: '',
      phone: '+91 99999 00001',
      order_id: 'MS-101',
      plan_name: '75GB · $35, Fido',
      plan_price: '$35',
      carrier: 'Fido · 4G LTE',
      sim_type: 'Physical SIM',
      billing_email: 'arjun@example.test',
      arrival_date: 'Nov 2, 2026',
      canada_address: 'Toronto',
    });
  });

  it('has nothing for a lead type without a mailer', () => {
    expect(deliveryLetterUrl(record({ ...order, leadType: 'internet' }))).toBeUndefined();
  });
});
