import { describe, expect, it } from 'vitest';
import {
  codePropertyCatalog,
  leadExportFields,
  type LeadExportField,
  type LeadListItem,
} from '@gt-sales/contracts';

import { leadExportCell, safeSpreadsheetText } from '../src/leads/export/cells.js';
import { buildLeadWorkbook, sheetNames } from '../src/leads/export/workbook.js';
import type { LeadExportRow } from '../src/leads/staff-queries.js';
import { headersOf, readXlsx, serialToDate } from './support/xlsx.js';

const lead: LeadListItem = {
  id: '90000000-0000-4000-8000-00000000e001',
  workspaceId: '10000000-0000-4000-8000-00000000e001',
  leadType: 'sim_order',
  status: 'submitted',
  stage: 'pending',
  contact: { fullName: 'Ada Example', email: 'ada@example.test', phone: '+1 604 555 0100' },
  contactId: null,
  assignedActorId: '20000000-0000-4000-8000-00000000e001',
  externalRef: 'MS-0042',
  source: 'utm:google/cpc',
  attribution: { utmSource: 'google', utmMedium: 'cpc', utmCampaign: '=cmd' },
  consentVersion: 'v1',
  openTaskCount: 2,
  nextTaskDueAt: '2026-11-14T12:00:00.000Z',
  deletedAt: null,
  createdAt: '2026-11-01T10:20:30.000Z',
  updatedAt: '2026-11-02T08:00:00.000Z',
};

const row: LeadExportRow = {
  lead,
  form: {
    planId: 'retired-plan',
    planLabel: 'Retired plan · $20',
    delivery: 'pickup',
    arrivalDate: '2026-12-01',
    gotVisa: true,
    shippingAddress: '1 Main St\nVancouver',
    simNumber: '8912345678901234567',
  },
  custom: {},
  order: {
    planId: '40000000-0000-4000-8000-00000000e001',
    plan: {
      planId: '40000000-0000-4000-8000-00000000e001',
      name: 'Unlimited 40',
      priceMinor: 4000,
      currency: 'CAD',
      billingPeriod: 'month',
      paymentRequired: true,
      requiredDocuments: [],
      properties: {},
      commission: { type: 'percent', rateBps: 1000 },
      frozenAt: '2026-11-01T10:20:30.000Z',
    },
    quantity: 2,
    paymentStatus: 'paid',
    carrierCommission: 'not_yet',
    courier: null,
    trackingNumber: '00123456789012345678',
    dispatchedAt: '2026-11-03',
    activatedAt: null,
    activationNumber: null,
    activationAccount: null,
    documentsOverride: null,
  },
  stageChangedAt: '2026-11-02T07:00:00.000Z',
  lastActivityAt: '2026-11-02T08:00:00.000Z',
  noteCount: 3,
};

const context = {
  memberNames: new Map([['20000000-0000-4000-8000-00000000e001', 'Sam Staff']]),
};

function fieldsFor(access: { contacts: boolean; revenue: boolean }): Map<string, LeadExportField> {
  return new Map(
    leadExportFields({ catalog: codePropertyCatalog, leadType: 'sim_order', access }).map(
      (field) => [field.key, field],
    ),
  );
}

const owner = fieldsFor({ contacts: true, revenue: true });
const cell = (key: string) => {
  const field = owner.get(key);
  if (!field) throw new Error(`no field ${key}`);
  return leadExportCell(field, row, context);
};

describe('safeSpreadsheetText', () => {
  it.each([
    ['=1+1', "'=1+1"],
    ['=HYPERLINK("http://evil.test","x")', '\'=HYPERLINK("http://evil.test","x")'],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\t=1+1', "'\t=1+1"],
    ['\r=1+1', "'\r=1+1"],
    ['+1+cmd|calc', "'+1+cmd|calc"],
    ['-2+3', "'-2+3"],
    ['-cmd', "'-cmd"],
  ])('marks %j as text', (value, expected) => {
    expect(safeSpreadsheetText(value)).toBe(expected);
  });

  it.each([
    '+1 604 555 0100',
    '+44 (0)20 7946-0958',
    '+1 604 555 0100 ext 12',
    '-12.5',
    'Ada Example',
    '0012345',
    'a=b',
    'user@example.test',
  ])('leaves %j as it is', (value) => {
    expect(safeSpreadsheetText(value)).toBe(value);
  });

  it('drops characters XML cannot carry and caps a cell at its limit', () => {
    expect(safeSpreadsheetText('a\u0000b\u0008c')).toBe('abc');
    expect(safeSpreadsheetText('x'.repeat(40_000))).toHaveLength(32_767);
    expect(safeSpreadsheetText(`=${'x'.repeat(40_000)}`)).toHaveLength(32_767);
  });
});

describe('leadExportCell', () => {
  it('writes ids, phones and numbers-as-text as text', () => {
    expect(cell('reference')).toEqual({ type: 'text', value: 'MS-0042' });
    expect(cell('phone')).toEqual({ type: 'text', value: '+1 604 555 0100' });
    expect(cell('prop.simNumber')).toEqual({ type: 'text', value: '8912345678901234567' });
    expect(cell('prop.trackingNumber')).toEqual({ type: 'text', value: '00123456789012345678' });
  });

  it('writes timestamps as UTC instants and calendar days as dates', () => {
    expect(cell('createdAt')).toEqual({
      type: 'dateTime',
      value: new Date('2026-11-01T10:20:30.000Z'),
    });
    expect(cell('prop.arrivalDate')).toEqual({
      type: 'date',
      value: new Date('2026-12-01T00:00:00.000Z'),
    });
    expect(cell('prop.dispatchedAt')).toEqual({
      type: 'date',
      value: new Date('2026-11-03T00:00:00.000Z'),
    });
    // A task's due day, stored at noon UTC.
    expect(cell('nextTaskDueAt')).toEqual({
      type: 'date',
      value: new Date('2026-11-14T00:00:00.000Z'),
    });
    expect(cell('archivedAt')).toBeNull();
  });

  it('writes labels for the type, stage, status, choices, yes/no and the assignee', () => {
    expect(cell('leadType')).toEqual({ type: 'text', value: 'SIM order' });
    expect(cell('stage')).toEqual({ type: 'text', value: 'Pending' });
    expect(cell('status')).toEqual({ type: 'text', value: 'Submitted' });
    expect(cell('assignee')).toEqual({ type: 'text', value: 'Sam Staff' });
    expect(cell('prop.delivery')).toEqual({ type: 'text', value: 'Physical SIM (mailed)' });
    expect(cell('prop.gotVisa')).toEqual({ type: 'text', value: 'Yes' });
    expect(cell('prop.paymentStatus')).toEqual({ type: 'text', value: 'Paid' });
    // The order's plan is the name frozen on it; a form value its options no longer list keeps the form's label.
    expect(cell('prop.plan')).toEqual({ type: 'text', value: 'Unlimited 40' });
    expect(cell('prop.planId')).toEqual({ type: 'text', value: 'Retired plan · $20' });
  });

  it('writes numbers as numbers and money in dollars', () => {
    expect(cell('prop.quantity')).toEqual({ type: 'number', value: 2 });
    expect(cell('openTaskCount')).toEqual({ type: 'number', value: 2 });
    expect(cell('noteCount')).toEqual({ type: 'number', value: 3 });
    expect(cell('planPrice')).toEqual({ type: 'money', value: 40 });
    // 10% of $40.00, twice.
    expect(cell('planCommission')).toEqual({ type: 'money', value: 8 });
  });

  it('marks customer-written text that would run as a formula', () => {
    expect(cell('utmCampaign')).toEqual({ type: 'text', value: "'=cmd" });
  });

  it('names a member who has left, and leaves an unassigned lead empty', () => {
    const assignee = owner.get('assignee');
    if (!assignee) throw new Error('no assignee field');
    expect(leadExportCell(assignee, row, { memberNames: new Map() })).toEqual({
      type: 'text',
      value: 'Former teammate',
    });
    expect(
      leadExportCell(assignee, { ...row, lead: { ...lead, assignedActorId: null } }, context),
    ).toBeNull();
  });
});

describe('buildLeadWorkbook', () => {
  it('writes a workbook a reader opens: bold frozen header, auto-filter, typed cells', async () => {
    const file = await buildLeadWorkbook([
      {
        name: 'SIM order',
        columns: [
          { label: 'Reference' },
          { label: 'Name' },
          { label: 'Phone' },
          { label: 'Created (UTC)' },
          { label: 'Arrival in Canada' },
          { label: 'Quantity' },
          { label: 'Plan price (CAD)' },
        ],
        rows: [
          [
            { type: 'text', value: '0012345' },
            { type: 'text', value: safeSpreadsheetText('=1+1') },
            { type: 'text', value: '+1 604 555 0100' },
            { type: 'dateTime', value: new Date('2026-11-01T10:20:00.000Z') },
            { type: 'date', value: new Date('2026-12-01T00:00:00.000Z') },
            { type: 'number', value: 2 },
            { type: 'money', value: 40.5 },
          ],
          [{ type: 'text', value: '12345678901234567890' }, null, null, null, null, null, null],
        ],
      },
      { name: 'Internet', columns: [{ label: 'Reference' }], rows: [] },
    ]);

    // A zip (`PK`), as every .xlsx is.
    expect(file.subarray(0, 2).toString('latin1')).toBe('PK');
    const [sim, internet] = readXlsx(file);
    if (!sim || !internet) throw new Error('expected two sheets');
    expect(sim.name).toBe('SIM order');
    expect(internet.name).toBe('Internet');

    expect(headersOf(sim)).toEqual([
      'Reference',
      'Name',
      'Phone',
      'Created (UTC)',
      'Arrival in Canada',
      'Quantity',
      'Plan price (CAD)',
    ]);
    expect(sim.rows[0]?.every((header) => header?.bold === true)).toBe(true);
    expect(sim.frozenRows).toBe(1);
    expect(sim.autoFilter).toBe('A1:G3');
    expect(internet.autoFilter).toBe('A1:A1');
    expect(sim.widths).toHaveLength(7);
    expect(sim.widths.every((width) => width >= 10 && width <= 50)).toBe(true);

    const [reference, name, phone, created, arrival, quantity, price] = sim.rows[1] ?? [];
    // Text stays text: the zeros, the plus sign and the "formula" are strings, not numbers or formulas.
    expect(reference).toMatchObject({ type: 's', raw: '0012345', formula: false, bold: false });
    expect(name).toMatchObject({ type: 's', raw: "'=1+1", formula: false });
    expect(phone).toMatchObject({ type: 's', raw: '+1 604 555 0100', formula: false });
    expect(sim.rows[2]?.[0]).toMatchObject({ type: 's', raw: '12345678901234567890' });
    // Dates are real dates: a number with a date format.
    expect(created).toMatchObject({ type: 'n', format: 'yyyy-mm-dd hh:mm' });
    expect(serialToDate(created?.raw ?? '').toISOString()).toBe('2026-11-01T10:20:00.000Z');
    expect(arrival).toMatchObject({ type: 'n', format: 'yyyy-mm-dd' });
    expect(serialToDate(arrival?.raw ?? '').toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(quantity).toMatchObject({ type: 'n', raw: '2', format: 'General' });
    expect(price).toMatchObject({ type: 'n', raw: '40.5', format: '#,##0.00' });
    // No cell anywhere is a formula.
    expect(sim.rows.flat().some((entry) => entry?.formula)).toBe(false);
  });

  it('makes sheet names Excel accepts', () => {
    expect(sheetNames(['SIM order', 'SIM order', 'a/b:c*d?e[f]g\\h', '', 'x'.repeat(40)])).toEqual([
      'SIM order',
      'SIM order (2)',
      'a b c d e f g h',
      'Leads',
      'x'.repeat(31),
    ]);
  });
});

describe('exportHeaders', () => {
  it('tells two fields with one label apart', async () => {
    const { exportHeaders } = await import('../src/leads/export/store.js');
    const field = (
      key: string,
      label: string,
      group: LeadExportField['group'],
    ): LeadExportField => ({
      key,
      label,
      group,
      kind: 'text',
      need: 'none',
    });
    expect(
      exportHeaders([
        field('fullName', 'Name', 'main'),
        field('prop.custom_name', 'Name', 'custom'),
        field('prop.custom_name2', 'name', 'custom'),
        field('source', 'Source', 'attribution'),
      ]),
    ).toEqual(['Name', 'Name (custom)', 'name (2)', 'Source']);
  });
});
