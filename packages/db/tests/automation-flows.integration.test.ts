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

const SITE_1 = '18000000-0000-4000-8000-000000008101';
const SITE_2 = '18000000-0000-4000-8000-000000008102';
const SITE_3 = '18000000-0000-4000-8000-000000008103';
const ACTOR = '28000000-0000-4000-8000-000000008111';
const OTHER_ACTOR = '28000000-0000-4000-8000-000000008112';
const SITES = [SITE_1, SITE_2, SITE_3];

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const INSUFFICIENT_PRIVILEGE = '42501';

const NEW_TABLES = [
  'automation_step_runs',
  'automation_timers',
  'automation_versions',
  'automation_waits',
] as const;

const DISPATCHED_LABEL = 'When a SIM order moves to Delivered → send the Dispatched email';
const DEFINITION = {
  schemaVersion: 1,
  trigger: { kind: 'stage_entered', leadType: 'sim_order', stage: 'delivered', when: null },
  steps: [{ id: 's_mail0001', kind: 'send_email', template: 'dispatched' }],
};

/** The hand-written 0020 migration, statement by statement, as the migrator runs it. */
function runtimeMigrationStatements(): string[] {
  const text = readFileSync(`${migrationsFolder}/0020_automation_flows_runtime.sql`, 'utf8');
  return text
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** Thrown to roll a transaction back once its assertions have passed. */
class RolledBack extends Error {}

databaseTest('automation flows tables and migrations 0019 and 0020', () => {
  let admin: ReturnType<typeof postgres>;
  let runtimeSql: ReturnType<typeof postgres>;
  let lead1: string;
  let lead2: string;

  function asRuntime<T>(workspaceId: string, body: (tx: postgres.TransactionSql) => Promise<T>) {
    return runtimeSql.begin(async (tx) => {
      await tx`
        select set_config('app.workspace_id', ${workspaceId}, true),
               set_config('app.actor_id', ${ACTOR}, true)
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
    await admin`delete from app.workspaces where id in ${admin(SITES)}`;
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

  async function insertFlow(
    workspaceId: string,
    values: { key?: string; origin?: string; name?: string | null } = {},
  ): Promise<string> {
    const [flow] = await admin<{ id: string }[]>`
      insert into app.automations (workspace_id, key, origin, name, updated_by)
      values (${workspaceId}, ${values.key ?? 'flow_abcdefghij012345'},
        ${values.origin ?? 'custom'}, ${values.name === undefined ? 'A flow' : values.name}, ${ACTOR})
      returning id
    `;
    if (!flow) throw new Error('the flow was not inserted');
    return flow.id;
  }

  async function insertVersion(
    workspaceId: string,
    automationId: string,
    values: { version?: number; status?: string } = {},
  ): Promise<string> {
    const status = values.status ?? 'draft';
    const activated = status === 'active' || status === 'retired';
    const [version] = await admin<{ id: string }[]>`
      insert into app.automation_versions
        (workspace_id, automation_id, version, status, definition, created_by, activated_at,
         retired_at)
      values (${workspaceId}, ${automationId}, ${values.version ?? 1}, ${status},
        ${admin.json(DEFINITION)}, ${ACTOR}, ${activated ? new Date() : null},
        ${status === 'retired' ? new Date() : null})
      returning id
    `;
    if (!version) throw new Error('the version was not inserted');
    return version.id;
  }

  async function insertRun(
    workspaceId: string,
    leadId: string,
    values: Record<string, unknown> = {},
  ): Promise<string> {
    const row = {
      workspace_id: workspaceId,
      automation_key: 'flow_abcdefghij012345',
      lead_id: leadId,
      ...values,
    };
    const [run] = await admin<{ id: string }[]>`
      insert into app.automation_runs ${admin(row)} returning id
    `;
    if (!run) throw new Error('the run was not inserted');
    return run.id;
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
        (${SITE_1}, 'ci-automation-flows-1', 'CI Automation Flows 1'),
        (${SITE_2}, 'ci-automation-flows-2', 'CI Automation Flows 2'),
        (${SITE_3}, 'ci-automation-flows-3', 'CI Automation Flows 3')
    `;
    await admin`
      insert into app.memberships (workspace_id, user_id, membership_type, status)
      values
        (${SITE_1}, ${ACTOR}, 'staff', 'active'),
        (${SITE_2}, ${ACTOR}, 'staff', 'active'),
        (${SITE_3}, ${ACTOR}, 'staff', 'revoked'),
        (${SITE_1}, ${OTHER_ACTOR}, 'staff', 'active')
    `;
    lead1 = await insertLead(SITE_1);
    lead2 = await insertLead(SITE_2);

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

  it('the four tables have RLS enabled and forced, two policies each, and 42 read policies in all', async () => {
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

  it('app_runtime may select, insert and update versions, waits and timers, update five columns of runs, insert step runs, and never delete; backup_reader reads all four', async () => {
    const expected: Record<string, { update: boolean }> = {
      automation_versions: { update: true },
      automation_waits: { update: true },
      automation_timers: { update: true },
      automation_runs: { update: false },
      automation_step_runs: { update: false },
    };
    for (const [table, { update }] of Object.entries(expected)) {
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
        update,
        delete: false,
        backup: true,
      });
    }

    // A run moves from waiting to its end; nothing else of it changes.
    const columns = await admin<{ column: string; update: boolean }[]>`
      select column_name::text as column,
        has_column_privilege('app_runtime', 'app.automation_runs', column_name, 'UPDATE') as update
      from information_schema.columns
      where table_schema = 'app' and table_name = 'automation_runs'
      order by column_name
    `;
    expect(columns.filter((row) => row.update).map((row) => row.column)).toEqual([
      'detail',
      'finished_at',
      'reason',
      'status',
      'updated_at',
    ]);
    expect(columns.map((row) => row.column)).toEqual(
      expect.arrayContaining(['automation_key', 'lead_id', 'job_id', 'outcome', 'occurrence']),
    );
    const run = await insertRun(SITE_1, lead1, { status: 'waiting', occurrence: 'grant-check' });
    const ended = await asRuntime(SITE_1, (tx) => {
      return tx`
        update app.automation_runs
        set status = 'completed', reason = null, detail = 'x', finished_at = now(), updated_at = now()
        where id = ${run}
      `;
    });
    expect(ended.count).toBe(1);
    for (const assignment of [
      "automation_key = 'order_received'",
      "outcome = 'queued'",
      "occurrence = 'other'",
      `job_id = '${crypto.randomUUID()}'`,
      'depth = 1',
    ]) {
      await expect(
        asRuntime(SITE_1, (tx) =>
          tx.unsafe(`update app.automation_runs set ${assignment} where id = '${run}'`),
        ),
        assignment,
      ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    }
    await admin`delete from app.automation_runs where id = ${run}`;

    for (const table of [...NEW_TABLES, 'automation_runs']) {
      await expect(
        asRuntime(SITE_1, (tx) => tx.unsafe(`delete from app.${table}`)),
        table,
      ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    }
  });

  it('a row of each new table is visible and writable only inside its site', async () => {
    const flow = await insertFlow(SITE_1, { key: 'flow_visibility000001', name: 'Visible' });
    await asRuntime(SITE_1, async (tx) => {
      await tx`
        insert into app.automation_versions (workspace_id, automation_id, version, definition, created_by)
        values (${SITE_1}, ${flow}, 1, ${tx.json(DEFINITION)}, ${ACTOR})
      `;
      const [run] = await tx<{ id: string }[]>`
        insert into app.automation_runs (workspace_id, automation_key, automation_id, lead_id, status)
        values (${SITE_1}, 'flow_visibility000001', ${flow}, ${lead1}, 'waiting')
        returning id
      `;
      if (!run) throw new Error('the run was not inserted');
      await tx`
        insert into app.automation_step_runs (workspace_id, run_id, step_id, step_kind, outcome)
        values (${SITE_1}, ${run.id}, 's_wait0001', 'wait', 'waiting')
      `;
      await tx`
        insert into app.automation_waits (workspace_id, run_id, automation_id, lead_id, step_id, resume_at)
        values (${SITE_1}, ${run.id}, ${flow}, ${lead1}, 's_wait0001', now() + interval '1 day')
      `;
      await tx`
        insert into app.automation_timers
          (workspace_id, automation_id, lead_id, trigger_kind, occurrence, event_at, due_at)
        values (${SITE_1}, ${flow}, ${lead1}, 'after_submitted', 'after_submitted', now(),
          now() + interval '1 day')
      `;
      const waits =
        await tx`update app.automation_waits set attempts = 1 where workspace_id = ${SITE_1}`;
      expect(waits.count).toBe(1);
    });

    for (const table of NEW_TABLES) {
      const own = await asRuntime(SITE_1, (tx) =>
        tx.unsafe(`select workspace_id from app.${table}`),
      );
      expect(own.length, table).toBeGreaterThan(0);
      const other = await asRuntime(SITE_2, (tx) =>
        tx.unsafe(`select workspace_id from app.${table}`),
      );
      expect(other, table).toHaveLength(0);
    }
    const changed = await asRuntime(SITE_2, (tx) => {
      return tx`update app.automation_timers set status = 'void' where workspace_id = ${SITE_1}`;
    });
    expect(changed.count).toBe(0);
    await expect(
      asRuntime(SITE_2, (tx) => {
        return tx`
          insert into app.automation_versions (workspace_id, automation_id, version, definition, created_by)
          values (${SITE_1}, ${flow}, 2, ${tx.json(DEFINITION)}, ${ACTOR})
        `;
      }),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await admin`delete from app.automations where id = ${flow}`;
  });

  it("an active version's definition cannot change, its status can", async () => {
    const flow = await insertFlow(SITE_2, { key: 'flow_immutable0000001' });
    const version = await insertVersion(SITE_2, flow);
    const changedDefinition = { ...DEFINITION, steps: [{ ...DEFINITION.steps[0], id: 's_other' }] };
    await asRuntime(SITE_2, async (tx) => {
      await tx`
        update app.automation_versions set definition = ${tx.json(changedDefinition)}
        where id = ${version}
      `;
      await tx`
        update app.automation_versions set status = 'active', activated_at = now(),
          activated_by = ${ACTOR}
        where id = ${version}
      `;
    });
    await expect(
      asRuntime(SITE_2, (tx) => {
        return tx`
          update app.automation_versions set definition = ${tx.json(DEFINITION)} where id = ${version}
        `;
      }),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION, message: 'automation_version_immutable' });
    await asRuntime(SITE_2, (tx) => {
      return tx`
        update app.automation_versions set status = 'retired', retired_at = now() where id = ${version}
      `;
    });
    const [stored] = await admin<{ status: string; definition: unknown }[]>`
      select status, definition from app.automation_versions where id = ${version}
    `;
    expect(stored).toEqual({ status: 'retired', definition: changedDefinition });
    await expect(
      admin`update app.automation_versions set definition = ${admin.json(DEFINITION)} where id = ${version}`,
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await admin`delete from app.automations where id = ${flow}`;
  });

  it('an activated version cannot be moved back to draft to rewrite it, nor change once retired or discarded', async () => {
    const flow = await insertFlow(SITE_2, { key: 'flow_versionlock00001' });
    const active = await insertVersion(SITE_2, flow, { version: 1, status: 'active' });
    const retired = await insertVersion(SITE_2, flow, { version: 2, status: 'retired' });
    const discarded = await insertVersion(SITE_2, flow, { version: 3, status: 'discarded' });
    const draft = await insertVersion(SITE_2, flow, { version: 4, status: 'draft' });
    const refused = (id: string, assignment: string) =>
      expect(
        asRuntime(SITE_2, (tx) =>
          tx.unsafe(`update app.automation_versions set ${assignment} where id = '${id}'`),
        ),
        assignment,
      ).rejects.toMatchObject({ code: CHECK_VIOLATION, message: 'automation_version_immutable' });

    // The bypass: status back to draft, then rewrite the definition.
    await refused(active, "status = 'draft', activated_at = null, activated_by = null");
    await refused(retired, "status = 'draft', activated_at = null, retired_at = null");
    await refused(discarded, "status = 'draft'");
    await refused(retired, "status = 'active', retired_at = null");
    await refused(discarded, "status = 'active', activated_at = now()");
    await refused(active, "status = 'discarded', activated_at = null");
    await refused(draft, "status = 'retired', activated_at = now(), retired_at = now()");
    await refused(active, "activated_at = now() - interval '1 day'");
    await refused(active, `activated_by = '${OTHER_ACTOR}'`);
    await refused(retired, "retired_at = now() - interval '1 day'");
    await refused(draft, 'version = 9');
    await refused(draft, `automation_id = '${crypto.randomUUID()}'`);
    await refused(active, `created_by = '${OTHER_ACTOR}'`);

    // What the store does stays allowed.
    await asRuntime(SITE_2, async (tx) => {
      await tx`update app.automation_versions set status = 'retired', retired_at = now() where id = ${active}`;
      await tx`update app.automation_versions set definition = ${tx.json(DEFINITION)} where id = ${draft}`;
      await tx`
        update app.automation_versions set status = 'active', activated_at = now(), activated_by = ${ACTOR}
        where id = ${draft}
      `;
    });
    const [nextDraft] = await admin<{ id: string }[]>`
      insert into app.automation_versions (workspace_id, automation_id, version, definition, created_by)
      values (${SITE_2}, ${flow}, 5, ${admin.json(DEFINITION)}, ${ACTOR})
      returning id
    `;
    await asRuntime(SITE_2, (tx) => {
      return tx`update app.automation_versions set status = 'discarded' where id = ${nextDraft?.id ?? ''}`;
    });
    const statuses = await admin<{ version: number; status: string }[]>`
      select version, status from app.automation_versions where automation_id = ${flow} order by version
    `;
    expect(statuses).toEqual([
      { version: 1, status: 'retired' },
      { version: 2, status: 'retired' },
      { version: 3, status: 'discarded' },
      { version: 4, status: 'active' },
      { version: 5, status: 'discarded' },
    ]);
    await admin`delete from app.automations where id = ${flow}`;
  });

  it('one draft and one active version per flow', async () => {
    const flow = await insertFlow(SITE_2, { key: 'flow_oneofeach0000001' });
    await insertVersion(SITE_2, flow, { version: 1, status: 'active' });
    await insertVersion(SITE_2, flow, { version: 2, status: 'draft' });
    await insertVersion(SITE_2, flow, { version: 3, status: 'retired' });
    await insertVersion(SITE_2, flow, { version: 4, status: 'discarded' });
    await expect(
      insertVersion(SITE_2, flow, { version: 5, status: 'draft' }),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    await expect(
      insertVersion(SITE_2, flow, { version: 5, status: 'active' }),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    await expect(
      insertVersion(SITE_2, flow, { version: 2, status: 'discarded' }),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    const refused = [
      admin`insert into app.automation_versions (workspace_id, automation_id, version, definition, created_by)
            values (${SITE_2}, ${flow}, 0, ${admin.json(DEFINITION)}, ${ACTOR})`,
      admin`insert into app.automation_versions (workspace_id, automation_id, version, status, definition, created_by)
            values (${SITE_2}, ${flow}, 6, 'live', ${admin.json(DEFINITION)}, ${ACTOR})`,
      admin`insert into app.automation_versions (workspace_id, automation_id, version, status, definition, created_by)
            values (${SITE_2}, ${flow}, 6, 'active', ${admin.json(DEFINITION)}, ${ACTOR})`,
      admin`insert into app.automation_versions (workspace_id, automation_id, version, definition, created_by)
            values (${SITE_2}, ${flow}, 6, ${admin.json([DEFINITION])}, ${ACTOR})`,
      admin`insert into app.automation_versions (workspace_id, automation_id, version, schema_version, definition, created_by)
            values (${SITE_2}, ${flow}, 6, 2, ${admin.json(DEFINITION)}, ${ACTOR})`,
      admin`insert into app.automation_versions (workspace_id, automation_id, version, definition, created_by)
            values (${SITE_2}, ${flow}, 6, ${admin.json({ note: 'x'.repeat(65_536) })}, ${ACTOR})`,
    ];
    for (const statement of refused) {
      await expect(statement).rejects.toMatchObject({ code: CHECK_VIOLATION });
    }
    // A flow's versions go with it, and the flow may point at its active one.
    const [active] = await admin<{ id: string }[]>`
      select id from app.automation_versions where automation_id = ${flow} and status = 'active'
    `;
    await admin`update app.automations set active_version_id = ${active?.id ?? null} where id = ${flow}`;
    await expect(
      admin`update app.automations set active_version_id = ${crypto.randomUUID()} where id = ${flow}`,
    ).rejects.toMatchObject({ code: '23503' });
    await admin`delete from app.automations where id = ${flow}`;
    const left = await admin`select id from app.automation_versions where automation_id = ${flow}`;
    expect(left).toHaveLength(0);
  });

  it('automations keys follow their origin; an archived flow is custom and off; a custom flow has a name; a built-in may have none', async () => {
    const builtIn = await insertFlow(SITE_2, {
      key: 'sim_order_dispatched',
      origin: 'builtin',
      name: null,
    });
    await insertFlow(SITE_2, { key: 'flow_named00000000010', name: 'Follow up' });
    const insert = (values: Record<string, unknown>) =>
      admin`insert into app.automations ${admin({
        workspace_id: SITE_2,
        key: 'flow_refused000000010',
        origin: 'custom',
        name: 'A flow',
        updated_by: ACTOR,
        ...values,
      })}`;
    const refused = [
      insert({ origin: 'builtin', key: 'flow_refused000000010' }),
      insert({ origin: 'custom', key: 'order_received' }),
      insert({ key: 'flow_TOOSHORT' }),
      insert({ origin: 'other' }),
      insert({ name: null }),
      insert({ name: '   ' }),
      insert({ name: 'x'.repeat(81) }),
      insert({ description: 'x'.repeat(501) }),
      insert({ revision: -1 }),
      insert({ archived_at: new Date(), enabled: true }),
    ];
    for (const statement of refused) {
      await expect(statement).rejects.toMatchObject({ code: CHECK_VIOLATION });
    }
    await insert({ key: 'flow_archived00000010', archived_at: new Date(), description: '' });
    await expect(
      admin`update app.automations set archived_at = now() where id = ${builtIn}`,
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    const [defaults] = await admin<{ origin: string; revision: number; created: boolean }[]>`
      select origin, revision, created_at is not null as created from app.automations where id = ${builtIn}
    `;
    expect(defaults).toEqual({ origin: 'builtin', revision: 0, created: true });
    await admin`delete from app.automations where workspace_id = ${SITE_2}`;
  });

  it('runs: legacy outcomes keep their checks, new runs need none; status, depth 0 to 3 and the occurrence index', async () => {
    const id = await insertRun(SITE_2, lead2, {
      occurrence: 'occ-1',
      trigger_kind: 'stage_entered',
    });
    const [row] = await admin<{ status: string; outcome: null; depth: number; finished: null }[]>`
      select status, outcome, depth, finished_at as finished from app.automation_runs where id = ${id}
    `;
    expect(row).toEqual({ status: 'completed', outcome: null, depth: 0, finished: null });
    await expect(insertRun(SITE_2, lead2, { occurrence: 'occ-1' })).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
    });
    await insertRun(SITE_2, lead2, { occurrence: 'occ-1', automation_key: 'order_received' });
    await insertRun(SITE_2, lead2);
    await insertRun(SITE_2, lead2);
    await insertRun(SITE_2, lead2, { status: 'waiting', depth: 3 });
    await insertRun(SITE_2, lead2, {
      status: 'skipped',
      reason: 'loop_prevented',
      detail: 'x'.repeat(200),
    });
    await insertRun(SITE_2, lead2, { outcome: 'queued', job_id: crypto.randomUUID() });
    const refused = [
      insertRun(SITE_2, lead2, { depth: 4 }),
      insertRun(SITE_2, lead2, { depth: -1 }),
      insertRun(SITE_2, lead2, { status: 'waiting', finished_at: new Date() }),
      insertRun(SITE_2, lead2, { status: 'queued' }),
      insertRun(SITE_2, lead2, { trigger_kind: 'manual' }),
      insertRun(SITE_2, lead2, { detail: 'x'.repeat(201) }),
      insertRun(SITE_2, lead2, { occurrence: 'x'.repeat(201) }),
      insertRun(SITE_2, lead2, { outcome: 'queued' }),
      insertRun(SITE_2, lead2, { outcome: 'skipped' }),
      insertRun(SITE_2, lead2, { reason: 'Not a reason' }),
    ];
    for (const statement of refused) {
      await expect(statement).rejects.toMatchObject({ code: CHECK_VIOLATION });
    }
    const steps = (values: Record<string, unknown>) =>
      admin`insert into app.automation_step_runs ${admin({
        workspace_id: SITE_2,
        run_id: id,
        step_id: 's_b',
        step_kind: 'if_else',
        outcome: 'done',
        ...values,
      })}`;
    await steps({ branch: 'yes' });
    for (const values of [
      { branch: 'maybe' },
      { step_id: 'S B' },
      { step_kind: 'loop' },
      { outcome: 'queued' },
      { reason: '1bad' },
      { detail: 'x'.repeat(201) },
    ]) {
      await expect(steps(values)).rejects.toMatchObject({ code: CHECK_VIOLATION });
    }
    await admin`delete from app.automation_runs where workspace_id = ${SITE_2}`;
  });

  it('email templates take tpl_ keys with a name, built-ins without, and archive only tpl_', async () => {
    const template = (values: Record<string, unknown>) =>
      admin`insert into app.email_templates ${admin({
        workspace_id: SITE_2,
        key: 'tpl_abcdefghij012345',
        name: 'My note',
        subject: 'Hi',
        body: 'Hello',
        version: 1,
        updated_by: ACTOR,
        ...values,
      })}`;
    await template({});
    await template({ key: 'tpl_archived00000001', archived_at: new Date() });
    await template({ key: 'dispatched', name: null });
    for (const values of [
      { key: 'tpl_nameless00000001', name: null },
      { key: 'activated', name: 'Activated' },
      { key: 'cancelled', name: null, archived_at: new Date() },
      { key: 'tpl_short', name: 'Short' },
      { key: 'tpl_untrimmed0000001', name: ' Padded ' },
      { key: 'tpl_toolong000000001', name: 'x'.repeat(81) },
      { key: 'order_status', name: null },
    ]) {
      await expect(template(values)).rejects.toMatchObject({ code: CHECK_VIOLATION });
    }
    await admin`
      insert into app.email_template_versions (workspace_id, key, version, subject, body, created_by)
      values (${SITE_2}, 'tpl_abcdefghij012345', 1, 'Hi', 'Hello', ${ACTOR})
    `;
    await expect(
      admin`
        insert into app.email_template_versions (workspace_id, key, version, subject, body, created_by)
        values (${SITE_2}, 'tpl_bad', 1, 'Hi', 'Hello', ${ACTOR})
      `,
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await admin`delete from app.email_template_versions where workspace_id = ${SITE_2}`;
    await admin`delete from app.email_templates where workspace_id = ${SITE_2}`;
  });

  it('memberships take a plain notification address or none', async () => {
    const set = (address: string | null) => admin`
      update app.memberships set notification_email = ${address}
      where workspace_id = ${SITE_2} and user_id = ${ACTOR}
    `;
    await set('member@example.com');
    await set(null);
    for (const address of ['not-an-address', 'a b@example.com', `${'x'.repeat(250)}@e.co`]) {
      await expect(set(address)).rejects.toMatchObject({ code: CHECK_VIOLATION });
    }
  });

  it("record_staff_notification_email sets the caller's active memberships only, once", async () => {
    await admin`update app.memberships set notification_email = null where workspace_id in ${admin(SITES)}`;
    await admin`
      update app.memberships set notification_email = 'other@example.com'
      where workspace_id = ${SITE_1} and user_id = ${OTHER_ACTOR}
    `;
    const record = (address: string, actorId: string | null = ACTOR) =>
      runtimeSql.begin(async (tx) => {
        if (actorId) await tx`select set_config('app.actor_id', ${actorId}, true)`;
        const [row] = await tx<{ changed: number }[]>`
          select app.record_staff_notification_email(${address}) as changed
        `;
        return row?.changed;
      });
    expect(await record('  Member@Example.com ')).toBe(2);
    expect(await record('member@example.com')).toBe(0);
    expect(await record('new@example.com')).toBe(2);
    expect(await record('not an address')).toBe(0);
    const rows = await admin<
      { workspace_id: string; user_id: string; notification_email: string | null }[]
    >`
      select workspace_id, user_id, notification_email from app.memberships
      where workspace_id in ${admin(SITES)} order by workspace_id, user_id
    `;
    expect(rows).toEqual([
      { workspace_id: SITE_1, user_id: ACTOR, notification_email: 'new@example.com' },
      { workspace_id: SITE_1, user_id: OTHER_ACTOR, notification_email: 'other@example.com' },
      { workspace_id: SITE_2, user_id: ACTOR, notification_email: 'new@example.com' },
      { workspace_id: SITE_3, user_id: ACTOR, notification_email: null },
    ]);
    await expect(record('member@example.com', null)).rejects.toMatchObject({
      code: INSUFFICIENT_PRIVILEGE,
    });
  });

  it("current_workspace_identity names only the transaction's own site, and needs an actor", async () => {
    const identity = (settings: { workspaceId?: string; actorId?: string }) =>
      runtimeSql.begin(async (tx) => {
        if (settings.workspaceId) {
          await tx`select set_config('app.workspace_id', ${settings.workspaceId}, true)`;
        }
        if (settings.actorId)
          await tx`select set_config('app.actor_id', ${settings.actorId}, true)`;
        return tx<{ workspace_slug: string; workspace_name: string }[]>`
          select workspace_slug, workspace_name from app.current_workspace_identity()
        `;
      });
    expect(await identity({ workspaceId: SITE_1, actorId: ACTOR })).toEqual([
      { workspace_slug: 'ci-automation-flows-1', workspace_name: 'CI Automation Flows 1' },
    ]);
    expect(await identity({ workspaceId: SITE_2, actorId: ACTOR })).toEqual([
      { workspace_slug: 'ci-automation-flows-2', workspace_name: 'CI Automation Flows 2' },
    ]);
    // An actor-only transaction (sign-in), a site without an actor, a bare connection: nothing.
    expect(await identity({ actorId: ACTOR })).toEqual([]);
    expect(await identity({ workspaceId: SITE_1 })).toEqual([]);
    expect(await identity({})).toEqual([]);
    // The runtime still cannot read app.workspaces itself.
    const [privileges] = await admin<{ select: boolean; any: boolean }[]>`
      select has_table_privilege('app_runtime', 'app.workspaces', 'SELECT') as select,
        has_any_column_privilege('app_runtime', 'app.workspaces', 'SELECT') as any
    `;
    expect(privileges).toEqual({ select: false, any: false });
    const [definition] = await admin<
      {
        secdef: boolean;
        config: string[] | null;
        args: number;
        publicExecute: boolean;
        runtimeExecute: boolean;
      }[]
    >`
      select p.prosecdef as secdef, p.proconfig as config, p.pronargs::int as args,
        has_function_privilege('public', p.oid, 'EXECUTE') as "publicExecute",
        has_function_privilege('app_runtime', p.oid, 'EXECUTE') as "runtimeExecute"
      from pg_proc p
      where p.pronamespace = 'app'::regnamespace and p.proname = 'current_workspace_identity'
    `;
    expect(definition).toEqual({
      secdef: true,
      config: ['search_path=""'],
      args: 0,
      publicExecute: false,
      runtimeExecute: true,
    });
  });

  it("0020's statements re-run cleanly", async () => {
    const statements = runtimeMigrationStatements();
    expect(statements.length).toBeGreaterThan(0);
    await inRolledBackTransaction(async (tx) => {
      for (const statement of statements) await tx.unsafe(statement);
      for (const statement of statements) await tx.unsafe(statement);
      const [function_] = await tx<{ source: string }[]>`
        select prosrc as source from pg_proc
        where pronamespace = 'app'::regnamespace and proname = 'prune_operational_rows'
      `;
      expect(function_?.source).toContain('app.automation_timers');
      expect(function_?.source).toContain("x.status <> 'waiting'");
      const [fk] = await tx<{ count: number }[]>`
        select count(*)::int as count from pg_constraint
        where conname = 'automations_active_version_fk'
      `;
      expect(fk?.count).toBe(1);
    });
  });

  it('0020 backfills legacy-shaped rows once', async () => {
    const statements = runtimeMigrationStatements();
    await inRolledBackTransaction(async (tx) => {
      const [flow] = await tx<{ id: string }[]>`
        insert into app.automations (workspace_id, key, enabled, updated_by)
        values (${SITE_1}, 'sim_order_dispatched', true, ${ACTOR})
        returning id
      `;
      if (!flow) throw new Error('the flow was not inserted');
      const occurrence = crypto.randomUUID();
      const [job] = await tx<{ id: string }[]>`
        insert into app.outbox_jobs (workspace_id, job_type, dedupe_key, payload)
        values (${SITE_1}, 'lead_customer_email', ${`${lead1}:sim_order_dispatched:${occurrence}`},
          ${tx.json({})})
        returning id
      `;
      if (!job) throw new Error('the job was not inserted');
      const created = new Date('2026-09-01T10:00:00.000Z');
      await tx`
        insert into app.automation_runs (workspace_id, automation_key, lead_id, outcome, job_id, created_at)
        values (${SITE_1}, 'sim_order_dispatched', ${lead1}, 'queued', ${job.id}, ${created})
      `;
      await tx`
        insert into app.automation_runs (workspace_id, automation_key, lead_id, outcome, reason, created_at)
        values (${SITE_1}, 'sim_order_dispatched', ${lead1}, 'skipped', 'no_sender', ${created})
      `;
      // Rows as the old backend writes them: no version, no status beyond the default.
      for (const statement of statements) await tx.unsafe(statement);

      const read = async () => {
        const flows = await tx<
          {
            name: string;
            active: boolean;
            enabled: boolean;
            updated_at: Date;
          }[]
        >`
          select a.name, a.active_version_id = v.id as active, a.enabled, a.updated_at
          from app.automations a
          join app.automation_versions v on v.automation_id = a.id
          where a.id = ${flow.id}
        `;
        const versions = await tx<
          {
            version: number;
            status: string;
            same: boolean;
            activated_by: null;
            created_by: string;
          }[]
        >`
          select version, status, definition = app.builtin_flow_definition('sim_order_dispatched') as same,
            activated_by, created_by
          from app.automation_versions where automation_id = ${flow.id}
        `;
        const runs = await tx<
          {
            outcome: string;
            status: string;
            occurrence: string | null;
            finished: boolean;
            versioned: boolean;
            flow: boolean;
            updated_at: Date;
          }[]
        >`
          select r.outcome, r.status, r.occurrence, r.finished_at = r.created_at as finished,
            r.version_id = a.active_version_id as versioned, r.automation_id = a.id as flow,
            r.updated_at
          from app.automation_runs r
          join app.automations a on a.id = ${flow.id}
          where r.workspace_id = ${SITE_1} and r.automation_key = 'sim_order_dispatched'
          order by r.outcome
        `;
        return { flows, versions, runs };
      };

      const first = await read();
      expect(first.flows).toMatchObject([{ name: DISPATCHED_LABEL, active: true, enabled: true }]);
      expect(first.versions).toEqual([
        { version: 1, status: 'active', same: true, activated_by: null, created_by: ACTOR },
      ]);
      expect(first.runs).toMatchObject([
        {
          outcome: 'queued',
          status: 'completed',
          occurrence,
          finished: true,
          versioned: true,
          flow: true,
        },
        {
          outcome: 'skipped',
          status: 'skipped',
          occurrence: null,
          finished: true,
          versioned: true,
          flow: true,
        },
      ]);

      for (const statement of statements) await tx.unsafe(statement);
      expect(await read()).toEqual(first);
    });
  });

  it('the prune keeps waiting runs, drops finished runs with their steps and waits after 90 days, and old fired and void timers', async () => {
    const now = new Date('2026-12-31T12:00:00.000Z');
    const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);
    const flow = await insertFlow(SITE_1, { key: 'flow_prunetest0000010' });
    const run = async (occurrence: string, status: string, finishedAt: Date | null) => {
      const id = await insertRun(SITE_1, lead1, {
        automation_key: 'flow_prunetest0000010',
        automation_id: flow,
        occurrence,
        status,
        created_at: daysAgo(300),
        finished_at: finishedAt,
      });
      await admin`
        insert into app.automation_step_runs (workspace_id, run_id, step_id, step_kind, outcome)
        values (${SITE_1}, ${id}, 's_wait', 'wait', 'waiting')
      `;
      await admin`
        insert into app.automation_waits (workspace_id, run_id, automation_id, lead_id, step_id, resume_at, status)
        values (${SITE_1}, ${id}, ${flow}, ${lead1}, 's_wait', ${daysAgo(299)},
          ${status === 'waiting' ? 'pending' : 'cancelled'})
      `;
    };
    await run('waiting', 'waiting', null);
    await run('old', 'cancelled', daysAgo(91));
    await run('recent', 'failed', daysAgo(89));
    const timer = (occurrence: string, status: string, updatedAt: Date) => admin`
      insert into app.automation_timers
        (workspace_id, automation_id, lead_id, trigger_kind, occurrence, subject_id, event_at, due_at,
         status, updated_at)
      values (${SITE_1}, ${flow}, ${lead1}, 'task_overdue', ${occurrence}, ${crypto.randomUUID()},
        ${daysAgo(300)}, ${daysAgo(299)}, ${status}, ${updatedAt})
    `;
    await timer('fired-old', 'fired', daysAgo(91));
    await timer('void-old', 'void', daysAgo(91));
    await timer('void-recent', 'void', daysAgo(89));
    await timer('pending-old', 'pending', daysAgo(300));

    const pruned = await asRuntime(SITE_1, (tx) => {
      return tx<{ table_name: string; deleted: number }[]>`
        select table_name, deleted from app.prune_operational_rows(${SITE_1}::uuid, ${now})
        where table_name in ('automation_runs', 'automation_timers')
      `;
    });
    expect(pruned).toEqual([
      { table_name: 'automation_runs', deleted: 1 },
      { table_name: 'automation_timers', deleted: 1 + 1 },
    ]);
    const runs = await admin<{ occurrence: string }[]>`
      select occurrence from app.automation_runs where automation_id = ${flow} order by occurrence
    `;
    expect(runs.map((row) => row.occurrence)).toEqual(['recent', 'waiting']);
    const [counts] = await admin<{ steps: number; waits: number }[]>`
      select (select count(*)::int from app.automation_step_runs s
                join app.automation_runs r on r.id = s.run_id where r.automation_id = ${flow}) as steps,
             (select count(*)::int from app.automation_waits where automation_id = ${flow}) as waits
    `;
    expect(counts).toEqual({ steps: 2, waits: 2 });
    const timers = await admin<{ occurrence: string }[]>`
      select occurrence from app.automation_timers where automation_id = ${flow} order by occurrence
    `;
    expect(timers.map((row) => row.occurrence)).toEqual(['pending-old', 'void-recent']);
    await admin`delete from app.automations where id = ${flow}`;
  });
});
