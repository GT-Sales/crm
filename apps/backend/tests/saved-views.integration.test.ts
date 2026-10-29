import type { Server } from 'node:http';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import {
  buildPropertyCatalog,
  DEFAULT_LEAD_VIEW_STATE,
  listSavedViewsResponseSchema,
  propertyRowSchema,
  SAVED_VIEW_LIMIT,
  savedViewResponseSchema,
  savedViewSchema,
  type SavedViewState,
} from '@gt-sales/contracts';

import { createApp } from '../src/app.js';
import type { LeadStore } from '../src/leads/store.js';
import type { StaffStore } from '../src/staff/store.js';
import { DatabaseSavedViewStore } from '../src/views/store.js';
import type { WebsiteCredentialStore } from '../src/website/store.js';

function getDisposableTestDatabaseUrl(): string | undefined {
  const migrationUrl = process.env.TEST_MIGRATION_DATABASE_URL;
  const destructiveTestsEnabled = process.env.DB_TEST_ALLOW_DESTRUCTIVE === '1';

  if (!migrationUrl && !destructiveTestsEnabled && !process.env.CI) return undefined;
  if (!migrationUrl || !destructiveTestsEnabled) {
    throw new Error(
      'Database integration tests require TEST_MIGRATION_DATABASE_URL and DB_TEST_ALLOW_DESTRUCTIVE=1 together.',
    );
  }

  const databaseName = decodeURIComponent(new URL(migrationUrl).pathname.slice(1));
  if (!databaseName.endsWith('_test')) {
    throw new Error('TEST_MIGRATION_DATABASE_URL must name a disposable database ending in _test.');
  }

  return migrationUrl;
}

const migrationUrl = getDisposableTestDatabaseUrl();
const databaseTest = migrationUrl ? describe : describe.skip;

// A distinct id range from every other integration test file sharing this database.
const WORKSPACE = '1a000000-0000-4000-8000-0000000007a1';
const OTHER_WORKSPACE = '1a000000-0000-4000-8000-0000000007a2';
const ACTOR = '2a000000-0000-4000-8000-0000000007a1';
const COLLEAGUE = '2a000000-0000-4000-8000-0000000007a2';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';

const mine = { workspaceId: WORKSPACE, actorId: ACTOR };
const colleagues = { workspaceId: WORKSPACE, actorId: COLLEAGUE };
const mineElsewhere = { workspaceId: OTHER_WORKSPACE, actorId: ACTOR };

const cityView: SavedViewState = {
  ...DEFAULT_LEAD_VIEW_STATE,
  where: [{ key: 'city', op: 'eq', value: 'Calgary' }],
  columns: ['city', 'planId'],
  sort: 'prop.city:asc',
};

const STAMP = '2026-10-29T12:00:00.000Z';

/** The site has hidden the built-in `city` since the view was saved. */
const cityHidden = buildPropertyCatalog([
  propertyRowSchema.parse({
    object: 'lead',
    key: 'city',
    origin: 'builtin',
    label: 'City',
    kind: 'text',
    options: [],
    staffOnly: false,
    sensitive: false,
    hidden: true,
    leadTypes: [],
    position: 0,
    version: 2,
    createdAt: STAMP,
    updatedAt: STAMP,
  }),
]);

/** Just enough of the staff surface to reach the view routes as ACTOR with a leads role. */
const leadsRoleStaffStore: StaffStore = {
  bootstrapStaff: async () => [],
  loadStaffAccess: async (actorId, workspaceId) =>
    actorId === ACTOR && workspaceId === WORKSPACE
      ? { membershipId: ACTOR, status: 'active', roles: ['leads'], permissions: [] }
      : undefined,
  inviteStaff: async () => {
    throw new Error('unused');
  },
  revokeStaff: async () => 'not_found',
  listAssignableMembers: async () => [],
  setDisplayName: async () => 0,
};

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

const unusedCredentialStore: WebsiteCredentialStore = {
  createCredential: async () => {
    throw new Error('unused');
  },
  listCredentials: async () => [],
  revokeCredential: async () => ({ status: 'not_found' }),
};

async function created(
  store: DatabaseSavedViewStore,
  ctx: { workspaceId: string; actorId: string },
  name: string,
  state: SavedViewState = DEFAULT_LEAD_VIEW_STATE,
) {
  const outcome = await store.create(ctx, { object: 'lead', name, state });
  if (outcome.kind !== 'created') throw new Error(`expected ${name} to be created`);
  return outcome.view;
}

databaseTest('DatabaseSavedViewStore', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  // The same store on a connection that bypasses row-level security, so only
  // the store's own `actor_id` predicates keep one person's views from another.
  let unrestricted: DatabaseClient;
  let store: DatabaseSavedViewStore;
  let storeWithoutRls: DatabaseSavedViewStore;

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    // The cascade removes the memberships and their views.
    await admin`delete from app.workspaces where id in (${WORKSPACE}, ${OTHER_WORKSPACE})`;
    await admin`
      insert into app.workspaces (id, slug, name)
      values
        (${WORKSPACE}, 'ci-saved-views', 'CI Saved Views'),
        (${OTHER_WORKSPACE}, 'ci-saved-views-other', 'CI Saved Views Other')
    `;
    await admin`
      insert into app.memberships (workspace_id, user_id, membership_type, status, accepted_at)
      values
        (${WORKSPACE}, ${ACTOR}, 'staff', 'active', now()),
        (${WORKSPACE}, ${COLLEAGUE}, 'staff', 'active', now()),
        (${OTHER_WORKSPACE}, ${ACTOR}, 'staff', 'active', now())
    `;

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      maxConnections: 1,
      ssl: false,
    });
    unrestricted = createDatabaseClient({
      connectionString: migrationUrl,
      maxConnections: 1,
      ssl: false,
    });
    store = new DatabaseSavedViewStore(database);
    storeWithoutRls = new DatabaseSavedViewStore(unrestricted);
  });

  beforeEach(async () => {
    await admin`delete from app.saved_views where workspace_id in (${WORKSPACE}, ${OTHER_WORKSPACE})`;
  });

  afterAll(async () => {
    await unrestricted?.close();
    await database?.close();
    await admin?.end();
  });

  it("lists only the caller's views in that workspace, sorted by name", async () => {
    await created(store, mine, 'zebra');
    await created(store, mine, 'Apples', cityView);
    await created(store, mine, 'mango');
    await created(store, colleagues, 'Colleague view');
    await created(store, mineElsewhere, 'Other site view');

    const views = await store.list(mine, 'lead');
    expect(views.map((view) => view.name)).toEqual(['Apples', 'mango', 'zebra']);
    for (const view of views) expect(savedViewSchema.safeParse(view).success).toBe(true);
    expect(views[0]).toMatchObject({ object: 'lead', version: 1, state: cityView });

    expect((await store.list(colleagues, 'lead')).map((view) => view.name)).toEqual([
      'Colleague view',
    ]);
    expect((await store.list(mineElsewhere, 'lead')).map((view) => view.name)).toEqual([
      'Other site view',
    ]);
    // Belt and braces: without row-level security the store still scopes to the caller.
    expect((await storeWithoutRls.list(mine, 'lead')).map((view) => view.name)).toEqual([
      'Apples',
      'mango',
      'zebra',
    ]);
  });

  it('name uniqueness ignores case per person; another person may reuse the name', async () => {
    const first = await created(store, mine, 'Hot leads');
    expect(
      await store.create(mine, { object: 'lead', name: 'HOT LEADS', state: cityView }),
    ).toEqual({ kind: 'name_taken' });
    expect((await created(store, colleagues, 'hot leads')).name).toBe('hot leads');
    expect((await created(store, mineElsewhere, 'Hot leads')).name).toBe('Hot leads');

    const second = await created(store, mine, 'Cold leads');
    expect(await store.update(mine, second.id, { expectedVersion: 1, name: 'hot LEADS' })).toEqual({
      kind: 'name_taken',
    });
    // A failed rename leaves the view as it was.
    expect((await store.list(mine, 'lead')).map((view) => [view.name, view.version])).toEqual([
      ['Cold leads', 1],
      [first.name, 1],
    ]);
    // Renaming a view to a new casing of its own name is not a clash.
    const renamed = await store.update(mine, first.id, { expectedVersion: 1, name: 'HOT leads' });
    expect(renamed).toMatchObject({ kind: 'updated', view: { name: 'HOT leads', version: 2 } });
  });

  it('the 31st view is limit_reached', async () => {
    for (let index = 0; index < SAVED_VIEW_LIMIT; index += 1) {
      await created(store, mine, `View ${String(index).padStart(2, '0')}`);
    }
    expect(
      await store.create(mine, { object: 'lead', name: 'One too many', state: cityView }),
    ).toEqual({ kind: 'limit_reached' });
    expect(await store.list(mine, 'lead')).toHaveLength(SAVED_VIEW_LIMIT);
    // The limit is per person and site.
    expect((await created(store, colleagues, 'Still room')).name).toBe('Still room');
    expect((await created(store, mineElsewhere, 'Still room')).name).toBe('Still room');
  });

  it("update needs the current version; delete of another person's id is not_found", async () => {
    const view = await created(store, mine, 'Pipeline');
    const colleagueView = await created(store, colleagues, 'Theirs');

    const updated = await store.update(mine, view.id, { expectedVersion: 1, state: cityView });
    expect(updated).toMatchObject({
      kind: 'updated',
      view: { id: view.id, name: 'Pipeline', version: 2, state: cityView },
    });
    if (updated.kind !== 'updated') throw new Error('expected an update');
    expect(Date.parse(updated.view.updatedAt)).toBeGreaterThanOrEqual(Date.parse(view.updatedAt));

    expect(await store.update(mine, view.id, { expectedVersion: 1, name: 'Stale' })).toEqual({
      kind: 'version_conflict',
    });
    expect(
      await store.update(mine, colleagueView.id, { expectedVersion: 1, name: 'Mine now' }),
    ).toEqual({ kind: 'not_found' });
    expect(
      await store.update(mine, '2a000000-0000-4000-8000-0000000007ff', {
        expectedVersion: 1,
        name: 'Nowhere',
      }),
    ).toEqual({ kind: 'not_found' });
    expect(await store.delete(mine, colleagueView.id)).toEqual({ kind: 'not_found' });
    expect(await store.delete(mineElsewhere, view.id)).toEqual({ kind: 'not_found' });

    // Belt and braces: without row-level security another person's view is still out of reach.
    expect(
      await storeWithoutRls.update(mine, colleagueView.id, { expectedVersion: 1, name: 'Mine' }),
    ).toEqual({ kind: 'not_found' });
    expect(await storeWithoutRls.delete(mine, colleagueView.id)).toEqual({ kind: 'not_found' });
    expect(await store.list(colleagues, 'lead')).toMatchObject([
      { id: colleagueView.id, name: 'Theirs', version: 1 },
    ]);

    expect(await store.delete(mine, view.id)).toEqual({ kind: 'deleted' });
    expect(await store.delete(mine, view.id)).toEqual({ kind: 'not_found' });
    expect(await store.list(mine, 'lead')).toEqual([]);
  });

  it('a view naming a property that is now hidden comes back cleaned, and the stored row is unchanged', async () => {
    const saved: SavedViewState = { ...cityView, leadType: 'internet' };
    const view = await created(store, mine, 'Calgary', saved);
    const cleaned: SavedViewState = {
      ...DEFAULT_LEAD_VIEW_STATE,
      leadType: 'internet',
      columns: ['planId'],
    };

    const server: Server = createApp({
      staff: {
        sessionVerifier: {
          verify: async () => ({ actorId: ACTOR, verifiedEmail: 'a@example.test' }),
        },
        store: leadsRoleStaffStore,
        credentialStore: unusedCredentialStore,
        leadStore: unusedLeadStore,
        savedViewStore: store,
        loadPropertyCatalog: async () => cityHidden,
      },
    }).listen(0);
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('expected TCP server');
      const url = `http://127.0.0.1:${address.port}/api/v1/staff/workspaces/${WORKSPACE}/views`;
      const headers = { authorization: 'Bearer token', 'content-type': 'application/json' };

      const listed = await fetch(url, { headers });
      expect(listed.status).toBe(200);
      expect(listSavedViewsResponseSchema.parse(await listed.json()).views).toEqual([
        { ...view, state: cleaned },
      ]);

      // A rename answers with the cleaned state too, and leaves the stored state alone.
      const renamed = await fetch(`${url}/${view.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ expectedVersion: 1, name: 'Calgary leads' }),
      });
      expect(renamed.status).toBe(200);
      expect(savedViewResponseSchema.parse(await renamed.json()).view).toMatchObject({
        name: 'Calgary leads',
        version: 2,
        state: cleaned,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const [row] = await admin<{ state: unknown }[]>`
      select state from app.saved_views where id = ${view.id}
    `;
    expect(row?.state).toEqual(saved);
  });
});
