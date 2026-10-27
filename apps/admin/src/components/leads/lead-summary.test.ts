import { describe, expect, it } from 'vitest';
import type { GetWorkspaceLeadResponse, LeadDetail } from '@gt-sales/contracts';

import { deliveryLetterUrl, leadSummaryText } from './lead-summary';

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
    const text = leadSummaryText(record({ ...order, contact: {}, form: null }));
    expect(text).not.toContain('Customer:');
    expect(text).not.toContain('Plan:');
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
