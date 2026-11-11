import { describe, expect, it } from 'vitest';

import { BackendError, createBackendClient } from './client';
import { endpoints } from './endpoints';
import {
  LEAD_EXPORT_CONTENT_TYPE,
  LEAD_EXPORT_MAX_FIELDS,
  LEAD_EXPORT_MAX_IDS,
  exportLeadsRequestSchema,
  leadExportColumns,
  leadExportFields,
  leadExportFileName,
  leadExportGroups,
} from './lead-export';
import { buildOpenApiDocument } from './openapi';
import { buildPropertyCatalog, codePropertyCatalog, type PropertyRow } from './properties';
import { leadAccessSchema } from './workspace-leads';

const UUID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const owner = { contacts: true, revenue: true };
const staff = { contacts: true, revenue: false };
const readOnly = { contacts: false, revenue: false };

const row = (key: string, over: Partial<PropertyRow> = {}): PropertyRow => ({
  object: 'lead',
  key,
  origin: 'custom',
  label: key,
  kind: 'text',
  options: [],
  staffOnly: false,
  sensitive: false,
  hidden: false,
  websiteVisible: false,
  leadTypes: [],
  position: 1,
  version: 1,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  ...over,
});

const siteCatalog = buildPropertyCatalog([
  row('custom_loyalty', { label: 'Loyalty number', position: 1 }),
  row('custom_budget', { label: 'Budget', kind: 'money', position: 2 }),
  row('custom_passport', { label: 'Passport number', sensitive: true, position: 3 }),
  row('custom_gone', { label: 'Hidden one', hidden: true, position: 4 }),
  row('custom_sim_only', { label: 'SIM only', leadTypes: ['sim_order'], position: 5 }),
  // A built-in the site hid, and one it relabelled.
  row('reference', { origin: 'builtin', label: 'Reference', hidden: true }),
  row('canadaAddress', { origin: 'builtin', label: 'Where they will live' }),
]);

const keys = (fields: readonly { key: string }[]) => fields.map((field) => field.key);

describe('exportLeadsRequestSchema', () => {
  it('takes ticked ids or the list filters, and the fields', () => {
    expect(
      exportLeadsRequestSchema.parse({
        scope: { kind: 'ids', ids: [UUID, OTHER] },
        fields: ['prop.arrivalDate', 'updatedAt'],
      }),
    ).toEqual({
      scope: { kind: 'ids', ids: [UUID, OTHER] },
      fields: ['prop.arrivalDate', 'updatedAt'],
    });

    const filter = {
      status: 'submitted',
      type: 'sim_order',
      stage: 'pending',
      assignee: 'me',
      q: ' ada ',
      view: 'archived',
      dueBy: '2026-11-11',
      where: [{ key: 'permitType', op: 'in', value: ['student', 'worker'] }],
      sort: 'prop.arrivalDate:desc',
    };
    const parsed = exportLeadsRequestSchema.parse({
      scope: { kind: 'filter', filter },
      fields: [],
    });
    // The search is trimmed, as the list's is.
    expect(parsed.scope).toEqual({ kind: 'filter', filter: { ...filter, q: 'ada' } });
    expect(
      exportLeadsRequestSchema.safeParse({ scope: { kind: 'filter', filter: {} }, fields: [] })
        .success,
    ).toBe(true);
  });

  it.each([
    ['no ids', { scope: { kind: 'ids', ids: [] }, fields: [] }],
    ['an id that is not a uuid', { scope: { kind: 'ids', ids: ['x'] }, fields: [] }],
    ['a repeated id', { scope: { kind: 'ids', ids: [UUID, UUID] }, fields: [] }],
    [
      'more ids than the limit',
      {
        scope: {
          kind: 'ids',
          ids: Array.from(
            { length: LEAD_EXPORT_MAX_IDS + 1 },
            (_, index) => `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
          ),
        },
        fields: [],
      },
    ],
    ['ids and a filter at once', { scope: { kind: 'ids', ids: [UUID], filter: {} }, fields: [] }],
    ['a site in the body', { workspaceId: UUID, scope: { kind: 'ids', ids: [UUID] }, fields: [] }],
    ['a page', { scope: { kind: 'filter', filter: { page: 2 } }, fields: [] }],
    ['property columns', { scope: { kind: 'filter', filter: { columns: ['city'] } }, fields: [] }],
    [
      'a where that is a string',
      { scope: { kind: 'filter', filter: { where: '[]' } }, fields: [] },
    ],
    [
      'an eleventh filter',
      {
        scope: {
          kind: 'filter',
          filter: { where: Array.from({ length: 11 }, () => ({ key: 'city', op: 'empty' })) },
        },
        fields: [],
      },
    ],
    ['a bad sort', { scope: { kind: 'filter', filter: { sort: 'city' } }, fields: [] }],
    ['no fields list', { scope: { kind: 'ids', ids: [UUID] } }],
    ['a field key with a space', { scope: { kind: 'ids', ids: [UUID] }, fields: ['full name'] }],
    ['a field key with SQL', { scope: { kind: 'ids', ids: [UUID] }, fields: ["x'; drop"] }],
    [
      'more fields than the limit',
      {
        scope: { kind: 'ids', ids: [UUID] },
        fields: Array.from({ length: LEAD_EXPORT_MAX_FIELDS + 1 }, (_, index) => `prop.f${index}`),
      },
    ],
  ])('refuses %s', (_name, body) => {
    expect(exportLeadsRequestSchema.safeParse(body).success).toBe(false);
  });

  it('keeps a full selection under the API body limit', () => {
    const body = {
      scope: {
        kind: 'ids',
        ids: Array.from(
          { length: LEAD_EXPORT_MAX_IDS },
          (_, index) => `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
        ),
      },
      fields: Array.from(
        { length: LEAD_EXPORT_MAX_FIELDS },
        (_, index) => `prop.custom_field_${index}`,
      ),
    };
    expect(exportLeadsRequestSchema.safeParse(body).success).toBe(true);
    expect(JSON.stringify(body).length).toBeLessThan(64 * 1024);
  });
});

describe('leadExportFields', () => {
  it('lists a SIM order’s fields in sheet order: main first, then each group', () => {
    const fields = leadExportFields({
      catalog: codePropertyCatalog,
      leadType: 'sim_order',
      access: owner,
    });
    expect(fields.filter((field) => field.group === 'main').map((field) => field.label)).toEqual([
      'Order / lead number',
      'Created (UTC)',
      'Lead type',
      'Name',
      'Email',
      'Phone',
      'Stage',
      'Status',
      'Assigned to',
      'Plan',
      'Payment status',
    ]);
    expect(keys(fields.filter((field) => field.group === 'form'))).toEqual([
      'prop.planId',
      'prop.delivery',
      'prop.arrivalDate',
      'prop.permitType',
      'prop.gotVisa',
      'prop.flightBooked',
      'prop.shippingAddress',
      'prop.canadaAddress',
      'prop.reference',
      'prop.customerNotes',
      'prop.simNumber',
    ]);
    expect(keys(fields.filter((field) => field.group === 'order'))).toEqual([
      'prop.quantity',
      'prop.carrierCommission',
      'prop.courier',
      'prop.trackingNumber',
      'prop.dispatchedAt',
      'prop.activatedAt',
      'prop.activationNumber',
      'prop.activationAccount',
      'planPrice',
      'planBillingPeriod',
      'planCommission',
    ]);
    expect(keys(fields.filter((field) => field.group === 'dates'))).toEqual([
      'updatedAt',
      'stageChangedAt',
      'lastActivityAt',
      'archivedAt',
    ]);
    expect(keys(fields.filter((field) => field.group === 'tasks'))).toEqual([
      'openTaskCount',
      'nextTaskDueAt',
    ]);
    expect(keys(fields.filter((field) => field.group === 'notes'))).toEqual(['noteCount']);
    // Every key is one the request schema takes, and none repeats.
    expect(new Set(keys(fields)).size).toBe(fields.length);
    expect(
      exportLeadsRequestSchema.safeParse({
        scope: { kind: 'ids', ids: [UUID] },
        fields: keys(fields),
      }).success,
    ).toBe(true);
  });

  it('writes text kinds as text, and dates, numbers and money as what they are', () => {
    const kinds = new Map(
      leadExportFields({ catalog: siteCatalog, leadType: 'sim_order', access: owner }).map(
        (field) => [field.key, field.kind],
      ),
    );
    expect(kinds.get('phone')).toBe('text');
    expect(kinds.get('reference')).toBe('text');
    expect(kinds.get('prop.simNumber')).toBe('text');
    expect(kinds.get('prop.trackingNumber')).toBe('text');
    expect(kinds.get('prop.gotVisa')).toBe('text');
    expect(kinds.get('prop.delivery')).toBe('text');
    expect(kinds.get('createdAt')).toBe('dateTime');
    expect(kinds.get('prop.arrivalDate')).toBe('date');
    expect(kinds.get('nextTaskDueAt')).toBe('date');
    expect(kinds.get('prop.quantity')).toBe('number');
    expect(kinds.get('prop.custom_budget')).toBe('money');
    expect(kinds.get('planCommission')).toBe('money');
  });

  it('a type with no order has no plan, payment or order fields', () => {
    const fields = leadExportFields({
      catalog: codePropertyCatalog,
      leadType: 'partner_application',
      access: owner,
    });
    expect(keys(fields.filter((field) => field.group === 'main'))).toEqual([
      'reference',
      'createdAt',
      'leadType',
      'fullName',
      'email',
      'phone',
      'stage',
      'status',
      'assignee',
    ]);
    expect(fields.some((field) => field.group === 'order')).toBe(false);
    expect(keys(fields)).toContain('prop.company');
  });

  it('never offers a sensitive or hidden property, and follows the site’s labels', () => {
    for (const leadType of ['internet', 'sim_order']) {
      const fields = leadExportFields({ catalog: siteCatalog, leadType, access: owner });
      expect(keys(fields)).not.toContain('prop.dateOfBirth');
      expect(keys(fields)).not.toContain('prop.custom_passport');
      expect(keys(fields)).not.toContain('prop.custom_gone');
      expect(keys(fields)).not.toContain('prop.reference');
      expect(keys(fields)).toContain('prop.custom_loyalty');
    }
    const sim = leadExportFields({ catalog: siteCatalog, leadType: 'sim_order', access: owner });
    expect(sim.find((field) => field.key === 'prop.canadaAddress')?.label).toBe(
      'Where they will live',
    );
    expect(keys(sim.filter((field) => field.group === 'custom'))).toEqual([
      'prop.custom_loyalty',
      'prop.custom_budget',
      'prop.custom_sim_only',
    ]);
    // A custom property of one type is not offered for another.
    expect(
      keys(leadExportFields({ catalog: siteCatalog, leadType: 'internet', access: owner })),
    ).not.toContain('prop.custom_sim_only');
  });

  it('gives money only with revenue access', () => {
    const input = { catalog: siteCatalog, leadType: 'sim_order' };
    expect(keys(leadExportFields({ ...input, access: owner }))).toContain('planCommission');
    const withoutMoney = keys(leadExportFields({ ...input, access: staff }));
    expect(withoutMoney).not.toContain('planCommission');
    expect(withoutMoney).toContain('planPrice');
    expect(withoutMoney).toContain('fullName');
    // Money never comes without contact access, whatever the flags say.
    expect(
      keys(leadExportFields({ ...input, access: { contacts: false, revenue: true } })),
    ).not.toContain('planCommission');
  });

  it('gives a caller without contact access only what the list shows them', () => {
    expect(
      keys(leadExportFields({ catalog: siteCatalog, leadType: 'sim_order', access: readOnly })),
    ).toEqual([
      'reference',
      'createdAt',
      'leadType',
      'stage',
      'status',
      'assignee',
      'updatedAt',
      'archivedAt',
      'source',
      'utmSource',
      'utmMedium',
      'utmCampaign',
      'utmTerm',
      'utmContent',
      'referrerHost',
      'landingPath',
      'partnerCode',
      'openTaskCount',
      'nextTaskDueAt',
    ]);
  });
});

describe('leadExportColumns', () => {
  it('always writes the main fields, then the requested ones in sheet order', () => {
    const columns = leadExportColumns({
      catalog: siteCatalog,
      leadType: 'sim_order',
      access: staff,
      // Asked for out of order, twice, with keys that name nothing or are not allowed.
      fields: [
        'noteCount',
        'prop.custom_loyalty',
        'prop.arrivalDate',
        'prop.arrivalDate',
        'planCommission',
        'prop.dateOfBirth',
        'prop.custom_passport',
        'prop.city',
        'prop.nothing',
        'sin',
      ],
    });
    expect(keys(columns)).toEqual([
      'reference',
      'createdAt',
      'leadType',
      'fullName',
      'email',
      'phone',
      'stage',
      'status',
      'assignee',
      'prop.plan',
      'prop.paymentStatus',
      'prop.arrivalDate',
      'prop.custom_loyalty',
      'noteCount',
    ]);
  });

  it('with no fields asked for, a caller without contact access gets six columns', () => {
    expect(
      keys(
        leadExportColumns({
          catalog: siteCatalog,
          leadType: 'sim_order',
          access: readOnly,
          fields: ['fullName', 'prop.plan', 'prop.arrivalDate'],
        }),
      ),
    ).toEqual(['reference', 'createdAt', 'leadType', 'stage', 'status', 'assignee']);
  });
});

describe('leadExportGroups', () => {
  it('groups one type’s fields for the picker, with labels', () => {
    const groups = leadExportGroups({
      catalog: siteCatalog,
      leadTypes: ['sim_order'],
      access: owner,
    });
    expect(groups.map((group) => [group.key, group.label])).toEqual([
      ['main', 'Main fields'],
      ['form', 'Form answers'],
      ['custom', 'Custom properties'],
      ['order', 'Order details'],
      ['dates', 'Dates'],
      ['attribution', 'Attribution and source'],
      ['tasks', 'Tasks summary'],
      ['notes', 'Notes'],
    ]);
  });

  it('joins several types, each field once, and leaves out an empty group', () => {
    const groups = leadExportGroups({
      catalog: codePropertyCatalog,
      leadTypes: ['sim_order', 'internet', 'partner_application'],
      access: owner,
    });
    const form = keys(groups.find((group) => group.key === 'form')?.fields ?? []);
    expect(form).toContain('prop.arrivalDate');
    expect(form).toContain('prop.city');
    expect(form).toContain('prop.company');
    expect(new Set(form).size).toBe(form.length);
    // The code catalogue has no custom properties.
    expect(groups.some((group) => group.key === 'custom')).toBe(false);

    const none = leadExportGroups({
      catalog: codePropertyCatalog,
      leadTypes: ['sim_order'],
      access: readOnly,
    });
    expect(none.map((group) => group.key)).toEqual(['main', 'dates', 'attribution', 'tasks']);
  });
});

describe('leadExportFileName', () => {
  it('is <site>-leads-<lead type>-<day>.xlsx', () => {
    expect(
      leadExportFileName({ siteSlug: 'getcanadasim', leadType: 'sim_order', day: '2026-11-11' }),
    ).toBe('getcanadasim-leads-sim-order-2026-11-11.xlsx');
    expect(
      leadExportFileName({ siteSlug: 'canadawide', leadType: undefined, day: '2026-11-11' }),
    ).toBe('canadawide-leads-all-2026-11-11.xlsx');
  });

  it('holds nothing a header or a file system would mind', () => {
    const name = leadExportFileName({
      siteSlug: 'Évil "site"\r\n/../x',
      leadType: '../etc',
      day: 'today',
    });
    expect(name).toBe('e-vil-site-x-leads-etc-undated.xlsx');
    expect(name).toMatch(/^[a-z0-9-]+\.xlsx$/);
    expect(leadExportFileName({ siteSlug: '', leadType: '', day: '2026-11-11' })).toBe(
      'site-leads-all-2026-11-11.xlsx',
    );
  });
});

describe('the export operation', () => {
  it('is registered as a staff POST that answers a file, and documented as one', () => {
    const endpoint = endpoints.find((entry) => entry.operationId === 'exportWorkspaceLeads');
    expect(endpoint).toMatchObject({
      method: 'POST',
      path: '/api/v1/staff/workspaces/{workspaceId}/leads/export',
      auth: 'staff',
      successStatus: 200,
      file: { contentType: LEAD_EXPORT_CONTENT_TYPE },
    });
    expect(endpoint?.response).toBeUndefined();

    const doc: unknown = buildOpenApiDocument();
    const operation = JSON.parse(JSON.stringify(doc)).paths[
      '/api/v1/staff/workspaces/{workspaceId}/leads/export'
    ].post;
    expect(operation.security).toEqual([{ staffSession: [] }]);
    expect(operation.requestBody.required).toBe(true);
    expect(operation.responses['200'].content[LEAD_EXPORT_CONTENT_TYPE].schema).toEqual({
      type: 'string',
      format: 'binary',
    });
    expect(operation.responses.default).toBeDefined();
  });

  it('the lead access flags say who may export and who sees money', () => {
    expect(
      leadAccessSchema.parse({ contacts: true, manage: true, export: true, revenue: false }),
    ).toEqual({ contacts: true, manage: true, export: true, revenue: false });
    // Absent means no: an older backend's answer still parses.
    expect(leadAccessSchema.parse({ contacts: true, manage: true }).export).toBeUndefined();
  });
});

describe('client.staff.exportLeads', () => {
  const body = {
    scope: { kind: 'ids' as const, ids: [UUID] },
    fields: ['prop.arrivalDate'],
  };

  function clientAnswering(respond: () => Response) {
    const calls: { url: string; method: string; headers: Headers; body: string | undefined }[] = [];
    const client = createBackendClient({
      baseUrl: 'https://api.example.test',
      credential: 'staff-token',
      fetch: async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method ?? 'GET',
          headers: new Headers(init?.headers),
          body: typeof init?.body === 'string' ? init.body : undefined,
        });
        return respond();
      },
    });
    return { client, calls };
  }

  it('posts the request and returns the file, its name and its row count', async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 3, 4]);
    const { client, calls } = clientAnswering(
      () =>
        new Response(bytes, {
          status: 200,
          headers: {
            'content-type': LEAD_EXPORT_CONTENT_TYPE,
            'content-disposition':
              'attachment; filename="getcanadasim-leads-sim-order-2026-11-11.xlsx"',
            'x-export-row-count': '12',
          },
        }),
    );
    const file = await client.staff.exportLeads(UUID, body);
    expect(new Uint8Array(await file.blob.arrayBuffer())).toEqual(bytes);
    expect(file.fileName).toBe('getcanadasim-leads-sim-order-2026-11-11.xlsx');
    expect(file.rowCount).toBe(12);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe(
      `https://api.example.test/api/v1/staff/workspaces/${UUID}/leads/export`,
    );
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer staff-token');
    expect(calls[0]?.headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual(body);
  });

  it('takes no file name it did not expect, and no row count that is not a number', async () => {
    const { client } = clientAnswering(
      () =>
        new Response(new Uint8Array([1]), {
          status: 200,
          headers: {
            'content-type': LEAD_EXPORT_CONTENT_TYPE,
            'content-disposition': 'attachment; filename="../../evil.exe"',
            'x-export-row-count': 'many',
          },
        }),
    );
    const file = await client.staff.exportLeads(UUID, body);
    expect(file.fileName).toBeUndefined();
    expect(file.rowCount).toBeUndefined();
  });

  it('throws a refusal as a BackendError with its details', async () => {
    const { client } = clientAnswering(
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'export_too_large',
              message: 'Too many leads.',
              requestId: UUID,
              details: { total: 6200, max: 5000 },
            },
          }),
          { status: 422, headers: { 'content-type': 'application/json' } },
        ),
    );
    const failure = await client.staff.exportLeads(UUID, body).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BackendError);
    expect(failure).toMatchObject({
      code: 'export_too_large',
      status: 422,
      details: { total: 6200, max: 5000 },
    });
  });

  it('treats a 200 that is not a workbook, or an unreadable error, as a failure', async () => {
    const html = clientAnswering(
      () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    await expect(html.client.staff.exportLeads(UUID, body)).rejects.toMatchObject({
      code: 'internal_error',
      status: 200,
    });
    const gateway = clientAnswering(() => new Response('Bad gateway', { status: 502 }));
    await expect(gateway.client.staff.exportLeads(UUID, body)).rejects.toMatchObject({
      code: 'internal_error',
      status: 502,
    });
  });

  it('refuses a request the contract does not allow before sending it', async () => {
    const { client, calls } = clientAnswering(() => new Response(null, { status: 200 }));
    await expect(
      client.staff.exportLeads(UUID, { scope: { kind: 'ids', ids: [] }, fields: [] }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
