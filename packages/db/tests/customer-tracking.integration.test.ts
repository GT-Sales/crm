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

const WORKSPACE_1 = '00000000-0000-4000-8000-000000006301';
const WORKSPACE_2 = '00000000-0000-4000-8000-000000006302';
const ACTOR_A = '00000000-0000-4000-8000-000000006311';

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const INSUFFICIENT_PRIVILEGE = '42501';

const NEW_TABLES = ['change_requests', 'tracking_challenges'] as const;

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

/** The hand-written 0018 migration, statement by statement, as the migrator runs it. */
function runtimeMigrationStatements(): string[] {
  const text = readFileSync(`${migrationsFolder}/0018_customer_tracking_runtime.sql`, 'utf8');
  return text
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** Thrown to roll a transaction back once its assertions have passed. */
class RolledBack extends Error {}

databaseTest('customer tracking tables, held files and migration 0018', () => {
  let admin: ReturnType<typeof postgres>;
  let runtimeSql: ReturnType<typeof postgres>;
  let lead1: string;
  let lead2: string;

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

  async function insertLead(workspaceId: string): Promise<string> {
    const [lead] = await admin<{ id: string }[]>`
      insert into app.leads (workspace_id, lead_type, status, stage, consent_version)
      values (${workspaceId}, 'sim_order', 'submitted', 'pending', 'ci')
      returning id
    `;
    if (!lead) throw new Error('the lead was not inserted');
    return lead.id;
  }

  const insertChallenge = (
    sql: postgres.Sql | postgres.TransactionSql,
    workspaceId: string,
    values: { emailHash?: string; attempts?: number; status?: string; consumedAt?: Date | null },
  ) => sql`
    insert into app.tracking_challenges
      (workspace_id, email_hash, code_hash, attempts, status, expires_at, consumed_at)
    values (${workspaceId}, ${values.emailHash ?? HASH_A}, ${HASH_B}, ${values.attempts ?? 0},
      ${values.status ?? 'pending'}, now() + interval '10 minutes', ${values.consumedAt ?? null})
  `;

  const insertRequest = (
    sql: postgres.Sql | postgres.TransactionSql,
    workspaceId: string,
    leadId: string,
    requestNo: number,
    values: { status?: string; resolvedAt?: Date | null; resolvedBy?: string | null } = {},
  ) => sql`
    insert into app.change_requests
      (workspace_id, lead_id, request_no, status, created_by, resolved_by, resolved_at)
    values (${workspaceId}, ${leadId}, ${requestNo}, ${values.status ?? 'pending'}, ${ACTOR_A},
      ${values.resolvedBy ?? null}, ${values.resolvedAt ?? null})
  `;

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');

    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await setTestRuntimePassword(admin);
    await cleanUp();

    await admin`
      insert into app.workspaces (id, slug, name)
      values
        (${WORKSPACE_1}, 'ci-customer-tracking-1', 'CI Customer Tracking 1'),
        (${WORKSPACE_2}, 'ci-customer-tracking-2', 'CI Customer Tracking 2')
    `;
    await admin`
      insert into app.memberships (workspace_id, user_id, membership_type, status)
      values
        (${WORKSPACE_1}, ${ACTOR_A}, 'staff', 'active'),
        (${WORKSPACE_2}, ${ACTOR_A}, 'staff', 'active')
    `;
    lead1 = await insertLead(WORKSPACE_1);
    lead2 = await insertLead(WORKSPACE_2);

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

  it('both tables have RLS enabled and forced, their two policies each, and 38 read policies in all', async () => {
    const tables = await admin<{ name: string; rowSecurity: boolean; forced: boolean }[]>`
      select c.relname::text as name,
             c.relrowsecurity as "rowSecurity",
             c.relforcerowsecurity as forced
      from pg_class c
      where c.relnamespace = 'app'::regnamespace and c.relname in ${admin(NEW_TABLES)}
      order by c.relname
    `;
    expect(tables).toEqual(NEW_TABLES.map((name) => ({ name, rowSecurity: true, forced: true })));

    const policies = await admin<{ table: string; policy: string }[]>`
      select tablename::text as table, policyname::text as policy from pg_policies
      where schemaname = 'app' and tablename in ${admin(NEW_TABLES)}
      order by tablename, policyname
    `;
    expect(policies).toEqual(
      NEW_TABLES.flatMap((table) => [
        { table, policy: `${table}_backup_reader_read` },
        { table, policy: `${table}_tenant_policy` },
      ]),
    );

    const [backupPolicies] = await admin<{ count: number }[]>`
      select count(*)::int as count from pg_policies
      where schemaname = 'app' and policyname like '%\\_backup\\_reader\\_read'
        and 'backup_reader' = any (roles)
    `;
    expect(backupPolicies?.count).toBe(38);
  });

  it('app_runtime may select, insert and update both but never delete; backup_reader reads both', async () => {
    for (const table of NEW_TABLES) {
      const [privileges] = await admin<
        { select: boolean; insert: boolean; update: boolean; delete: boolean; backup: boolean }[]
      >`
        select
          has_table_privilege('app_runtime', ${`app.${table}`}, 'SELECT') as select,
          has_table_privilege('app_runtime', ${`app.${table}`}, 'INSERT') as insert,
          has_table_privilege('app_runtime', ${`app.${table}`}, 'UPDATE') as update,
          has_table_privilege('app_runtime', ${`app.${table}`}, 'DELETE') as delete,
          has_table_privilege('backup_reader', ${`app.${table}`}, 'SELECT') as backup
      `;
      expect(privileges, table).toEqual({
        select: true,
        insert: true,
        update: true,
        delete: false,
        backup: true,
      });
    }
    await expect(
      asRuntime(WORKSPACE_1, ACTOR_A, (tx) => tx`delete from app.tracking_challenges`),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(
      asRuntime(WORKSPACE_1, ACTOR_A, (tx) => tx`delete from app.change_requests`),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
  });

  it('a site sees and writes only its own challenges and change requests', async () => {
    await admin`delete from app.tracking_challenges where workspace_id in (${WORKSPACE_1}, ${WORKSPACE_2})`;
    await admin`delete from app.change_requests where workspace_id in (${WORKSPACE_1}, ${WORKSPACE_2})`;
    await asRuntime(WORKSPACE_1, ACTOR_A, async (tx) => {
      await insertChallenge(tx, WORKSPACE_1, {});
      await insertRequest(tx, WORKSPACE_1, lead1, 1);
    });

    const seen = await asRuntime(WORKSPACE_2, ACTOR_A, async (tx) => {
      const challenges = await tx`select id from app.tracking_challenges`;
      const requests = await tx`select id from app.change_requests`;
      const moved = await tx`update app.change_requests set version = version + 1`;
      return { challenges: challenges.length, requests: requests.length, moved: moved.count };
    });
    expect(seen).toEqual({ challenges: 0, requests: 0, moved: 0 });

    await expect(
      asRuntime(WORKSPACE_2, ACTOR_A, (tx) => insertChallenge(tx, WORKSPACE_1, {})),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });

    const own = await asRuntime(WORKSPACE_1, ACTOR_A, async (tx) => {
      const challenges = await tx`select id from app.tracking_challenges`;
      const requests = await tx`select id from app.change_requests`;
      return { challenges: challenges.length, requests: requests.length };
    });
    expect(own).toEqual({ challenges: 1, requests: 1 });
  });

  it('a challenge stores 64-hex hashes, counts attempts from 0 and is consumed with a time', async () => {
    await insertChallenge(admin, WORKSPACE_1, {});
    const [stored] = await admin<{ attempts: number; status: string; consumedAt: Date | null }[]>`
      select attempts, status, consumed_at as "consumedAt" from app.tracking_challenges
      where workspace_id = ${WORKSPACE_1} order by created_at desc limit 1
    `;
    expect(stored).toEqual({ attempts: 0, status: 'pending', consumedAt: null });
    await insertChallenge(admin, WORKSPACE_1, { status: 'consumed', consumedAt: new Date() });

    for (const refused of [
      insertChallenge(admin, WORKSPACE_1, { emailHash: 'abc' }),
      insertChallenge(admin, WORKSPACE_1, { emailHash: 'A'.repeat(64) }),
      insertChallenge(admin, WORKSPACE_1, { attempts: -1 }),
      insertChallenge(admin, WORKSPACE_1, { status: 'consumed' }),
      insertChallenge(admin, WORKSPACE_1, { consumedAt: new Date() }),
      insertChallenge(admin, WORKSPACE_1, { status: 'expired' }),
    ]) {
      await expect(refused).rejects.toMatchObject({ code: CHECK_VIOLATION });
    }
    await expect(
      admin`
        insert into app.tracking_challenges (workspace_id, email_hash, code_hash, expires_at)
        values (${WORKSPACE_1}, ${HASH_A}, 'not-a-hash', now())
      `,
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('one pending change request per lead; a pending one beside an approved one is allowed', async () => {
    await admin`delete from app.change_requests where workspace_id in (${WORKSPACE_1}, ${WORKSPACE_2})`;
    await insertRequest(admin, WORKSPACE_1, lead1, 10);
    await expect(insertRequest(admin, WORKSPACE_1, lead1, 11)).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint_name: 'change_requests_one_pending',
    });
    await admin`
      update app.change_requests
      set status = 'approved', resolved_by = ${ACTOR_A}, resolved_at = now()
      where workspace_id = ${WORKSPACE_1} and request_no = 10
    `;
    await insertRequest(admin, WORKSPACE_1, lead1, 11);

    const [defaults] = await admin<
      { requested: unknown; stagedFileIds: string[]; version: number }[]
    >`
      select requested, staged_file_ids as "stagedFileIds", version from app.change_requests
      where workspace_id = ${WORKSPACE_1} and request_no = 11
    `;
    expect(defaults).toEqual({ requested: {}, stagedFileIds: [], version: 1 });
  });

  it('a request number is unique per site, and the same number may exist on two sites', async () => {
    await admin`delete from app.change_requests where workspace_id in (${WORKSPACE_1}, ${WORKSPACE_2})`;
    await insertRequest(admin, WORKSPACE_1, lead1, 20, {
      status: 'rejected',
      resolvedBy: ACTOR_A,
      resolvedAt: new Date(),
    });
    await expect(insertRequest(admin, WORKSPACE_1, lead1, 20)).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint_name: 'change_requests_workspace_request_no_unique',
    });
    await insertRequest(admin, WORKSPACE_2, lead2, 20);
  });

  it('refuses a resolved request without both its time and resolver, a pending one with either, and bad values', async () => {
    await admin`delete from app.change_requests where workspace_id in (${WORKSPACE_1}, ${WORKSPACE_2})`;
    for (const refused of [
      insertRequest(admin, WORKSPACE_1, lead1, 30, { status: 'approved' }),
      insertRequest(admin, WORKSPACE_1, lead1, 31, { status: 'rejected' }),
      insertRequest(admin, WORKSPACE_1, lead1, 35, { status: 'approved', resolvedBy: ACTOR_A }),
      insertRequest(admin, WORKSPACE_1, lead1, 36, {
        status: 'approved',
        resolvedAt: new Date(),
      }),
      insertRequest(admin, WORKSPACE_1, lead1, 37, { resolvedBy: ACTOR_A }),
      insertRequest(admin, WORKSPACE_1, lead1, 32, { resolvedAt: new Date() }),
      insertRequest(admin, WORKSPACE_1, lead1, 33, { status: 'cancelled' }),
      insertRequest(admin, WORKSPACE_1, lead1, 0),
    ]) {
      await expect(refused).rejects.toMatchObject({ code: CHECK_VIOLATION });
    }
    await expect(
      admin`
        insert into app.change_requests (workspace_id, lead_id, request_no, created_by, version)
        values (${WORKSPACE_1}, ${lead1}, 34, ${ACTOR_A}, 0)
      `,
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it("refuses a change request for another site's lead, and goes with its lead", async () => {
    await expect(insertRequest(admin, WORKSPACE_1, lead2, 40)).rejects.toMatchObject({
      code: FOREIGN_KEY_VIOLATION,
    });
    await inRolledBackTransaction(async (tx) => {
      await tx`delete from app.change_requests where workspace_id = ${WORKSPACE_2}`;
      await insertRequest(tx, WORKSPACE_2, lead2, 41);
      await tx`delete from app.leads where id = ${lead2}`;
      const [left] = await tx<{ count: number }[]>`
        select count(*)::int as count from app.change_requests where workspace_id = ${WORKSPACE_2}
      `;
      expect(left?.count).toBe(0);
    });
  });

  it('takes the two change decision templates in both template tables, never an unknown key', async () => {
    await admin`delete from app.email_templates where workspace_id = ${WORKSPACE_1}`;
    await admin`delete from app.email_template_versions where workspace_id = ${WORKSPACE_1}`;
    for (const key of ['change_approved', 'change_rejected']) {
      await admin`
        insert into app.email_templates (workspace_id, key, subject, body, version, updated_by)
        values (${WORKSPACE_1}, ${key}, 'Subject', 'Body', 1, ${ACTOR_A})
      `;
      await admin`
        insert into app.email_template_versions (workspace_id, key, version, subject, body, created_by)
        values (${WORKSPACE_1}, ${key}, 1, 'Subject', 'Body', ${ACTOR_A})
      `;
    }
    await expect(
      admin`
        insert into app.email_templates (workspace_id, key, subject, body, version, updated_by)
        values (${WORKSPACE_1}, 'change_cancelled', 'Subject', 'Body', 1, ${ACTOR_A})
      `,
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(
      admin`
        insert into app.email_template_versions (workspace_id, key, version, subject, body, created_by)
        values (${WORKSPACE_1}, 'change_cancelled', 1, 'Subject', 'Body', ${ACTOR_A})
      `,
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('takes the change_request_no counter', async () => {
    await admin`delete from app.site_counters where workspace_id = ${WORKSPACE_1}`;
    await admin`
      insert into app.site_counters (workspace_id, counter, last_value)
      values (${WORKSPACE_1}, 'change_request_no', 76)
    `;
    const counters = await admin<{ counter: string }[]>`
      select counter from app.site_counters where workspace_id = ${WORKSPACE_1}
    `;
    expect(counters).toEqual([{ counter: 'change_request_no' }]);
  });

  it("indexes a site's leads by normalized email for the tracking lookups", async () => {
    const [index] = await admin<{ definition: string }[]>`
      select indexdef as definition from pg_indexes
      where schemaname = 'app' and tablename = 'leads' and indexname = 'leads_workspace_email_idx'
    `;
    expect(index?.definition).toContain('workspace_id');
    expect(index?.definition).toContain('lower(btrim(email))');
  });

  it('a file is not held for a change request unless marked', async () => {
    const [file] = await admin<{ held: boolean }[]>`
      insert into app.files (workspace_id, record_type, record_id, document_type, bucket,
        staging_key, declared_content_type, declared_size_bytes, uploaded_by, expires_at)
      values (${WORKSPACE_1}, 'lead', ${lead1}, 'passport', 'ci', ${`ci/${crypto.randomUUID()}`},
        'application/pdf', 100, ${ACTOR_A}, now() + interval '1 hour')
      returning held_for_change_request as held
    `;
    expect(file).toEqual({ held: false });
    const [column] = await admin<{ nullable: string; default: string }[]>`
      select is_nullable as nullable, column_default as default
      from information_schema.columns
      where table_schema = 'app' and table_name = 'files' and column_name = 'held_for_change_request'
    `;
    expect(column).toEqual({ nullable: 'NO', default: 'false' });
  });

  it("0018's statements re-run cleanly, and the prune function then names tracking_challenges", async () => {
    const statements = runtimeMigrationStatements();
    expect(statements.length).toBeGreaterThan(0);
    await inRolledBackTransaction(async (tx) => {
      for (const statement of statements) await tx.unsafe(statement);
      for (const statement of statements) await tx.unsafe(statement);
      const forced = await tx<{ forced: boolean }[]>`
        select relforcerowsecurity as forced from pg_class
        where relnamespace = 'app'::regnamespace and relname in ${tx(NEW_TABLES)}
      `;
      expect(forced).toEqual([{ forced: true }, { forced: true }]);
      const [function_] = await tx<{ source: string }[]>`
        select prosrc as source from pg_proc
        where pronamespace = 'app'::regnamespace and proname = 'prune_operational_rows'
      `;
      expect(function_?.source).toContain('app.tracking_challenges');
      expect(function_?.source).toContain('app.automation_runs');
      expect(function_?.source).not.toContain('app.change_requests');
    });
  });
});
