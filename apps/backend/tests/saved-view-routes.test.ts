import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  apiErrorResponseSchema,
  buildPropertyCatalog,
  codePropertyCatalog,
  DEFAULT_LEAD_VIEW_STATE,
  deleteSavedViewResponseSchema,
  leadPropertyCatalog,
  listSavedViewsResponseSchema,
  propertyRowSchema,
  savedViewResponseSchema,
  type PropertyCatalog,
  type SavedView,
  type SavedViewState,
} from '@gt-sales/contracts';

import { createApp } from '../src/app.js';
import type { StaffSessionVerifier, VerifiedStaffSession } from '../src/auth/session.js';
import type { LeadStore } from '../src/leads/store.js';
import type { StaffAccessSnapshot } from '../src/staff/authorization.js';
import type { StaffStore } from '../src/staff/store.js';
import type { SavedViewStore } from '../src/views/store.js';
import type { WebsiteCredentialStore } from '../src/website/store.js';

const ACTOR = '20000000-0000-4000-8000-0000000007b1';
const WORKSPACE = '10000000-0000-4000-8000-0000000007b1';
const MEMBERSHIP = '30000000-0000-4000-8000-0000000007b1';
const VIEW = '95000000-0000-4000-8000-0000000007b1';
const NOW = '2026-10-29T12:00:00.000Z';

const storedState: SavedViewState = {
  ...DEFAULT_LEAD_VIEW_STATE,
  leadType: 'internet',
  where: [{ key: 'city', op: 'eq', value: 'Calgary' }],
  columns: ['city', 'planId'],
  sort: 'prop.city:desc',
};

const stored: SavedView = {
  id: VIEW,
  object: 'lead',
  name: 'Calgary',
  state: storedState,
  version: 3,
  updatedAt: NOW,
};

/** The site has hidden the built-in `city` since the view was saved. */
const cityHidden = buildPropertyCatalog([
  propertyRowSchema.parse({
    object: 'lead',
    key: 'city',
    origin: 'builtin',
    label: leadPropertyCatalog['city']?.label ?? 'City',
    kind: 'text',
    options: [],
    staffOnly: false,
    sensitive: false,
    hidden: true,
    leadTypes: [],
    position: 0,
    version: 2,
    createdAt: NOW,
    updatedAt: NOW,
  }),
]);

const cleanedState: SavedViewState = {
  ...DEFAULT_LEAD_VIEW_STATE,
  leadType: 'internet',
  where: [],
  columns: ['planId'],
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
  access: StaffAccessSnapshot | undefined = {
    membershipId: MEMBERSHIP,
    status: 'active',
    roles: ['leads'],
    permissions: [],
  };
  async bootstrapStaff() {
    return [];
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
  async setDisplayName() {
    return 0;
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

function memoryViewStore() {
  return {
    list: vi.fn<SavedViewStore['list']>(async () => [stored]),
    create: vi.fn<SavedViewStore['create']>(async (_ctx, input) => ({
      kind: 'created',
      view: { ...stored, name: input.name, state: input.state, version: 1 },
    })),
    update: vi.fn<SavedViewStore['update']>(async (_ctx, _viewId, input) => ({
      kind: 'updated',
      view: {
        ...stored,
        name: input.name ?? stored.name,
        state: input.state ?? stored.state,
        version: input.expectedVersion + 1,
      },
    })),
    delete: vi.fn<SavedViewStore['delete']>(async () => ({ kind: 'deleted' })),
  } satisfies SavedViewStore;
}

let server: Server;
let baseUrl: string;
let staffStore: MemoryStaffStore;
let views: ReturnType<typeof memoryViewStore>;
let catalog: PropertyCatalog;
let loadPropertyCatalog: Mock<
  (ctx: { workspaceId: string; actorId: string }) => Promise<PropertyCatalog>
>;

beforeEach(async () => {
  staffStore = new MemoryStaffStore();
  views = memoryViewStore();
  catalog = codePropertyCatalog;
  loadPropertyCatalog = vi.fn(async () => catalog);
  server = createApp({
    staff: {
      sessionVerifier: new TokenVerifier(),
      store: staffStore,
      credentialStore: noopCredentialStore,
      leadStore: unusedLeadStore,
      savedViewStore: views,
      loadPropertyCatalog,
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

const viewsUrl = (suffix = '') => `${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/views${suffix}`;

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

async function errorCode(response: Response) {
  return apiErrorResponseSchema.parse(await response.json()).error.code;
}

const scope = { workspaceId: WORKSPACE, actorId: ACTOR };

describe('saved view routes', () => {
  it('refuses every route to a role that cannot see contacts, and to a non-member', async () => {
    for (const roles of [['viewer'], ['partners'], ['content']] as const) {
      staffStore.access = {
        membershipId: MEMBERSHIP,
        status: 'active',
        roles,
        permissions: [],
      };
      const responses = [
        await call(viewsUrl('?object=lead')),
        await call(viewsUrl(), { method: 'POST', body: { name: 'Mine', state: storedState } }),
        await call(viewsUrl(`/${VIEW}`), {
          method: 'PATCH',
          body: { expectedVersion: 3, name: 'Renamed' },
        }),
        await call(viewsUrl(`/${VIEW}`), { method: 'DELETE' }),
      ];
      for (const response of responses) {
        expect(response.status).toBe(403);
        expect(await errorCode(response)).toBe('permission_denied');
      }
    }

    staffStore.access = undefined;
    const outsider = await call(viewsUrl());
    expect(outsider.status).toBe(403);
    expect(await errorCode(outsider)).toBe('membership_missing');

    expect(views.list).not.toHaveBeenCalled();
    expect(views.create).not.toHaveBeenCalled();
    expect(views.update).not.toHaveBeenCalled();
    expect(views.delete).not.toHaveBeenCalled();
  });

  it("lists the caller's views, each cleaned against the site's catalogue", async () => {
    const plain = await call(viewsUrl('?object=lead'));
    expect(plain.status).toBe(200);
    expect(listSavedViewsResponseSchema.parse(await plain.json()).views).toEqual([stored]);
    expect(views.list).toHaveBeenCalledWith(scope, 'lead');
    expect(loadPropertyCatalog).toHaveBeenCalledWith(scope);

    catalog = cityHidden;
    const cleaned = await call(viewsUrl());
    expect(cleaned.status).toBe(200);
    expect(listSavedViewsResponseSchema.parse(await cleaned.json()).views).toEqual([
      { ...stored, state: cleanedState },
    ]);
    // The cleaning is applied to the answer, never written back.
    expect(views.update).not.toHaveBeenCalled();

    const unknownObject = await call(viewsUrl('?object=deal'));
    expect(unknownObject.status).toBe(400);
    expect(await errorCode(unknownObject)).toBe('invalid_request');
  });

  it('creates a view with 201 and maps name_taken and limit_reached to 409', async () => {
    catalog = cityHidden;
    const response = await call(viewsUrl(), {
      method: 'POST',
      body: { name: '  Calgary  ', state: storedState },
    });
    expect(response.status).toBe(201);
    const body = savedViewResponseSchema.parse(await response.json());
    expect(body.view).toMatchObject({ name: 'Calgary', version: 1, state: cleanedState });
    // What the person saved is stored as they saved it.
    expect(views.create).toHaveBeenCalledWith(scope, {
      object: 'lead',
      name: 'Calgary',
      state: storedState,
    });

    views.create.mockResolvedValueOnce({ kind: 'name_taken' });
    const taken = await call(viewsUrl(), {
      method: 'POST',
      body: { name: 'x', state: storedState },
    });
    expect(taken.status).toBe(409);
    expect(await errorCode(taken)).toBe('saved_view_name_taken');

    views.create.mockResolvedValueOnce({ kind: 'limit_reached' });
    const full = await call(viewsUrl(), {
      method: 'POST',
      body: { name: 'y', state: storedState },
    });
    expect(full.status).toBe(409);
    expect(await errorCode(full)).toBe('saved_view_limit');
  });

  it('updates with 200 and maps not_found to 404, version_conflict and name_taken to 409', async () => {
    catalog = cityHidden;
    const response = await call(viewsUrl(`/${VIEW}`), {
      method: 'PATCH',
      body: { expectedVersion: 3, state: storedState },
    });
    expect(response.status).toBe(200);
    expect(savedViewResponseSchema.parse(await response.json()).view).toMatchObject({
      id: VIEW,
      version: 4,
      state: cleanedState,
    });
    expect(views.update).toHaveBeenCalledWith(scope, VIEW, {
      expectedVersion: 3,
      state: storedState,
    });

    const cases = [
      [{ kind: 'not_found' }, 404, 'saved_view_not_found'],
      [{ kind: 'version_conflict' }, 409, 'version_conflict'],
      [{ kind: 'name_taken' }, 409, 'saved_view_name_taken'],
    ] as const;
    for (const [outcome, status, code] of cases) {
      views.update.mockResolvedValueOnce(outcome);
      const res = await call(viewsUrl(`/${VIEW}`), {
        method: 'PATCH',
        body: { expectedVersion: 3, name: 'Renamed' },
      });
      expect(res.status).toBe(status);
      expect(await errorCode(res)).toBe(code);
    }
  });

  it('deletes with 200 and maps not_found to 404', async () => {
    const response = await call(viewsUrl(`/${VIEW}`), { method: 'DELETE' });
    expect(response.status).toBe(200);
    expect(deleteSavedViewResponseSchema.parse(await response.json()).viewId).toBe(VIEW);
    expect(views.delete).toHaveBeenCalledWith(scope, VIEW);

    views.delete.mockResolvedValueOnce({ kind: 'not_found' });
    const missing = await call(viewsUrl(`/${VIEW}`), { method: 'DELETE' });
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe('saved_view_not_found');
  });

  it('rejects search text in a state, an empty change and a malformed id with 400', async () => {
    const withSearch = { ...storedState, q: 'avery' };
    const invalid = [
      await call(viewsUrl(), { method: 'POST', body: { name: 'Search', state: withSearch } }),
      await call(viewsUrl(), { method: 'POST', body: { name: '   ', state: storedState } }),
      await call(viewsUrl(), {
        method: 'POST',
        body: { name: 'Paged', state: { ...storedState, page: 2 } },
      }),
      await call(viewsUrl(`/${VIEW}`), {
        method: 'PATCH',
        body: { expectedVersion: 3, state: withSearch },
      }),
      await call(viewsUrl(`/${VIEW}`), { method: 'PATCH', body: { expectedVersion: 3 } }),
      await call(viewsUrl('/not-a-uuid'), {
        method: 'PATCH',
        body: { expectedVersion: 3, name: 'x' },
      }),
      await call(viewsUrl('/not-a-uuid'), { method: 'DELETE' }),
    ];
    for (const response of invalid) {
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe('invalid_request');
    }
    expect(views.create).not.toHaveBeenCalled();
    expect(views.update).not.toHaveBeenCalled();
    expect(views.delete).not.toHaveBeenCalled();
  });

  it('answers 500 without detail when the store fails', async () => {
    views.list.mockRejectedValueOnce(new Error('connection lost'));
    const response = await call(viewsUrl());
    expect(response.status).toBe(500);
    expect(await errorCode(response)).toBe('internal_error');
  });
});
