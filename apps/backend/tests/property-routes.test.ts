import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiErrorResponseSchema,
  buildPropertyCatalog,
  deletePropertyResponseSchema,
  leadTypeCatalog,
  propertyLayoutResponseSchema,
  propertyModelResponseSchema,
  propertyResponseSchema,
  propertyUsageSchema,
  type PropertyLayoutRow,
  type PropertyRow,
  type StaffWorkspace,
} from '@gt-sales/contracts';

import { createApp } from '../src/app.js';
import type { StaffSessionVerifier, VerifiedStaffSession } from '../src/auth/session.js';
import type { LeadStore } from '../src/leads/store.js';
import type { StoredPropertyRow } from '../src/properties/catalog.js';
import type { PropertyContext, PropertyStore } from '../src/properties/store.js';
import type { StaffAccessSnapshot } from '../src/staff/authorization.js';
import type { StaffStore } from '../src/staff/store.js';
import type { WebsiteCredentialStore } from '../src/website/store.js';

const ACTOR = '20000000-0000-4000-8000-000000000f01';
const WORKSPACE = '10000000-0000-4000-8000-000000000f01';
const MEMBERSHIP = '30000000-0000-4000-8000-000000000f01';
const NOW = '2026-10-29T12:00:00.000Z';

const workspace: StaffWorkspace = {
  id: WORKSPACE,
  slug: 'canadawide',
  name: 'CanadaWide',
  membershipId: MEMBERSHIP,
  roles: ['owner'],
};

function propertyRow(
  overrides: Partial<StoredPropertyRow> & Pick<PropertyRow, 'key'>,
): StoredPropertyRow {
  return {
    object: 'lead',
    origin: 'custom',
    label: 'Referral code',
    kind: 'text',
    options: [],
    staffOnly: false,
    sensitive: false,
    hidden: false,
    leadTypes: [],
    position: 0,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const referral = propertyRow({ key: 'custom_referral_code' });
const hiddenCity = propertyRow({
  key: 'city',
  origin: 'builtin',
  label: 'City',
  hidden: true,
  version: 2,
});

// A saved internet layout that still names a property deleted since (a tombstone).
const savedInternet: PropertyLayoutRow = {
  object: 'lead',
  leadType: 'internet',
  layout: {
    sections: [
      { id: 'main', label: 'Main', keys: ['planId', 'custom_gone', 'custom_referral_code'] },
      { id: 'old', label: 'Old', keys: ['custom_gone'] },
    ],
  },
  version: 3,
  updatedAt: NOW,
};

class TokenVerifier implements StaffSessionVerifier {
  readonly sessions = new Map<string, VerifiedStaffSession>([
    ['token', { actorId: ACTOR, verifiedEmail: 'owner@example.test' }],
  ]);
  async verify(accessToken: string) {
    return this.sessions.get(accessToken);
  }
}

class MemoryStaffStore implements StaffStore {
  access: StaffAccessSnapshot = {
    membershipId: MEMBERSHIP,
    status: 'active',
    roles: ['owner'],
    permissions: [],
  };
  setDisplayName = vi.fn(async () => 1);
  async bootstrapStaff() {
    return [workspace];
  }
  async loadStaffAccess(actorId: string, workspaceId: string) {
    return actorId === ACTOR && workspaceId === WORKSPACE ? this.access : undefined;
  }
  async inviteStaff(): Promise<string> {
    throw new Error('unused');
  }
  async revokeStaff() {
    return 'not_found' as const;
  }
  async listAssignableMembers() {
    return [];
  }
}

const unusedLeadStore: LeadStore = {
  readLead: async () => ({ status: 'grant_invalid' }),
  createLead: () => {
    throw new Error('unused');
  },
  updateLead: () => {
    throw new Error('unused');
  },
  listLeads: () => {
    throw new Error('unused');
  },
};

const noopCredentialStore: WebsiteCredentialStore = {
  createCredential: async () => {
    throw new Error('unused');
  },
  listCredentials: async () => [],
  revokeCredential: async () => ({ status: 'not_found' }),
};

function memoryPropertyStore() {
  return {
    catalog: vi.fn<PropertyStore['catalog']>(async () => buildPropertyCatalog([referral])),
    model: vi.fn<PropertyStore['model']>(async () => ({
      rows: [hiddenCity, referral],
      layouts: [savedInternet],
    })),
    create: vi.fn<PropertyStore['create']>(async (_ctx, _object, input) => ({
      kind: 'created',
      property: propertyRow({
        key: 'custom_referral_code',
        label: input.label,
        kind: input.kind,
        staffOnly: input.staffOnly,
      }),
    })),
    update: vi.fn<PropertyStore['update']>(async (_ctx, _object, key, input) => ({
      kind: 'updated',
      property: propertyRow({ key, label: input.label ?? 'Referral code', version: 2 }),
    })),
    remove: vi.fn<PropertyStore['remove']>(async () => ({ kind: 'deleted' })),
    saveLayout: vi.fn<PropertyStore['saveLayout']>(async (_ctx, object, leadType, layout) => ({
      kind: 'saved',
      layout: { object, leadType, layout, version: 1, updatedAt: NOW },
    })),
  } satisfies PropertyStore;
}

let server: Server;
let baseUrl: string;
let store: MemoryStaffStore;
let properties: ReturnType<typeof memoryPropertyStore>;

beforeEach(async () => {
  store = new MemoryStaffStore();
  properties = memoryPropertyStore();
  server = createApp({
    staff: {
      sessionVerifier: new TokenVerifier(),
      store,
      credentialStore: noopCredentialStore,
      leadStore: unusedLeadStore,
      propertyStore: properties,
    },
  }).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected TCP server');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const propertiesUrl = () => `${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/properties`;

function call(url: string, init: { method?: string; body?: unknown } = {}) {
  return fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      authorization: 'Bearer token',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function errorOf(response: Response) {
  return apiErrorResponseSchema.parse(await response.json()).error;
}

const ownerContext: PropertyContext = {
  workspaceId: WORKSPACE,
  actorId: ACTOR,
  requestId: expect.any(String),
};

describe('property routes', () => {
  it('GET /properties returns the model with canManage false for a leads role and true for an owner', async () => {
    store.access = { ...store.access, roles: ['leads'] };
    const asLeads = await call(propertiesUrl());
    expect(asLeads.status).toBe(200);
    const leadsBody = propertyModelResponseSchema.parse(await asLeads.json());
    expect(leadsBody.capabilities).toEqual({ canManage: false });

    store.access = { ...store.access, roles: ['owner'] };
    const asOwner = await call(propertiesUrl());
    expect(asOwner.status).toBe(200);
    const body = propertyModelResponseSchema.parse(await asOwner.json());
    expect(body.capabilities).toEqual({ canManage: true });
    expect(properties.model).toHaveBeenCalledWith(ownerContext, 'lead');

    // The whole catalogue, hidden and custom included.
    const keys = body.properties.map((property) => property.key);
    expect(keys).toContain('custom_referral_code');
    expect(body.properties.find((property) => property.key === 'city')?.hidden).toBe(true);

    // A layout for every lead type: the saved one, else the default at version 0.
    expect(Object.keys(body.layouts).sort()).toEqual(Object.keys(leadTypeCatalog).sort());
    expect(body.layouts['internet']).toEqual({
      ...savedInternet,
      layout: {
        sections: [
          { id: 'main', label: 'Main', keys: ['planId', 'custom_referral_code'] },
          { id: 'old', label: 'Old', keys: [] },
        ],
      },
    });
    const simOrder = body.layouts['sim_order'];
    expect(simOrder).toMatchObject({
      object: 'lead',
      leadType: 'sim_order',
      version: 0,
      updatedAt: null,
    });
    const simKeys = simOrder?.layout.sections.flatMap((section) => section.keys) ?? [];
    expect(simKeys).toContain('custom_referral_code');
    expect(simKeys).not.toContain('city');
  });

  it('GET /properties parses for every lead type when the site has no rows, contact_message included', async () => {
    properties.model.mockResolvedValueOnce({ rows: [], layouts: [] });
    const response = await call(propertiesUrl());
    expect(response.status).toBe(200);
    const body = propertyModelResponseSchema.parse(await response.json());
    expect(Object.keys(body.layouts).sort()).toEqual(Object.keys(leadTypeCatalog).sort());
    for (const leadType of Object.keys(leadTypeCatalog)) {
      expect(body.layouts[leadType]?.layout.sections.length, leadType).toBeGreaterThan(0);
    }
    // A type with no properties gets the one empty Request section.
    expect(body.layouts['contact_message']?.layout).toEqual({
      sections: [{ id: 'request', label: 'Request', keys: [] }],
    });
  });

  it('GET /properties is 403 for someone outside the site and 400 for a bad site id', async () => {
    store.access = { ...store.access, status: 'revoked' };
    expect((await call(propertiesUrl())).status).toBe(403);
    const bad = await call(`${baseUrl}/api/v1/staff/workspaces/not-a-uuid/properties`);
    expect(bad.status).toBe(400);
    expect(properties.model).not.toHaveBeenCalled();
  });

  it('POST /properties is 403 for a leads role and 201 for an owner', async () => {
    const input = { label: 'Referral code', kind: 'text', staffOnly: true };
    store.access = { ...store.access, roles: ['leads'] };
    const denied = await call(propertiesUrl(), { method: 'POST', body: input });
    expect(denied.status).toBe(403);
    expect(properties.create).not.toHaveBeenCalled();

    store.access = { ...store.access, roles: ['owner'] };
    const created = await call(propertiesUrl(), { method: 'POST', body: input });
    expect(created.status).toBe(201);
    const body = propertyResponseSchema.parse(await created.json());
    expect(body.property).toMatchObject({
      key: 'custom_referral_code',
      label: 'Referral code',
      origin: 'custom',
      storage: 'custom',
      staffOnly: true,
    });
    expect(properties.create).toHaveBeenCalledWith(ownerContext, 'lead', {
      label: 'Referral code',
      kind: 'text',
      options: [],
      staffOnly: true,
      sensitive: false,
      leadTypes: [],
    });

    const invalid = await call(propertiesUrl(), {
      method: 'POST',
      body: { label: 'Tier', kind: 'choice' },
    });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).code).toBe('invalid_request');

    properties.create.mockResolvedValueOnce({ kind: 'limit_reached' });
    const full = await call(propertiesUrl(), { method: 'POST', body: input });
    expect(full.status).toBe(409);
    expect((await errorOf(full)).code).toBe('property_limit');
  });

  it('PATCH maps builtin_locked to 400 and option_in_use to 409 with details', async () => {
    const url = `${propertiesUrl()}/custom_referral_code`;
    const changed = await call(url, {
      method: 'PATCH',
      body: { expectedVersion: 1, label: 'Referrer' },
    });
    expect(changed.status).toBe(200);
    expect(propertyResponseSchema.parse(await changed.json()).property).toMatchObject({
      key: 'custom_referral_code',
      label: 'Referrer',
      version: 2,
    });
    expect(properties.update).toHaveBeenCalledWith(ownerContext, 'lead', 'custom_referral_code', {
      expectedVersion: 1,
      label: 'Referrer',
    });

    const cases = [
      [{ kind: 'builtin_locked' }, 400, 'builtin_property_locked', undefined],
      [
        {
          kind: 'option_in_use',
          optionValue: 'gold',
          leadCount: 3,
          active: 1,
          trashed: 1,
          restricted: 1,
        },
        409,
        'property_option_in_use',
        { optionValue: 'gold', leadCount: 3, active: 1, trashed: 1, restricted: 1 },
      ],
      [{ kind: 'not_found' }, 404, 'property_not_found', undefined],
      [{ kind: 'version_conflict' }, 409, 'version_conflict', undefined],
      [{ kind: 'invalid_options' }, 400, 'invalid_request', undefined],
    ] as const;
    for (const [outcome, status, code, details] of cases) {
      properties.update.mockResolvedValueOnce(outcome);
      const response = await call(url, {
        method: 'PATCH',
        body: { expectedVersion: 1, label: 'Referrer' },
      });
      expect(response.status).toBe(status);
      const error = await errorOf(response);
      expect(error.code).toBe(code);
      expect(error.details).toEqual(details);
    }

    for (const [path, body] of [
      ['Bad-Key', { expectedVersion: 1, label: 'x' }],
      ['custom_referral_code', { expectedVersion: 1 }],
    ] as const) {
      const response = await call(`${propertiesUrl()}/${path}`, { method: 'PATCH', body });
      expect(response.status).toBe(400);
      expect((await errorOf(response)).code).toBe('invalid_request');
    }

    store.access = { ...store.access, roles: ['leads'] };
    const denied = await call(url, { method: 'PATCH', body: { expectedVersion: 1, label: 'x' } });
    expect(denied.status).toBe(403);
    expect(properties.update).toHaveBeenCalledTimes(6);
  });

  it('DELETE maps in_use to 409 with the lead count and its split', async () => {
    const url = `${propertiesUrl()}/custom_referral_code`;
    properties.remove.mockResolvedValueOnce({
      kind: 'in_use',
      leadCount: 4,
      active: 1,
      trashed: 2,
      restricted: 1,
    });
    const inUse = await call(url, { method: 'DELETE' });
    expect(inUse.status).toBe(409);
    const error = await errorOf(inUse);
    expect(error.code).toBe('property_in_use');
    expect(propertyUsageSchema.parse(error.details)).toEqual({
      leadCount: 4,
      active: 1,
      trashed: 2,
      restricted: 1,
    });
    expect(error.details).toEqual({ leadCount: 4, active: 1, trashed: 2, restricted: 1 });

    const deleted = await call(url, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(deletePropertyResponseSchema.parse(await deleted.json()).key).toBe(
      'custom_referral_code',
    );
    expect(properties.remove).toHaveBeenCalledWith(ownerContext, 'lead', 'custom_referral_code');

    for (const [outcome, status, code] of [
      [{ kind: 'not_found' }, 404, 'property_not_found'],
      [{ kind: 'builtin' }, 400, 'builtin_property_locked'],
    ] as const) {
      properties.remove.mockResolvedValueOnce(outcome);
      const response = await call(url, { method: 'DELETE' });
      expect(response.status).toBe(status);
      expect((await errorOf(response)).code).toBe(code);
    }

    store.access = { ...store.access, roles: ['leads'] };
    expect((await call(url, { method: 'DELETE' })).status).toBe(403);
    expect(properties.remove).toHaveBeenCalledTimes(4);
  });

  it('PATCH /properties/layouts/not_a_type is 400', async () => {
    const layout = { sections: [{ id: 'main', label: 'Main', keys: ['planId'] }] };
    const unknownType = await call(`${propertiesUrl()}/layouts/not_a_type`, {
      method: 'PATCH',
      body: { layout },
    });
    expect(unknownType.status).toBe(400);
    expect((await errorOf(unknownType)).code).toBe('invalid_request');
    expect(properties.saveLayout).not.toHaveBeenCalled();

    const url = `${propertiesUrl()}/layouts/internet`;
    const saved = await call(url, { method: 'PATCH', body: { layout, expectedVersion: 3 } });
    expect(saved.status).toBe(200);
    expect(propertyLayoutResponseSchema.parse(await saved.json()).layout).toEqual({
      object: 'lead',
      leadType: 'internet',
      layout,
      version: 1,
      updatedAt: NOW,
    });
    expect(properties.saveLayout).toHaveBeenCalledWith(ownerContext, 'lead', 'internet', layout, 3);

    properties.saveLayout.mockResolvedValueOnce({ kind: 'unknown_key', key: 'custom_gone' });
    const unknownKey = await call(url, { method: 'PATCH', body: { layout } });
    expect(unknownKey.status).toBe(400);
    const unknownError = await errorOf(unknownKey);
    expect(unknownError.code).toBe('unknown_property_key');
    expect(unknownError.details).toEqual({ key: 'custom_gone' });

    properties.saveLayout.mockResolvedValueOnce({ kind: 'version_conflict' });
    const stale = await call(url, { method: 'PATCH', body: { layout, expectedVersion: 2 } });
    expect(stale.status).toBe(409);
    expect((await errorOf(stale)).code).toBe('version_conflict');

    const invalid = await call(url, { method: 'PATCH', body: { layout: { sections: [] } } });
    expect(invalid.status).toBe(400);

    store.access = { ...store.access, roles: ['leads'] };
    expect((await call(url, { method: 'PATCH', body: { layout } })).status).toBe(403);
    expect(properties.saveLayout).toHaveBeenCalledTimes(3);
  });
});

describe('property routes for plans (?object=plan)', () => {
  const network = propertyRow({
    object: 'plan',
    key: 'custom_network',
    label: 'Network',
    websiteVisible: true,
  });
  const cost = propertyRow({
    object: 'plan',
    key: 'custom_cost',
    label: 'Cost',
    kind: 'number',
    position: 1,
  });
  const planLayout = { sections: [{ id: 'main', label: 'Main', keys: ['custom_network'] }] };

  it('GET returns the plan catalogue with website visibility and one layout keyed by no type', async () => {
    properties.model.mockResolvedValueOnce({ rows: [network, cost], layouts: [] });
    const response = await call(`${propertiesUrl()}?object=plan`);
    expect(response.status).toBe(200);
    const raw: unknown = await response.json();
    const body = propertyModelResponseSchema.parse(raw);
    expect(properties.model).toHaveBeenCalledWith(ownerContext, 'plan');
    expect(body.properties.map((property) => property.key)).toEqual([
      'custom_network',
      'custom_cost',
    ]);
    // TODO(task 2): read websiteVisible from the parsed body once sitePropertySchema has it.
    expect(raw).toMatchObject({
      properties: [
        { key: 'custom_network', websiteVisible: true },
        { key: 'custom_cost', websiteVisible: false },
      ],
    });
    expect(body.layouts).toEqual({
      '': {
        object: 'plan',
        leadType: '',
        layout: {
          sections: [{ id: 'custom', label: 'Custom', keys: ['custom_network', 'custom_cost'] }],
        },
        version: 0,
        updatedAt: null,
      },
    });

    const saved = {
      object: 'plan',
      leadType: '',
      layout: planLayout,
      version: 2,
      updatedAt: NOW,
    } as const;
    properties.model.mockResolvedValueOnce({ rows: [network], layouts: [saved] });
    const withSaved = propertyModelResponseSchema.parse(
      await (await call(`${propertiesUrl()}?object=plan`)).json(),
    );
    expect(withSaved.layouts).toEqual({ '': saved });

    // With no plan properties the default still has one (empty) section.
    properties.model.mockResolvedValueOnce({ rows: [], layouts: [] });
    const empty = propertyModelResponseSchema.parse(
      await (await call(`${propertiesUrl()}?object=plan`)).json(),
    );
    expect(empty.layouts['']?.layout).toEqual({
      sections: [{ id: 'custom', label: 'Custom', keys: [] }],
    });

    for (const query of ['?object=order', '?object=plan&object=lead']) {
      const bad = await call(`${propertiesUrl()}${query}`);
      expect(bad.status, query).toBe(400);
      expect((await errorOf(bad)).code).toBe('invalid_request');
    }
  });

  it('websiteVisible is accepted on plan properties only', async () => {
    properties.create.mockResolvedValueOnce({ kind: 'created', property: network });
    const created = await call(`${propertiesUrl()}?object=plan`, {
      method: 'POST',
      body: { label: 'Network', kind: 'text', websiteVisible: true },
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      property: { key: 'custom_network', websiteVisible: true },
    });
    expect(properties.create).toHaveBeenCalledWith(ownerContext, 'plan', {
      label: 'Network',
      kind: 'text',
      options: [],
      staffOnly: false,
      sensitive: false,
      leadTypes: [],
      websiteVisible: true,
    });

    properties.update.mockResolvedValueOnce({
      kind: 'updated',
      property: { ...network, websiteVisible: false, version: 2 },
    });
    const updated = await call(`${propertiesUrl()}/custom_network?object=plan`, {
      method: 'PATCH',
      body: { expectedVersion: 1, websiteVisible: false },
    });
    expect(updated.status).toBe(200);
    expect(properties.update).toHaveBeenCalledWith(ownerContext, 'plan', 'custom_network', {
      expectedVersion: 1,
      websiteVisible: false,
    });

    const leadCreate = await call(propertiesUrl(), {
      method: 'POST',
      body: { label: 'Network', kind: 'text', websiteVisible: true },
    });
    expect(leadCreate.status).toBe(400);
    expect((await errorOf(leadCreate)).code).toBe('invalid_request');
    const leadUpdate = await call(`${propertiesUrl()}/custom_referral_code?object=lead`, {
      method: 'PATCH',
      body: { expectedVersion: 1, websiteVisible: true },
    });
    expect(leadUpdate.status).toBe(400);
    expect((await errorOf(leadUpdate)).code).toBe('invalid_request');
    // Off (the default) is no change on a lead property, so it passes.
    const leadOff = await call(propertiesUrl(), {
      method: 'POST',
      body: { label: 'Network', kind: 'text', websiteVisible: false },
    });
    expect(leadOff.status).toBe(201);
    const notBoolean = await call(`${propertiesUrl()}?object=plan`, {
      method: 'POST',
      body: { label: 'Network', kind: 'text', websiteVisible: 'yes' },
    });
    expect(notBoolean.status).toBe(400);
    expect(properties.create).toHaveBeenCalledTimes(2);
    expect(properties.update).toHaveBeenCalledTimes(1);
  });

  it('DELETE reaches the plan object and reports plan usage', async () => {
    properties.remove.mockResolvedValueOnce({
      kind: 'in_use',
      leadCount: 0,
      active: 3,
      trashed: 0,
      restricted: 0,
      planCount: 3,
    });
    const inUse = await call(`${propertiesUrl()}/custom_network?object=plan`, {
      method: 'DELETE',
    });
    expect(inUse.status).toBe(409);
    const error = await errorOf(inUse);
    expect(error.code).toBe('property_in_use');
    expect(propertyUsageSchema.parse(error.details)).toEqual({
      leadCount: 0,
      active: 3,
      trashed: 0,
      restricted: 0,
      planCount: 3,
    });
    expect(properties.remove).toHaveBeenCalledWith(ownerContext, 'plan', 'custom_network');
  });

  it('the plan layout is saved under no lead type', async () => {
    for (const path of ['/layouts?object=plan', '/layouts/?object=plan']) {
      const saved = await call(`${propertiesUrl()}${path}`, {
        method: 'PATCH',
        body: { layout: planLayout },
      });
      expect(saved.status, path).toBe(200);
      expect(propertyLayoutResponseSchema.parse(await saved.json()).layout).toMatchObject({
        object: 'plan',
        leadType: '',
      });
    }
    expect(properties.saveLayout).toHaveBeenCalledWith(
      ownerContext,
      'plan',
      '',
      planLayout,
      undefined,
    );

    for (const path of ['/layouts/sim_order?object=plan', '/layouts', '/layouts?object=lead']) {
      const refused = await call(`${propertiesUrl()}${path}`, {
        method: 'PATCH',
        body: { layout: planLayout },
      });
      expect(refused.status, path).toBe(400);
      expect((await errorOf(refused)).code).toBe('invalid_request');
    }
    expect(properties.saveLayout).toHaveBeenCalledTimes(2);
  });
});
