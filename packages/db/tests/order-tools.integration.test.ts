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

const WORKSPACE_1 = '14000000-0000-4000-8000-000000000d01';
const WORKSPACE_2 = '14000000-0000-4000-8000-000000000d02';
const ACTOR_A = '15000000-0000-4000-8000-000000000d01';

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const INSUFFICIENT_PRIVILEGE = '42501';

const NEW_TABLES = [
  'automation_runs',
  'automations',
  'email_template_versions',
  'email_templates',
  'idempotency_keys',
  'workspace_email_settings',
] as const;
/**
 * Updated in place by the backend; template versions are append-only. Runs
 * became updatable in 0020 (a flow's run moves from waiting to its end).
 */
const UPDATABLE_TABLES = [
  'automation_runs',
  'automations',
  'email_templates',
  'idempotency_keys',
  'workspace_email_settings',
];

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const FINGERPRINT = `sha256:${'c'.repeat(64)}`;

/** The hand-written 0014 migration, statement by statement, as the migrator runs it. */
function runtimeMigrationStatements(): string[] {
  const text = readFileSync(`${migrationsFolder}/0014_order_tools_runtime.sql`, 'utf8');
  return text
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** Thrown to roll a transaction back once its assertions have passed. */
class RolledBack extends Error {}

databaseTest('order tools tables, email_messages.template_version and migration 0014', () => {
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

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');

    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await setTestRuntimePassword(admin);
    await cleanUp();

    await admin`
      insert into app.workspaces (id, slug, name)
      values
        (${WORKSPACE_1}, 'ci-order-tools-1', 'CI Order Tools 1'),
        (${WORKSPACE_2}, 'ci-order-tools-2', 'CI Order Tools 2')
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

  it('the six tables have RLS enabled and forced and their two policies each', async () => {
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
      select tablename::text as table, policyname::text as policy
      from pg_policies
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
    expect(backupPolicies?.count).toBe(42);
  });

  it('app_runtime may not DELETE any of them, nor UPDATE template versions; backup_reader reads all', async () => {
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
        update: UPDATABLE_TABLES.includes(table),
        delete: false,
        backup: true,
      });
    }

    const [version] = await asRuntime(WORKSPACE_1, ACTOR_A, (tx) => {
      return tx<{ id: string }[]>`
        insert into app.email_template_versions (workspace_id, key, version, subject, body, created_by)
        values (${WORKSPACE_1}, 'dispatched', 1, 'On its way', 'Your SIM is on its way.', ${ACTOR_A})
        returning id
      `;
    });
    if (!version) throw new Error('the version was not inserted');
    await expect(
      asRuntime(WORKSPACE_1, ACTOR_A, (tx) => {
        return tx`update app.email_template_versions set subject = 'Rewritten' where id = ${version.id}`;
      }),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(
      asRuntime(WORKSPACE_1, ACTOR_A, (tx) => {
        return tx`delete from app.email_template_versions where id = ${version.id}`;
      }),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });

    const [run] = await asRuntime(WORKSPACE_1, ACTOR_A, (tx) => {
      return tx<{ id: string }[]>`
        insert into app.automation_runs (workspace_id, automation_key, lead_id, outcome, reason)
        values (${WORKSPACE_1}, 'order_received', ${lead1}, 'skipped', 'no_sender')
        returning id
      `;
    });
    if (!run) throw new Error('the run was not inserted');
    const ended = await asRuntime(WORKSPACE_1, ACTOR_A, (tx) => {
      return tx`update app.automation_runs set finished_at = now() where id = ${run.id}`;
    });
    expect(ended.count).toBe(1);

    for (const table of NEW_TABLES) {
      await expect(
        asRuntime(WORKSPACE_1, ACTOR_A, (tx) => tx.unsafe(`delete from app.${table}`)),
        table,
      ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    }
  });

  it('a row of each table is visible and writable only inside its own site', async () => {
    await asRuntime(WORKSPACE_1, ACTOR_A, async (tx) => {
      await tx`
        insert into app.idempotency_keys (workspace_id, scope, key_hash, request_fingerprint)
        values (${WORKSPACE_1}, 'lead_submission', ${'1'.repeat(64)}, ${FINGERPRINT})
      `;
      await tx`
        insert into app.workspace_email_settings (workspace_id, from_name, from_address, updated_by)
        values (${WORKSPACE_1}, 'Site One', 'orders@one.example', ${ACTOR_A})
      `;
      await tx`
        insert into app.email_templates (workspace_id, key, subject, body, version, updated_by)
        values (${WORKSPACE_1}, 'order_received', 'Thanks', 'We have your order.', 1, ${ACTOR_A})
      `;
      await tx`
        insert into app.email_template_versions (workspace_id, key, version, subject, body, created_by)
        values (${WORKSPACE_1}, 'order_received', 1, 'Thanks', 'We have your order.', ${ACTOR_A})
      `;
      await tx`
        insert into app.automations (workspace_id, key, updated_by)
        values (${WORKSPACE_1}, 'order_received', ${ACTOR_A})
      `;
      await tx`
        insert into app.automation_runs (workspace_id, automation_key, lead_id, outcome, job_id)
        values (${WORKSPACE_1}, 'order_received', ${lead1}, 'queued', ${crypto.randomUUID()})
      `;
    });

    for (const table of NEW_TABLES) {
      const own = await asRuntime(WORKSPACE_1, ACTOR_A, (tx) => {
        return tx.unsafe(`select workspace_id from app.${table}`);
      });
      expect(own.length, table).toBeGreaterThan(0);
      const other = await asRuntime(WORKSPACE_2, ACTOR_A, (tx) => {
        return tx.unsafe(`select workspace_id from app.${table}`);
      });
      expect(other, table).toHaveLength(0);
    }

    const changed = await asRuntime(WORKSPACE_2, ACTOR_A, (tx) => {
      return tx`update app.automations set enabled = true where workspace_id = ${WORKSPACE_1}`;
    });
    expect(changed.count).toBe(0);
    await expect(
      asRuntime(WORKSPACE_2, ACTOR_A, (tx) => {
        return tx`
          insert into app.automations (workspace_id, key, updated_by)
          values (${WORKSPACE_1}, 'mobility_activated', ${ACTOR_A})
        `;
      }),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
  });

  it('idempotency_keys: one key per site and scope, completed only with its lead', async () => {
    await admin`
      insert into app.idempotency_keys (workspace_id, scope, key_hash, request_fingerprint)
      values (${WORKSPACE_1}, 'lead_submission', ${HASH_A}, ${FINGERPRINT})
    `;
    await expect(
      admin`
        insert into app.idempotency_keys (workspace_id, scope, key_hash, request_fingerprint)
        values (${WORKSPACE_1}, 'lead_submission', ${HASH_A}, ${FINGERPRINT})
      `,
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    // The same hash on another site is another key.
    const [other] = await admin<{ status: string; lead_id: string | null }[]>`
      insert into app.idempotency_keys (workspace_id, scope, key_hash, request_fingerprint)
      values (${WORKSPACE_2}, 'lead_submission', ${HASH_A}, ${FINGERPRINT})
      returning status, lead_id
    `;
    expect(other).toEqual({ status: 'pending', lead_id: null });

    // Completing it needs both the lead and the time.
    await admin`
      update app.idempotency_keys
      set status = 'completed', completed_at = now(), lead_id = ${lead2}
      where workspace_id = ${WORKSPACE_2} and key_hash = ${HASH_A}
    `;
    const refused = [
      admin`insert into app.idempotency_keys
              (workspace_id, scope, key_hash, request_fingerprint, status, completed_at)
            values (${WORKSPACE_1}, 'lead_submission', ${HASH_B}, ${FINGERPRINT}, 'completed', now())`,
      admin`insert into app.idempotency_keys
              (workspace_id, scope, key_hash, request_fingerprint, status, lead_id)
            values (${WORKSPACE_1}, 'lead_submission', ${HASH_B}, ${FINGERPRINT}, 'completed', ${lead1})`,
      admin`insert into app.idempotency_keys
              (workspace_id, scope, key_hash, request_fingerprint, completed_at, lead_id)
            values (${WORKSPACE_1}, 'lead_submission', ${HASH_B}, ${FINGERPRINT}, now(), ${lead1})`,
      admin`insert into app.idempotency_keys (workspace_id, scope, key_hash, request_fingerprint)
            values (${WORKSPACE_1}, 'staff_note', ${HASH_B}, ${FINGERPRINT})`,
      admin`insert into app.idempotency_keys (workspace_id, scope, key_hash, request_fingerprint)
            values (${WORKSPACE_1}, 'lead_submission', ${HASH_B.toUpperCase()}, ${FINGERPRINT})`,
      admin`insert into app.idempotency_keys (workspace_id, scope, key_hash, request_fingerprint)
            values (${WORKSPACE_1}, 'lead_submission', ${HASH_B}, ${'c'.repeat(64)})`,
      admin`insert into app.idempotency_keys
              (workspace_id, scope, key_hash, request_fingerprint, status)
            values (${WORKSPACE_1}, 'lead_submission', ${HASH_B}, ${FINGERPRINT}, 'replayed')`,
    ];
    for (const statement of refused) {
      await expect(statement).rejects.toMatchObject({ code: CHECK_VIOLATION });
    }
    // A key's lead must be of its own site.
    await expect(
      admin`insert into app.idempotency_keys
              (workspace_id, scope, key_hash, request_fingerprint, status, completed_at, lead_id)
            values (${WORKSPACE_1}, 'lead_submission', ${HASH_B}, ${FINGERPRINT}, 'completed', now(), ${lead2})`,
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('workspace_email_settings takes its defaults and refuses bad values', async () => {
    const [settings] = await admin<
      { brand_color: string; footer_text: string; reply_to: null; logo_url: null; site_url: null }[]
    >`
      insert into app.workspace_email_settings (workspace_id, from_name, from_address, updated_by)
      values (${WORKSPACE_2}, 'Site Two', 'orders@two.example', ${ACTOR_A})
      returning brand_color, footer_text, reply_to, logo_url, site_url
    `;
    expect(settings).toEqual({
      brand_color: '#d72638',
      footer_text: '',
      reply_to: null,
      logo_url: null,
      site_url: null,
    });
    await admin`
      update app.workspace_email_settings
      set reply_to = 'help@two.example', logo_url = 'https://two.example/logo.png',
          site_url = 'https://two.example', brand_color = '#00aa11', footer_text = ${'f'.repeat(500)},
          from_name = ${'n'.repeat(80)}
      where workspace_id = ${WORKSPACE_2}
    `;

    const updates: [string, string][] = [
      ['logo_url', 'http://two.example/logo.png'],
      ['logo_url', `https://${'x'.repeat(2041)}`],
      ['site_url', 'http://two.example'],
      ['brand_color', '#D72638'],
      ['brand_color', 'red'],
      ['from_name', 'n'.repeat(81)],
      ['from_name', '   '],
      ['from_address', 'not an address'],
      ['from_address', `${'a'.repeat(250)}@b.ca`],
      ['reply_to', 'help@nowhere'],
      ['footer_text', 'f'.repeat(501)],
    ];
    for (const [column, value] of updates) {
      await expect(
        admin.unsafe(
          `update app.workspace_email_settings set ${column} = $1 where workspace_id = $2`,
          [value, WORKSPACE_2],
        ),
        `${column} = ${value.slice(0, 20)}`,
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    }
  });

  it('email_templates: the nine keys only, one per site and key, no enabled column', async () => {
    const keys = [
      'tracking_code',
      'order_received',
      'information_needed',
      'dispatched',
      'activated',
      'cancelled',
      'sim_number_ready',
      'change_approved',
      'change_rejected',
    ];
    for (const key of keys) {
      await admin`
        insert into app.email_templates (workspace_id, key, subject, body, version, updated_by)
        values (${WORKSPACE_2}, ${key}, 'Subject', 'Body', 1, ${ACTOR_A})
      `;
    }
    await expect(
      admin`
        insert into app.email_templates (workspace_id, key, subject, body, version, updated_by)
        values (${WORKSPACE_2}, 'dispatched', 'Again', 'Body', 2, ${ACTOR_A})
      `,
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });

    const refused = [
      admin`insert into app.email_templates (workspace_id, key, subject, body, version, updated_by)
            values (${WORKSPACE_1}, 'order_status', 'Subject', 'Body', 1, ${ACTOR_A})`,
      admin`insert into app.email_templates (workspace_id, key, subject, body, version, updated_by)
            values (${WORKSPACE_1}, 'dispatched', '', 'Body', 1, ${ACTOR_A})`,
      admin`insert into app.email_templates (workspace_id, key, subject, body, version, updated_by)
            values (${WORKSPACE_1}, 'dispatched', ${'s'.repeat(151)}, 'Body', 1, ${ACTOR_A})`,
      admin`insert into app.email_templates (workspace_id, key, subject, body, version, updated_by)
            values (${WORKSPACE_1}, 'dispatched', 'Subject', '', 1, ${ACTOR_A})`,
      admin`insert into app.email_templates (workspace_id, key, subject, body, version, updated_by)
            values (${WORKSPACE_1}, 'dispatched', 'Subject', ${'b'.repeat(5001)}, 1, ${ACTOR_A})`,
      admin`insert into app.email_templates (workspace_id, key, subject, body, version, updated_by)
            values (${WORKSPACE_1}, 'dispatched', 'Subject', 'Body', 0, ${ACTOR_A})`,
    ];
    for (const statement of refused) {
      await expect(statement).rejects.toMatchObject({ code: CHECK_VIOLATION });
    }

    const columns = await admin<{ column_name: string }[]>`
      select column_name::text from information_schema.columns
      where table_schema = 'app' and table_name = 'email_templates'
      order by ordinal_position
    `;
    expect(columns.map((column) => column.column_name)).not.toContain('enabled');
  });

  it('email_template_versions: one row per site, key and version', async () => {
    const version = (workspaceId: string, key: string, number: number) => admin`
      insert into app.email_template_versions (workspace_id, key, version, subject, body, created_by)
      values (${workspaceId}, ${key}, ${number}, 'Subject', 'Body', ${ACTOR_A})
    `;
    await version(WORKSPACE_2, 'activated', 1);
    await version(WORKSPACE_2, 'activated', 2);
    await version(WORKSPACE_2, 'cancelled', 1);
    await version(WORKSPACE_1, 'activated', 1);
    await expect(version(WORKSPACE_2, 'activated', 2)).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
    });
    await expect(version(WORKSPACE_2, 'activated', 0)).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
    await expect(version(WORKSPACE_2, 'order_status', 1)).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
  });

  it('automations: the six built-in keys only, once per site, a counter never below zero', async () => {
    const keys = [
      'order_received',
      'sim_order_information_needed',
      'sim_order_dispatched',
      'sim_order_activated',
      'sim_order_cancelled',
      'mobility_activated',
    ];
    for (const key of keys) {
      const [row] = await admin<{ enabled: boolean; run_count: number; last_run_at: null }[]>`
        insert into app.automations (workspace_id, key, updated_by)
        values (${WORKSPACE_2}, ${key}, ${ACTOR_A})
        returning enabled, run_count, last_run_at
      `;
      expect(row).toEqual({ enabled: false, run_count: 0, last_run_at: null });
    }
    await expect(
      admin`
        insert into app.automations (workspace_id, key, updated_by)
        values (${WORKSPACE_2}, 'order_received', ${ACTOR_A})
      `,
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    await expect(
      admin`
        insert into app.automations (workspace_id, key, updated_by)
        values (${WORKSPACE_2}, 'custom_x', ${ACTOR_A})
      `,
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(
      admin`
        update app.automations set run_count = -1
        where workspace_id = ${WORKSPACE_2} and key = 'order_received'
      `,
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('automation_runs: a legacy queued run has its job and a skipped one its reason; keys and reasons by shape', async () => {
    const run = (values: {
      key?: string;
      outcome: string;
      reason?: string | null;
      jobId?: string | null;
    }) => admin`
      insert into app.automation_runs (workspace_id, automation_key, lead_id, outcome, reason, job_id)
      values (${WORKSPACE_2}, ${values.key ?? 'sim_order_dispatched'}, ${lead2}, ${values.outcome},
        ${values.reason ?? null}, ${values.jobId ?? null})
    `;
    await run({ outcome: 'queued', jobId: crypto.randomUUID() });
    for (const reason of ['no_sender', 'no_customer_email', 'missing_fill_in', 'bounced']) {
      await run({ outcome: 'skipped', reason });
    }
    // 0019 keeps only each legacy check's one direction, and keys and reasons by shape.
    await run({ outcome: 'queued', jobId: crypto.randomUUID(), reason: 'no_sender' });
    await run({ outcome: 'skipped', reason: 'no_sender', jobId: crypto.randomUUID() });
    await run({ key: 'flow_abcdefghij012345', outcome: 'skipped', reason: 'no_sender' });

    const refused = [
      run({ outcome: 'skipped' }),
      run({ outcome: 'queued' }),
      run({ outcome: 'skipped', reason: 'Bounced!' }),
      run({ outcome: 'failed', reason: 'no_sender' }),
      run({ key: 'X', outcome: 'skipped', reason: 'no_sender' }),
    ];
    for (const statement of refused) {
      await expect(statement).rejects.toMatchObject({ code: CHECK_VIOLATION });
    }

    // Removing the lead removes its runs.
    const doomed = await insertLead(WORKSPACE_2);
    await admin`
      insert into app.automation_runs (workspace_id, automation_key, lead_id, outcome, reason)
      values (${WORKSPACE_2}, 'order_received', ${doomed}, 'skipped', 'no_sender')
    `;
    await admin`delete from app.leads where id = ${doomed}`;
    const left = await admin`select id from app.automation_runs where lead_id = ${doomed}`;
    expect(left).toHaveLength(0);
  });

  it('email_messages.template_version is nullable and never negative', async () => {
    const [column] = await admin<{ data_type: string; is_nullable: string; default: null }[]>`
      select data_type::text, is_nullable::text, column_default as default
      from information_schema.columns
      where table_schema = 'app' and table_name = 'email_messages'
        and column_name = 'template_version'
    `;
    expect(column).toEqual({ data_type: 'integer', is_nullable: 'YES', default: null });

    const insert = (templateVersion: number | null) => admin`
      insert into app.email_messages (workspace_id, message_id, template, message_class, lead_id,
        contact_hash, template_version)
      values (${WORKSPACE_2}, ${crypto.randomUUID()}, 'order_received', 'transactional', ${lead2},
        'ci-hash', ${templateVersion})
    `;
    await insert(null);
    await insert(0);
    await insert(3);
    await expect(insert(-1)).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it("0014's statements re-run cleanly", async () => {
    const statements = runtimeMigrationStatements();
    expect(statements.length).toBeGreaterThan(0);
    await inRolledBackTransaction(async (tx) => {
      for (const statement of statements) await tx.unsafe(statement);
      for (const statement of statements) await tx.unsafe(statement);
      const [function_] = await tx<{ source: string }[]>`
        select prosrc as source from pg_proc
        where pronamespace = 'app'::regnamespace and proname = 'prune_operational_rows'
      `;
      expect(function_?.source).toContain('app.idempotency_keys');
      expect(function_?.source).toContain('app.automation_runs');
    });
  });
});
