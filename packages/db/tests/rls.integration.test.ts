import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createDatabaseClient, type DatabaseClient } from '../src/index.js';
import { applyMigrations } from '../src/migrations.js';
import { seedDatabase, STAFF_SEED_IDS } from '../src/seed.js';

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

const WORKSPACE_A = '10000000-0000-4000-8000-000000000001';
const WORKSPACE_B = '10000000-0000-4000-8000-000000000002';
const ACTOR_A = '20000000-0000-4000-8000-000000000001';
const ACTOR_B = '20000000-0000-4000-8000-000000000002';
const MEMBERSHIP_A = '30000000-0000-4000-8000-000000000001';
const MEMBERSHIP_B = '30000000-0000-4000-8000-000000000002';
const ROLE_B = '40000000-0000-4000-8000-000000000002';
const CROSS_WORKSPACE_JOIN = '50000000-0000-4000-8000-000000000001';
const AUDIT_EVENT_A = '60000000-0000-4000-8000-000000000001';
const AUDIT_REQUEST_A = '70000000-0000-4000-8000-000000000001';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';

databaseTest('tenant RLS and transaction-pool context', () => {
  let admin: ReturnType<typeof postgres>;
  let runtimeSql: ReturnType<typeof postgres>;
  let tenantDatabase: DatabaseClient;

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');

    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    await seedDatabase({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false });

    // Synthetic CI-only password. Production role passwords are provisioned
    // outside migrations and are never committed.
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });

    await admin`
      insert into app.workspaces (id, slug, name)
      values
        (${WORKSPACE_A}, 'ci-workspace-a', 'CI Workspace A'),
        (${WORKSPACE_B}, 'ci-workspace-b', 'CI Workspace B')
      on conflict (id) do nothing
    `;
    await admin`
      insert into app.memberships (id, workspace_id, user_id, membership_type, status)
      values
        (${MEMBERSHIP_A}, ${WORKSPACE_A}, ${ACTOR_A}, 'staff', 'active'),
        (${MEMBERSHIP_B}, ${WORKSPACE_B}, ${ACTOR_B}, 'staff', 'active')
      on conflict (id) do nothing
    `;
    await admin`
      insert into app.roles (id, workspace_id, name)
      values (${ROLE_B}, ${WORKSPACE_B}, 'viewer')
      on conflict (id) do nothing
    `;
    await admin`
      insert into app.audit_events (
        id,
        workspace_id,
        actor_id,
        actor_label,
        action,
        entity,
        entity_id,
        request_id
      )
      values (
        ${AUDIT_EVENT_A},
        ${WORKSPACE_A},
        ${ACTOR_A},
        'CI actor',
        'membership.created',
        'membership',
        ${MEMBERSHIP_A},
        ${AUDIT_REQUEST_A}
      )
      on conflict (id) do nothing
    `;

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    runtimeSql = postgres(runtimeUrl.toString(), { max: 1, prepare: false, ssl: false });
    tenantDatabase = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      maxConnections: 1,
      ssl: false,
    });
  });

  afterAll(async () => {
    await tenantDatabase.close();
    await runtimeSql.end();
    await admin.end();
  });

  test('missing context denies tenant reads and writes', async () => {
    const rows = await runtimeSql`select id from app.memberships`;
    expect(rows).toHaveLength(0);

    await expect(
      runtimeSql`
        insert into app.memberships (workspace_id, user_id, membership_type, status)
        values (${WORKSPACE_A}, ${ACTOR_B}, 'staff', 'active')
      `,
    ).rejects.toMatchObject({ code: '42501' });
  });

  test('runtime role cannot enumerate the global workspace registry', async () => {
    await expect(runtimeSql`select id from app.workspaces`).rejects.toMatchObject({
      code: '42501',
    });
  });

  test('wrong workspace context sees zero rows', async () => {
    const rows = await tenantDatabase.withTenantTx(
      { workspaceId: WORKSPACE_B, actorId: ACTOR_B },
      (tx) =>
        tx.execute(sql`
          select id from app.memberships
          where id = ${MEMBERSHIP_A}
        `),
    );

    expect(rows).toHaveLength(0);
  });

  test('composite foreign key rejects a cross-workspace child', async () => {
    await expect(
      admin`
        insert into app.membership_roles (id, workspace_id, membership_id, role_id)
        values (${CROSS_WORKSPACE_JOIN}, ${WORKSPACE_A}, ${MEMBERSHIP_A}, ${ROLE_B})
      `,
    ).rejects.toMatchObject({ code: '23503' });
  });

  test('runtime role is non-owner and cannot bypass RLS', async () => {
    const [role] = await admin<
      { rolbypassrls: boolean; rolsuper: boolean; ownsTenantTable: boolean }[]
    >`
      select
        rolbypassrls,
        rolsuper,
        pg_has_role('app_runtime', c.relowner, 'member') as "ownsTenantTable"
      from pg_roles
      cross join pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where rolname = 'app_runtime'
        and n.nspname = 'app'
        and c.relname = 'memberships'
    `;

    expect(role).toEqual({
      rolbypassrls: false,
      rolsuper: false,
      ownsTenantTable: false,
    });

    await expect(
      runtimeSql.begin(async (tx) => {
        await tx`set local row_security = off`;
        await tx`select id from app.memberships`;
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });

  test('runtime role cannot update audit history', async () => {
    await expect(
      tenantDatabase.withTenantTx({ workspaceId: WORKSPACE_A, actorId: ACTOR_A }, (tx) =>
        tx.execute(sql`
            update app.audit_events
            set actor_label = 'tampered'
            where id = ${AUDIT_EVENT_A}
          `),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  test('runtime role cannot delete audit history', async () => {
    await expect(
      tenantDatabase.withTenantTx({ workspaceId: WORKSPACE_A, actorId: ACTOR_A }, (tx) =>
        tx.execute(sql`delete from app.audit_events where id = ${AUDIT_EVENT_A}`),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  test('audit values permit redaction only, with tenant isolation', async () => {
    const id = crypto.randomUUID();
    await tenantDatabase.withTenantTx({ workspaceId: WORKSPACE_A, actorId: ACTOR_A }, (tx) =>
      tx.execute(sql`
        insert into app.audit_events
          (id, workspace_id, actor_id, actor_label, action, entity, entity_id,
           request_id, "before", "after")
        values (${id}, ${WORKSPACE_A}, ${ACTOR_A}, 'CI actor', 'lead.updated',
          'lead', ${MEMBERSHIP_A}, ${crypto.randomUUID()}, '{"value":"old"}', '{"value":"new"}')
      `),
    );
    for (const replacement of ['{"value":"forged"}', 'null', '{}']) {
      await expect(
        tenantDatabase.withTenantTx({ workspaceId: WORKSPACE_A, actorId: ACTOR_A }, (tx) =>
          tx.execute(
            sql`update app.audit_events set "before" = ${replacement}::jsonb where id = ${id}`,
          ),
        ),
      ).rejects.toMatchObject({ cause: { code: '23514' } });
    }
    const crossTenant = await tenantDatabase.withTenantTx(
      { workspaceId: WORKSPACE_B, actorId: ACTOR_B },
      (tx) =>
        tx.execute(sql`update app.audit_events set "before" = null where id = ${id} returning id`),
    );
    expect(crossTenant).toHaveLength(0);
    const withoutContext = await runtimeSql`
      update app.audit_events set "after" = null where id = ${id} returning id
    `;
    expect(withoutContext).toHaveLength(0);
    const [partlyRedacted] = await tenantDatabase.withTenantTx(
      { workspaceId: WORKSPACE_A, actorId: ACTOR_A },
      (tx) =>
        tx.execute(
          sql`update app.audit_events set "before" = null where id = ${id} returning "before", "after"`,
        ),
    );
    expect(partlyRedacted).toEqual({ before: null, after: { value: 'new' } });
    await expect(
      tenantDatabase.withTenantTx({ workspaceId: WORKSPACE_A, actorId: ACTOR_A }, (tx) =>
        tx.execute(
          sql`update app.audit_events set "before" = '{"value":"restored"}' where id = ${id}`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
    const [redacted] = await tenantDatabase.withTenantTx(
      { workspaceId: WORKSPACE_A, actorId: ACTOR_A },
      (tx) =>
        tx.execute(
          sql`update app.audit_events set "before" = null, "after" = null where id = ${id} returning "before", "after", action`,
        ),
    );
    expect(redacted).toEqual({ before: null, after: null, action: 'lead.updated' });
    await expect(
      tenantDatabase.withTenantTx({ workspaceId: WORKSPACE_A, actorId: ACTOR_A }, (tx) =>
        tx.execute(
          sql`update app.audit_events set "after" = '{"value":"forged"}' where id = ${id}`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  test('sequential units on one pooled connection do not leak SET LOCAL context', async () => {
    const [first] = await tenantDatabase.withTenantTx(
      { workspaceId: WORKSPACE_A, actorId: ACTOR_A },
      (tx) =>
        tx.execute<{ actorId: string; pid: number; workspaceId: string }>(sql`
          select
            current_setting('app.actor_id', true) as "actorId",
            pg_backend_pid() as pid,
            current_setting('app.workspace_id', true) as "workspaceId"
        `),
    );

    const between = await tenantDatabase.db.execute(sql`select id from app.memberships`);

    const [second] = await tenantDatabase.withTenantTx(
      { workspaceId: WORKSPACE_B, actorId: ACTOR_B },
      (tx) =>
        tx.execute<{ actorId: string; pid: number; workspaceId: string }>(sql`
          select
            current_setting('app.actor_id', true) as "actorId",
            pg_backend_pid() as pid,
            current_setting('app.workspace_id', true) as "workspaceId"
        `),
    );

    expect(first).toEqual({ actorId: ACTOR_A, pid: first?.pid, workspaceId: WORKSPACE_A });
    expect(between).toHaveLength(0);
    expect(second).toEqual({ actorId: ACTOR_B, pid: first?.pid, workspaceId: WORKSPACE_B });
  });

  test('synthetic seed creates the two client sites with the owner in both', async () => {
    const workspaces = await admin<{ id: string; name: string; slug: string; domain: string }[]>`
      select id, slug, name, domain
      from app.workspaces
      where id in (${STAFF_SEED_IDS.getCanadaSimWorkspace}, ${STAFF_SEED_IDS.canadaWideWorkspace})
      order by slug
    `;
    expect(workspaces).toEqual([
      {
        id: STAFF_SEED_IDS.canadaWideWorkspace,
        slug: 'canadawide',
        name: 'CanadaWide',
        domain: 'canadawideinternet.com',
      },
      {
        id: STAFF_SEED_IDS.getCanadaSimWorkspace,
        slug: 'getcanadasim',
        name: 'Get Canada Sim',
        domain: 'getcanadasim.com',
      },
    ]);

    const ownerMemberships = await admin`
      select workspace_id
      from app.memberships
      where user_id = ${STAFF_SEED_IDS.ownerActor} and status = 'active'
    `;
    expect(ownerMemberships).toHaveLength(2);

    const simStaffWorkspaces = await tenantDatabase.withActorTx(
      STAFF_SEED_IDS.getCanadaSimActor,
      (tx) => tx.execute(sql`select workspace_slug from app.list_staff_workspaces()`),
    );
    const wideStaffWorkspaces = await tenantDatabase.withActorTx(
      STAFF_SEED_IDS.canadaWideActor,
      (tx) => tx.execute(sql`select workspace_slug from app.list_staff_workspaces()`),
    );
    expect(simStaffWorkspaces).toEqual([{ workspace_slug: 'getcanadasim' }]);
    expect(wideStaffWorkspaces).toEqual([{ workspace_slug: 'canadawide' }]);
  });

  test('restricted bootstrap lists only the server-verified actor active memberships', async () => {
    const ownerWorkspaces = await tenantDatabase.withActorTx(STAFF_SEED_IDS.ownerActor, (tx) =>
      tx.execute<{ workspaceSlug: string }>(sql`
          select workspace_slug as "workspaceSlug"
          from app.list_staff_workspaces()
          order by workspace_slug
        `),
    );
    expect(ownerWorkspaces).toEqual([
      { workspaceSlug: 'canadawide' },
      { workspaceSlug: 'getcanadasim' },
    ]);

    const noContext = await runtimeSql`select workspace_slug from app.list_staff_workspaces()`;
    expect(noContext).toHaveLength(0);
  });

  test('the staff access snapshot returns only the named membership, with roles and overrides', async () => {
    const owner = await tenantDatabase.staffAccessSnapshot({
      workspaceId: STAFF_SEED_IDS.getCanadaSimWorkspace,
      actorId: STAFF_SEED_IDS.ownerActor,
    });
    expect(owner).toEqual({
      membershipId: STAFF_SEED_IDS.getCanadaSimOwnerMembership,
      status: 'active',
      roleNames: ['owner'],
      permissionRows: [],
    });

    // A per-member override travels with the snapshot. Other suites share the
    // seeded members, so the override is removed again.
    const [permission] = await admin<{ id: string }[]>`
      select id from app.permissions
      where workspace_id = ${STAFF_SEED_IDS.canadaWideWorkspace} and name = 'document_download'
    `;
    if (!permission) throw new Error('the seed has no document_download permission');
    const override = {
      workspace: STAFF_SEED_IDS.canadaWideWorkspace,
      membership: STAFF_SEED_IDS.canadaWideStaffMembership,
      permission: permission.id,
    };
    await admin`
      insert into app.membership_permissions (workspace_id, membership_id, permission_id, effect)
      values (${override.workspace}, ${override.membership}, ${override.permission}, 'deny')
      on conflict do nothing
    `;
    try {
      const staff = await tenantDatabase.staffAccessSnapshot({
        workspaceId: STAFF_SEED_IDS.canadaWideWorkspace,
        actorId: STAFF_SEED_IDS.canadaWideActor,
      });
      expect(staff?.membershipId).toBe(STAFF_SEED_IDS.canadaWideStaffMembership);
      expect(staff?.permissionRows).toEqual([{ name: 'document_download', effect: 'deny' }]);
    } finally {
      await admin`
        delete from app.membership_permissions
        where workspace_id = ${override.workspace}
          and membership_id = ${override.membership}
          and permission_id = ${override.permission}
      `;
    }

    // Another site's member, or an actor with no membership, gets nothing.
    await expect(
      tenantDatabase.staffAccessSnapshot({
        workspaceId: STAFF_SEED_IDS.getCanadaSimWorkspace,
        actorId: STAFF_SEED_IDS.canadaWideActor,
      }),
    ).resolves.toBeUndefined();
    await expect(
      tenantDatabase.staffAccessSnapshot({
        workspaceId: STAFF_SEED_IDS.getCanadaSimWorkspace,
        actorId: '20000000-0000-4000-8000-0000000000ff',
      }),
    ).resolves.toBeUndefined();

    const [grants] = await admin<{ publicExecute: boolean; runtimeExecute: boolean }[]>`
      select
        has_function_privilege('public', 'app.staff_access_snapshot(uuid, uuid)', 'execute') as "publicExecute",
        has_function_privilege('app_runtime', 'app.staff_access_snapshot(uuid, uuid)', 'execute') as "runtimeExecute"
    `;
    expect(grants).toEqual({ publicExecute: false, runtimeExecute: true });
  });

  test('first verified login accepts only matching pending invitations and audits the change', async () => {
    const invitedActor = '20000000-0000-4000-8000-000000000199';
    const invitationId = '30000000-0000-4000-8000-000000000199';
    const requestId = '70000000-0000-4000-8000-000000000199';
    // A persistent local database still holds the accepted row from the last run.
    await admin`delete from app.audit_events where entity_id = ${invitationId}`;
    await admin`delete from app.memberships where id = ${invitationId}`;
    await admin`
      insert into app.memberships (
        id, workspace_id, invited_email, membership_type, status
      ) values (
        ${invitationId},
        ${STAFF_SEED_IDS.getCanadaSimWorkspace},
        'invited@example.test',
        'staff',
        'pending'
      )
    `;

    const [accepted] = await tenantDatabase.withActorTx(invitedActor, (tx) =>
      tx.execute<{ count: number }>(sql`
        select app.accept_staff_invitations('invited@example.test', ${requestId}) as count
      `),
    );
    expect(accepted).toEqual({ count: 1 });

    const [membership] = await admin<
      { invited_email: string | null; status: string; user_id: string | null }[]
    >`
      select user_id, invited_email, status
      from app.memberships
      where id = ${invitationId}
    `;
    expect(membership).toEqual({
      user_id: invitedActor,
      invited_email: null,
      status: 'active',
    });

    const [audit] = await admin<{ action: string; request_id: string }[]>`
      select action, request_id
      from app.audit_events
      where entity_id = ${invitationId}
    `;
    expect(audit).toEqual({ action: 'membership.accepted', request_id: requestId });

    const [acceptedAgain] = await tenantDatabase.withActorTx(invitedActor, (tx) =>
      tx.execute<{ count: number }>(sql`
        select app.accept_staff_invitations('invited@example.test', ${requestId}) as count
      `),
    );
    expect(acceptedAgain).toEqual({ count: 0 });
  });
});
