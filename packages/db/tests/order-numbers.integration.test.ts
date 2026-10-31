import { readFileSync } from 'node:fs';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, migrationsFolder } from '../src/migrations.js';
import { setTestRuntimePassword, TEST_RUNTIME_PASSWORD } from '../src/test-helpers.js';

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

const WORKSPACE_1 = '00000000-0000-4000-8000-000000005201';
const WORKSPACE_2 = '00000000-0000-4000-8000-000000005202';
const ACTOR_A = '00000000-0000-4000-8000-000000005211';

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const INSUFFICIENT_PRIVILEGE = '42501';

/** The hand-written 0016 migration, statement by statement, as the migrator runs it. */
function runtimeMigrationStatements(): string[] {
  const text = readFileSync(`${migrationsFolder}/0016_order_numbers_runtime.sql`, 'utf8');
  return text
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** Thrown to roll a transaction back once its assertions have passed. */
class RolledBack extends Error {}

databaseTest('per-site counters (app.site_counters, migrations 0015 and 0016)', () => {
  let admin: ReturnType<typeof postgres>;
  let runtimeSql: ReturnType<typeof postgres>;

  function asRuntime<T>(
    workspaceId: string,
    actorId: string,
    body: (tx: postgres.TransactionSql) => Promise<T>,
  ) {
    return runtimeSql.begin(async (tx) => {
      await tx`
        select set_config('app.workspace_id', ${workspaceId}, true),
               set_config('app.actor_id', ${actorId}, true)
      `;
      return body(tx);
    });
  }

  async function inRolledBackTransaction(
    body: (tx: postgres.TransactionSql) => Promise<void>,
  ): Promise<void> {
    const outcome: unknown = await admin
      .begin(async (tx) => {
        await body(tx);
        throw new RolledBack();
      })
      .catch((error: unknown) => error);
    if (!(outcome instanceof RolledBack)) throw outcome;
  }

  async function cleanUp(): Promise<void> {
    await admin`delete from app.workspaces where id in (${WORKSPACE_1}, ${WORKSPACE_2})`;
  }

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');

    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await setTestRuntimePassword(admin);
    await cleanUp();

    await admin`
      insert into app.workspaces (id, slug, name)
      values
        (${WORKSPACE_1}, 'ci-order-numbers-1', 'CI Order Numbers 1'),
        (${WORKSPACE_2}, 'ci-order-numbers-2', 'CI Order Numbers 2')
    `;
    await admin`
      insert into app.memberships (workspace_id, user_id, membership_type, status)
      values
        (${WORKSPACE_1}, ${ACTOR_A}, 'staff', 'active'),
        (${WORKSPACE_2}, ${ACTOR_A}, 'staff', 'active')
    `;

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    runtimeSql = postgres(runtimeUrl.toString(), { max: 1, prepare: false, ssl: false });
  });

  afterAll(async () => {
    await runtimeSql?.end();
    if (admin) {
      await cleanUp();
      await admin.end();
    }
  });

  it('has RLS enabled and forced, its tenant and backup read policies, and 38 read policies in all', async () => {
    const [table] = await admin<{ rowSecurity: boolean; forced: boolean }[]>`
      select c.relrowsecurity as "rowSecurity", c.relforcerowsecurity as forced
      from pg_class c
      where c.relnamespace = 'app'::regnamespace and c.relname = 'site_counters'
    `;
    expect(table).toEqual({ rowSecurity: true, forced: true });

    const policies = await admin<{ policy: string }[]>`
      select policyname::text as policy from pg_policies
      where schemaname = 'app' and tablename = 'site_counters'
      order by policyname
    `;
    expect(policies.map((row) => row.policy)).toEqual([
      'site_counters_backup_reader_read',
      'site_counters_tenant_policy',
    ]);

    const [backupPolicies] = await admin<{ count: number }[]>`
      select count(*)::int as count from pg_policies
      where schemaname = 'app' and policyname like '%\\_backup\\_reader\\_read'
        and 'backup_reader' = any (roles)
    `;
    expect(backupPolicies?.count).toBe(38);
  });

  it('app_runtime may select, insert and update but never delete; backup_reader reads it', async () => {
    const [privileges] = await admin<
      { select: boolean; insert: boolean; update: boolean; delete: boolean; backup: boolean }[]
    >`
      select
        has_table_privilege('app_runtime', 'app.site_counters', 'SELECT') as select,
        has_table_privilege('app_runtime', 'app.site_counters', 'INSERT') as insert,
        has_table_privilege('app_runtime', 'app.site_counters', 'UPDATE') as update,
        has_table_privilege('app_runtime', 'app.site_counters', 'DELETE') as delete,
        has_table_privilege('backup_reader', 'app.site_counters', 'SELECT') as backup
    `;
    expect(privileges).toEqual({
      select: true,
      insert: true,
      update: true,
      delete: false,
      backup: true,
    });
    await expect(
      asRuntime(WORKSPACE_1, ACTOR_A, (tx) => tx`delete from app.site_counters`),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
  });

  it('a counter is visible and writable only inside its own site', async () => {
    await admin`delete from app.site_counters where workspace_id in (${WORKSPACE_1}, ${WORKSPACE_2})`;
    await asRuntime(WORKSPACE_1, ACTOR_A, async (tx) => {
      await tx`
        insert into app.site_counters (workspace_id, counter, last_value)
        values (${WORKSPACE_1}, 'sim_order_ref', 143)
      `;
      await tx`
        update app.site_counters set last_value = last_value + 1, updated_at = now()
        where workspace_id = ${WORKSPACE_1} and counter = 'sim_order_ref'
      `;
    });

    const seen = await asRuntime(WORKSPACE_2, ACTOR_A, (tx) => {
      return tx<{ workspaceId: string }[]>`
        select workspace_id as "workspaceId" from app.site_counters
      `;
    });
    expect(seen).toEqual([]);

    const moved = await asRuntime(WORKSPACE_2, ACTOR_A, (tx) => {
      return tx`update app.site_counters set last_value = 0 where workspace_id = ${WORKSPACE_1}`;
    });
    expect(moved.count).toBe(0);

    await expect(
      asRuntime(WORKSPACE_2, ACTOR_A, (tx) => {
        return tx`
          insert into app.site_counters (workspace_id, counter, last_value)
          values (${WORKSPACE_1}, 'sim_order_ref', 1)
          on conflict do nothing
        `;
      }),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });

    const [own] = await asRuntime(WORKSPACE_1, ACTOR_A, (tx) => {
      return tx<{ lastValue: number }[]>`
        select last_value as "lastValue" from app.site_counters where counter = 'sim_order_ref'
      `;
    });
    expect(own?.lastValue).toBe(144);
  });

  it('refuses an unknown counter, a negative value and a second row for one site and counter', async () => {
    await admin`delete from app.site_counters where workspace_id = ${WORKSPACE_2}`;
    // 0017 widened the list with change_request_no (customer tracking).
    await admin`
      insert into app.site_counters (workspace_id, counter, last_value)
      values (${WORKSPACE_2}, 'change_request_no', 0)
    `;
    for (const counter of ['order_ref', 'x']) {
      await expect(
        admin`
          insert into app.site_counters (workspace_id, counter, last_value)
          values (${WORKSPACE_2}, ${counter}, 0)
        `,
        counter,
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    }
    await expect(
      admin`
        insert into app.site_counters (workspace_id, counter, last_value)
        values (${WORKSPACE_2}, 'sim_order_ref', -1)
      `,
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });

    await admin`
      insert into app.site_counters (workspace_id, counter, last_value)
      values (${WORKSPACE_2}, 'sim_order_ref', 0)
    `;
    await expect(
      admin`
        insert into app.site_counters (workspace_id, counter, last_value)
        values (${WORKSPACE_2}, 'sim_order_ref', 5)
      `,
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
  });

  it('goes with its site', async () => {
    await inRolledBackTransaction(async (tx) => {
      await tx`delete from app.workspaces where id = ${WORKSPACE_2}`;
      const [left] = await tx<{ count: number }[]>`
        select count(*)::int as count from app.site_counters where workspace_id = ${WORKSPACE_2}
      `;
      expect(left?.count).toBe(0);
    });
  });

  it("0016's statements re-run cleanly", async () => {
    const statements = runtimeMigrationStatements();
    expect(statements.length).toBeGreaterThan(0);
    await inRolledBackTransaction(async (tx) => {
      for (const statement of statements) await tx.unsafe(statement);
      for (const statement of statements) await tx.unsafe(statement);
      const [forced] = await tx<{ forced: boolean }[]>`
        select relforcerowsecurity as forced from pg_class
        where relnamespace = 'app'::regnamespace and relname = 'site_counters'
      `;
      expect(forced?.forced).toBe(true);
    });
  });
});
