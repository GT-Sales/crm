import { randomUUID } from 'node:crypto';

import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

import { DatabaseStaffStore } from '../src/staff/store.js';
import { disposableTestDatabaseUrl } from './support/flows.js';
import { TEST_RUNTIME_PASSWORD } from '@gt-sales/db/test-helpers';

/**
 * Removing a member serialises per site: two owners removing each other at
 * once cannot leave the site without an owner, a removed owner can remove no
 * one, and an ordinary removal still works.
 */

const migrationUrl = disposableTestDatabaseUrl();
const databaseTest = migrationUrl ? describe : describe.skip;

const SITE = '18000000-0000-4000-8000-000000008701';
const OWNER_A = '28000000-0000-4000-8000-00000000870a';
const OWNER_B = '28000000-0000-4000-8000-00000000870b';
const MEMBER = '28000000-0000-4000-8000-00000000870c';

databaseTest('staff removal and owner continuity', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let store: DatabaseStaffStore;
  const membership: Record<string, string> = {};

  const revoke = (actorId: string, target: string) =>
    store.revokeStaff({
      actorId,
      workspaceId: SITE,
      membershipId: membership[target] ?? randomUUID(),
      requestId: randomUUID(),
    });
  const activeOwners = async () => {
    const rows = await admin<{ userId: string }[]>`
      select m.user_id as "userId" from app.memberships m
      join app.membership_roles mr on mr.membership_id = m.id and mr.workspace_id = m.workspace_id
      join app.roles r on r.id = mr.role_id and r.workspace_id = m.workspace_id
      where m.workspace_id = ${SITE} and m.status = 'active' and r.name = 'owner'
    `;
    return rows.map((row) => row.userId);
  };

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      ssl: false,
      maxConnections: 4,
    });
    store = new DatabaseStaffStore(database);
  });

  beforeEach(async () => {
    await admin`delete from app.workspaces where id = ${SITE}`;
    await admin`insert into app.workspaces (id, slug, name) values (${SITE}, 'owners-8701', 'Owners')`;
    const roleRows = await admin<{ id: string; name: string }[]>`
      insert into app.roles (workspace_id, name)
      values (${SITE}, 'owner'), (${SITE}, 'viewer') returning id, name
    `;
    const roleId = (name: string) => roleRows.find((row) => row.name === name)?.id ?? '';
    for (const [user, role] of [
      [OWNER_A, 'owner'],
      [OWNER_B, 'owner'],
      [MEMBER, 'viewer'],
    ] as const) {
      const [row] = await admin<{ id: string }[]>`
        insert into app.memberships (workspace_id, user_id, membership_type, status)
        values (${SITE}, ${user}, 'staff', 'active') returning id
      `;
      membership[user] = row?.id ?? '';
      await admin`
        insert into app.membership_roles (workspace_id, membership_id, role_id)
        values (${SITE}, ${row?.id ?? ''}, ${roleId(role)})
      `;
    }
  });

  afterAll(async () => {
    await admin?.begin(async (tx) => {
      await tx`delete from app.workspaces where id = ${SITE}`;
    });
    await database?.close();
    await admin?.end();
  });

  it('still removes an ordinary member, and an owner removes the other owner', async () => {
    expect(await revoke(OWNER_A, MEMBER)).toBe('revoked');
    expect(await revoke(OWNER_A, MEMBER)).toBe('already_revoked');
    expect(await revoke(OWNER_A, OWNER_B)).toBe('revoked');
    expect(await activeOwners()).toEqual([OWNER_A]);
    expect(await revoke(OWNER_A, OWNER_A)).toBe('self');
  });

  it('lets two owners removing each other at once succeed only once', async () => {
    const results = await Promise.all([revoke(OWNER_A, OWNER_B), revoke(OWNER_B, OWNER_A)]);
    expect([...results].sort()).toEqual(['forbidden', 'revoked']);
    expect(await activeOwners()).toHaveLength(1);
  });

  it('refuses a removal by an owner who was removed since the request was authorised', async () => {
    expect(await revoke(OWNER_A, OWNER_B)).toBe('revoked');
    expect(await revoke(OWNER_B, MEMBER)).toBe('forbidden');
    const [still] = await admin<{ status: string }[]>`
      select status from app.memberships where id = ${membership[MEMBER] ?? ''}
    `;
    expect(still?.status).toBe('active');
  });
});
