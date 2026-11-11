import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LEAD_EXPORT_CONTENT_TYPE,
  LEAD_EXPORT_MAX_IDS,
  LEAD_EXPORT_RATE_LIMIT,
  apiErrorResponseSchema,
  codePropertyCatalog,
  type ExportLeadsRequest,
  type StaffWorkspace,
} from '@gt-sales/contracts';
import type { ErrorTracker } from '@gt-sales/adapters';
import type { RateLimitInput, RateLimitResult } from '@gt-sales/db';
import type { StaffRoleName } from '@gt-sales/types';

import { createApp } from '../src/app.js';
import type { StaffSessionVerifier, VerifiedStaffSession } from '../src/auth/session.js';
import type { LeadExportOutcome, LeadExportStore } from '../src/leads/export/store.js';
import type { LeadStore } from '../src/leads/store.js';
import type { StaffAccessSnapshot } from '../src/staff/authorization.js';
import type { StaffStore } from '../src/staff/store.js';
import type { WebsiteCredentialStore } from '../src/website/store.js';

const ACTOR = '20000000-0000-4000-8000-00000000e701';
const WORKSPACE = '10000000-0000-4000-8000-00000000e701';
const OTHER_WORKSPACE = '10000000-0000-4000-8000-00000000e702';
const MEMBERSHIP = '30000000-0000-4000-8000-00000000e701';
const LEAD = '90000000-0000-4000-8000-00000000e701';

const workspace: StaffWorkspace = {
  id: WORKSPACE,
  slug: 'getcanadasim',
  name: 'Get Canada Sim',
  membershipId: MEMBERSHIP,
  roles: ['owner'],
};

class TokenVerifier implements StaffSessionVerifier {
  async verify(accessToken: string): Promise<VerifiedStaffSession | undefined> {
    return accessToken === 'token'
      ? { actorId: ACTOR, verifiedEmail: 'owner@example.test' }
      : undefined;
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

const FILE = Buffer.from('PK-not-a-real-workbook');
const exported: LeadExportOutcome = {
  status: 'exported',
  file: FILE,
  fileName: 'getcanadasim-leads-sim-order-2026-11-11.xlsx',
  rowCount: 7,
};

let server: Server;
let baseUrl: string;
let store: MemoryStaffStore;
let exportStore: { export: ReturnType<typeof vi.fn<LeadExportStore['export']>> };
let rateLimit: ReturnType<typeof vi.fn<(input: RateLimitInput) => Promise<RateLimitResult>>>;
let captureException: ReturnType<typeof vi.fn<ErrorTracker['captureException']>>;

beforeEach(async () => {
  store = new MemoryStaffStore();
  exportStore = { export: vi.fn<LeadExportStore['export']>(async () => exported) };
  rateLimit = vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 }));
  captureException = vi.fn<ErrorTracker['captureException']>();
  server = createApp({
    staff: {
      sessionVerifier: new TokenVerifier(),
      rateLimit,
      store,
      credentialStore: noopCredentialStore,
      leadStore: unusedLeadStore,
      leadExportStore: exportStore,
      propertyStore: {
        catalog: async () => codePropertyCatalog,
        model: () => Promise.reject(new Error('unused')),
        create: () => Promise.reject(new Error('unused')),
        update: () => Promise.reject(new Error('unused')),
        remove: () => Promise.reject(new Error('unused')),
        saveLayout: () => Promise.reject(new Error('unused')),
      },
      errorTracker: { captureException },
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

const byFilter: ExportLeadsRequest = {
  scope: { kind: 'filter', filter: { type: 'sim_order' } },
  fields: ['prop.arrivalDate', 'planCommission'],
};

function post(body: unknown, options: { workspaceId?: string; token?: string } = {}) {
  return fetch(
    `${baseUrl}/api/v1/staff/workspaces/${options.workspaceId ?? WORKSPACE}/leads/export`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.token ?? 'token'}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
}

async function errorOf(response: Response) {
  return apiErrorResponseSchema.parse(await response.json()).error;
}

const as = (role: StaffRoleName, permissions: StaffAccessSnapshot['permissions'] = []) => {
  store.access = { ...store.access, roles: [role], permissions };
};

/** The export's own bucket (the first hit of every request is the per-IP staff limiter). */
const exportHits = () =>
  rateLimit.mock.calls
    .map(([input]) => input)
    .filter((input) => input.bucketKey.startsWith('lead_export:'));

describe('POST /workspaces/:workspaceId/leads/export', () => {
  it('answers the workbook as an attachment that is never cached', async () => {
    const response = await post(byFilter);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(LEAD_EXPORT_CONTENT_TYPE);
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="getcanadasim-leads-sim-order-2026-11-11.xlsx"',
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-export-row-count')).toBe('7');
    expect(Buffer.from(await response.arrayBuffer()).equals(FILE)).toBe(true);
  });

  it('lets the admin origin read the file name and the row count', async () => {
    const response = await fetch(`${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/leads/export`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
        origin: process.env['ADMIN_ORIGIN'] ?? 'http://localhost:3000',
      },
      body: JSON.stringify(byFilter),
    });
    expect(response.headers.get('access-control-expose-headers')).toBe(
      'content-disposition, x-export-row-count',
    );
  });

  it('needs a staff session', async () => {
    const response = await post(byFilter, { token: 'nope' });
    expect(response.status).toBe(401);
    expect(exportStore.export).not.toHaveBeenCalled();
  });

  it.each<[StaffRoleName, boolean]>([
    ['owner', true],
    ['leads', true],
    ['orders', true],
    ['finance', true],
    ['partners', false],
    ['content', false],
    ['viewer', false],
  ])('role %s may export: %s', async (role, allowed) => {
    as(role);
    const response = await post(byFilter);
    expect(response.status).toBe(allowed ? 200 : 403);
    if (!allowed) {
      expect((await errorOf(response)).code).toBe('permission_denied');
      expect(exportStore.export).not.toHaveBeenCalled();
      // Refused before the export's budget is touched.
      expect(exportHits()).toEqual([]);
    }
  });

  it('gives the store what the role sees: money only to the owner', async () => {
    await post(byFilter);
    expect(exportStore.export).toHaveBeenLastCalledWith({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      requestId: expect.any(String),
      scope: byFilter.scope,
      fields: byFilter.fields,
      access: { contacts: true, revenue: true },
      catalog: codePropertyCatalog,
    });

    for (const role of ['leads', 'orders', 'finance'] as const) {
      as(role);
      await post(byFilter);
      expect(exportStore.export.mock.lastCall?.[0].access).toEqual({
        contacts: true,
        revenue: false,
      });
    }
  });

  it('an individual bulk_export allow lets a read-only role export, without contact details', async () => {
    as('viewer', [{ name: 'bulk_export', effect: 'allow' }]);
    const response = await post({ scope: { kind: 'filter', filter: {} }, fields: ['source'] });
    expect(response.status).toBe(200);
    expect(exportStore.export.mock.lastCall?.[0].access).toEqual({
      contacts: false,
      revenue: false,
    });
  });

  it('a role without contact access may not search, filter or sort by what it cannot see', async () => {
    as('viewer', [{ name: 'bulk_export', effect: 'allow' }]);
    const refused: ExportLeadsRequest['scope'][] = [
      { kind: 'filter', filter: { q: 'ada' } },
      { kind: 'filter', filter: { where: [{ key: 'city', op: 'eq', value: 'Calgary' }] } },
      { kind: 'filter', filter: { sort: 'fullName:asc' } },
      { kind: 'filter', filter: { sort: 'prop.city:asc' } },
    ];
    for (const scope of refused) {
      const response = await post({ scope, fields: [] });
      expect(response.status).toBe(403);
      expect((await errorOf(response)).code).toBe('permission_denied');
    }
    expect(exportStore.export).not.toHaveBeenCalled();
    // Sorting by a date every role sees is fine.
    expect(
      (await post({ scope: { kind: 'filter', filter: { sort: 'createdAt:asc' } }, fields: [] }))
        .status,
    ).toBe(200);
  });

  it('an individual bulk_export deny refuses even a role that has it', async () => {
    for (const role of ['owner', 'leads'] as const) {
      as(role, [{ name: 'bulk_export', effect: 'deny' }]);
      const response = await post(byFilter);
      expect(response.status).toBe(403);
      expect((await errorOf(response)).code).toBe('permission_denied');
    }
    expect(exportStore.export).not.toHaveBeenCalled();
  });

  it('refuses a pending or revoked membership and a site the caller does not belong to', async () => {
    store.access = { ...store.access, status: 'revoked' };
    expect((await errorOf(await post(byFilter))).code).toBe('membership_revoked');
    store.access = { ...store.access, status: 'pending' };
    expect((await errorOf(await post(byFilter))).code).toBe('membership_pending');
    store.access = { ...store.access, status: 'active' };
    const elsewhere = await post(byFilter, { workspaceId: OTHER_WORKSPACE });
    expect(elsewhere.status).toBe(403);
    expect((await errorOf(elsewhere)).code).toBe('membership_missing');
    expect(exportStore.export).not.toHaveBeenCalled();
  });

  it('takes the site from the URL only: a body naming one is refused', async () => {
    const response = await post({ ...byFilter, workspaceId: OTHER_WORKSPACE });
    expect(response.status).toBe(400);
    expect(exportStore.export).not.toHaveBeenCalled();
  });

  it.each([
    ['no scope', { fields: [] }],
    ['no ids', { scope: { kind: 'ids', ids: [] }, fields: [] }],
    ['an id that is not a uuid', { scope: { kind: 'ids', ids: ['1'] }, fields: [] }],
    ['the same id twice', { scope: { kind: 'ids', ids: [LEAD, LEAD] }, fields: [] }],
    [
      'too many ids',
      {
        scope: {
          kind: 'ids',
          ids: Array.from(
            { length: LEAD_EXPORT_MAX_IDS + 1 },
            (_, index) => `90000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          ),
        },
        fields: [],
      },
    ],
    ['a field key that is not one', { ...byFilter, fields: ['prop.a b', 'DROP TABLE'] }],
    ['an unknown filter', { scope: { kind: 'filter', filter: { nope: 1 } }, fields: [] }],
    ['a page', { scope: { kind: 'filter', filter: { page: 2 } }, fields: [] }],
  ])('refuses %s', async (_name, body) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('invalid_request');
    expect(exportStore.export).not.toHaveBeenCalled();
  });

  it('validates filters and sort against the site catalogue, as the list does', async () => {
    const unknownProperty = await post({
      scope: {
        kind: 'filter',
        filter: { type: 'sim_order', where: [{ key: 'city', op: 'eq', value: 'x' }] },
      },
      fields: [],
    });
    expect(unknownProperty.status).toBe(400);
    const sensitiveSort = await post({
      scope: { kind: 'filter', filter: { type: 'internet', sort: 'prop.dateOfBirth:asc' } },
      fields: [],
    });
    expect(sensitiveSort.status).toBe(400);
    expect(exportStore.export).not.toHaveBeenCalled();
  });

  it('counts each export against the member and site, and refuses past the budget', async () => {
    await post(byFilter);
    expect(exportHits()).toEqual([
      {
        bucketKey: `lead_export:${ACTOR}:${WORKSPACE}`,
        windowSeconds: LEAD_EXPORT_RATE_LIMIT.windowSeconds,
        maxCount: LEAD_EXPORT_RATE_LIMIT.maxCount,
      },
    ]);

    rateLimit.mockImplementation(async (input) =>
      input.bucketKey.startsWith('lead_export:')
        ? { allowed: false, retryAfterSeconds: 120 }
        : { allowed: true, retryAfterSeconds: 0 },
    );
    exportStore.export.mockClear();
    const response = await post(byFilter);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('120');
    expect((await errorOf(response)).code).toBe('rate_limited');
    expect(exportStore.export).not.toHaveBeenCalled();
  });

  it('does not export unmetered when the limiter fails', async () => {
    rateLimit.mockImplementation(async (input) => {
      if (input.bucketKey.startsWith('lead_export:')) throw new Error('limiter down');
      return { allowed: true, retryAfterSeconds: 0 };
    });
    const response = await post(byFilter);
    expect(response.status).toBe(503);
    expect(exportStore.export).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('says how many leads there are when the export would be too large', async () => {
    exportStore.export.mockResolvedValue({ status: 'too_large', total: 6200, max: 5000 });
    const response = await post(byFilter);
    expect(response.status).toBe(422);
    expect(await errorOf(response)).toMatchObject({
      code: 'export_too_large',
      details: { total: 6200, max: 5000 },
    });
  });

  it('refuses ticked leads that are not this site’s', async () => {
    exportStore.export.mockResolvedValue({ status: 'leads_not_found', missing: 1 });
    const response = await post({ scope: { kind: 'ids', ids: [LEAD] }, fields: [] });
    expect(response.status).toBe(404);
    expect(await errorOf(response)).toMatchObject({
      code: 'lead_not_found',
      details: { missing: 1 },
    });
  });

  it('reports a failed export without leaking why', async () => {
    exportStore.export.mockRejectedValue(new Error('customer Ada Example could not be read'));
    const response = await post(byFilter);
    expect(response.status).toBe(500);
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain('Ada');
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});
