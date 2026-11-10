import { randomUUID } from 'node:crypto';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';

import { DatabaseStaffStore, INVITATION_TTL_DAYS } from '../src/staff/store.js';
import { disposableTestDatabaseUrl } from './support/flows.js';

/**
 * Audit L-16: a staff invitation can be claimed for 14 days (migration 0030);
 * inviting an address again retires an expired pending invitation so the new
 * one is not blocked by the one-pending-per-address rule, and leaves a live one
 * alone.
 */

const migrationUrl = disposableTestDatabaseUrl();
const databaseTest = migrationUrl ? describe : describe.skip;

const SITE = '18000000-0000-4000-8000-000000008601';
const OWNER = '28000000-0000-4000-8000-000000008601';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';

databaseTest('staff invitation expiry', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let store: DatabaseStaffStore;

  const invite = (email: string) =>
    store.inviteStaff({
      actorId: OWNER,
      workspaceId: SITE,
      normalizedEmail: email,
      roleNames: ['viewer'],
      requestId: randomUUID(),
    });
  const rowsFor = (email: string) =>
    admin<{ id: string; status: string }[]>`
      select id, status from app.memberships
      where workspace_id = ${SITE} and invited_email = ${email} order by created_at, id
    `;

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    await admin`delete from app.workspaces where id = ${SITE}`;
    await admin`insert into app.workspaces (id, slug, name) values (${SITE}, 'invites-8601', 'Invites')`;
    await admin`insert into app.roles (workspace_id, name) values (${SITE}, 'viewer')`;
    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      ssl: false,
      maxConnections: 2,
    });
    store = new DatabaseStaffStore(database);
  });

  afterAll(async () => {
    await database?.close();
    await admin?.end();
  });

  it('the invitation window is the 14 days the function enforces', () => {
    expect(INVITATION_TTL_DAYS).toBe(14);
  });

  it('retires an expired pending invitation when the address is invited again', async () => {
    const email = 'expired@example.test';
    const old = await invite(email);
    await admin`
      update app.memberships set created_at = now() - interval '15 days' where id = ${old}
    `;

    const fresh = await invite(email);

    expect(fresh).not.toBe(old);
    expect(await rowsFor(email)).toEqual(
      expect.arrayContaining([
        { id: old, status: 'revoked' },
        { id: fresh, status: 'pending' },
      ]),
    );
  });

  it('leaves a live pending invitation alone and reports the conflict as before', async () => {
    const email = 'live@example.test';
    const first = await invite(email);
    await admin`
      update app.memberships set created_at = now() - interval '13 days' where id = ${first}
    `;

    await expect(invite(email)).rejects.toMatchObject({ cause: { code: '23505' } });
    expect(await rowsFor(email)).toEqual([{ id: first, status: 'pending' }]);
  });
});
