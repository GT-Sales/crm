import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createDatabaseClient, type DatabaseClient } from '../src/index.js';
import { applyMigrations } from '../src/migrations.js';
import {
  getDisposableTestDatabaseUrl,
  setTestRuntimePassword,
  TEST_RUNTIME_PASSWORD,
} from '../src/test-helpers.js';

const migrationUrl = getDisposableTestDatabaseUrl();
const databaseTest = migrationUrl ? describe : describe.skip;

// Its own id range, so the file can run beside every other one on the same database.
const WORKSPACE_A = '10000000-0000-4000-8000-0000000038a1';
const WORKSPACE_B = '10000000-0000-4000-8000-0000000038b1';
const ACTOR_A = '20000000-0000-4000-8000-0000000038a1';
const ACTOR_B = '20000000-0000-4000-8000-0000000038b1';
const LEAD_B = '30000000-0000-4000-8000-0000000038b1';

/**
 * Migration 0038: a **plain task** is a row of `app.lead_tasks` with no lead.
 * The composite foreign key to the site's leads stays; Postgres's default
 * MATCH SIMPLE skips it when `lead_id` is null, and still checks it otherwise.
 */
databaseTest('plain tasks (0038)', () => {
  let admin: ReturnType<typeof postgres>;
  let tenant: DatabaseClient;

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    await applyMigrations({ connectionString: migrationUrl, ssl: false });
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false });
    await setTestRuntimePassword(admin);
    // Re-runnable: the cascade clears both sites' leads and tasks.
    await admin`delete from app.workspaces where id in (${WORKSPACE_A}, ${WORKSPACE_B})`;
    await admin`
      insert into app.workspaces (id, slug, name)
      values (${WORKSPACE_A}, 'ci-plain-tasks-a', 'CI Plain Tasks A'),
             (${WORKSPACE_B}, 'ci-plain-tasks-b', 'CI Plain Tasks B')
    `;
    await admin`
      insert into app.leads (id, workspace_id, lead_type, status, stage, consent_version)
      values (${LEAD_B}, ${WORKSPACE_B}, 'contact_message', 'submitted', 'new', 'ci')
    `;
    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    tenant = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      maxConnections: 1,
      ssl: false,
    });
  });

  afterAll(async () => {
    if (admin) await admin`delete from app.workspaces where id in (${WORKSPACE_A}, ${WORKSPACE_B})`;
    await tenant?.close();
    await admin?.end();
  });

  test('lead_id is nullable and the composite foreign key is unchanged', async () => {
    const [column] = await admin<{ isNullable: string }[]>`
      select is_nullable as "isNullable" from information_schema.columns
      where table_schema = 'app' and table_name = 'lead_tasks' and column_name = 'lead_id'
    `;
    expect(column?.isNullable).toBe('YES');
    const [fk] = await admin<{ definition: string }[]>`
      select pg_get_constraintdef(oid) as definition from pg_constraint
      where conname = 'lead_tasks_workspace_lead_fk'
    `;
    expect(fk?.definition).toBe(
      'FOREIGN KEY (workspace_id, lead_id) REFERENCES app.leads(workspace_id, id) ON DELETE CASCADE',
    );
  });

  test('the runtime role inserts a plain task in its own site', async () => {
    const rows = await tenant.withTenantTx({ workspaceId: WORKSPACE_A, actorId: ACTOR_A }, (tx) =>
      tx.execute<{ leadId: string | null; status: string }>(sql`
        insert into app.lead_tasks (workspace_id, lead_id, title, created_by)
        values (${WORKSPACE_A}, null, 'Call the supplier', ${ACTOR_A})
        returning lead_id as "leadId", status
      `),
    );
    expect(rows).toEqual([{ leadId: null, status: 'open' }]);
  });

  test('a plain task is still held to the title, status and completion checks', async () => {
    const insert = (title: string, status: string, completed: boolean) =>
      admin`
        insert into app.lead_tasks (workspace_id, lead_id, title, status, completed_at, created_by)
        values (${WORKSPACE_A}, null, ${title}, ${status}, ${completed ? new Date() : null}, ${ACTOR_A})
      `;
    await expect(insert('', 'open', false)).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'lead_tasks_title_check',
    });
    await expect(insert('x'.repeat(201), 'open', false)).rejects.toMatchObject({
      constraint_name: 'lead_tasks_title_check',
    });
    await expect(insert('Bad status', 'waiting', false)).rejects.toMatchObject({
      constraint_name: 'lead_tasks_status_check',
    });
    await expect(insert('Done without a time', 'done', false)).rejects.toMatchObject({
      constraint_name: 'lead_tasks_completion_check',
    });
    await expect(insert('Open with a time', 'in_progress', true)).rejects.toMatchObject({
      constraint_name: 'lead_tasks_completion_check',
    });
    await expect(insert('Done with a time', 'done', true)).resolves.toBeDefined();
  });

  test('row security keeps a plain task to its site', async () => {
    await admin`
      insert into app.lead_tasks (workspace_id, lead_id, title, created_by)
      values (${WORKSPACE_A}, null, 'Only site A sees this', ${ACTOR_A})
    `;
    const read = (workspaceId: string, actorId: string) =>
      tenant.withTenantTx({ workspaceId, actorId }, (tx) =>
        tx.execute<{ title: string }>(sql`
          select title from app.lead_tasks where title = 'Only site A sees this'
        `),
      );
    expect(await read(WORKSPACE_A, ACTOR_A)).toHaveLength(1);
    expect(await read(WORKSPACE_B, ACTOR_B)).toHaveLength(0);
    // Nor may site B write one under site A's id.
    await expect(
      tenant.withTenantTx({ workspaceId: WORKSPACE_B, actorId: ACTOR_B }, (tx) =>
        tx.execute(sql`
          insert into app.lead_tasks (workspace_id, lead_id, title, created_by)
          values (${WORKSPACE_A}, null, 'Forged', ${ACTOR_B})
        `),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  test('the foreign key still refuses a lead of another site', async () => {
    await expect(
      admin`
        insert into app.lead_tasks (workspace_id, lead_id, title, created_by)
        values (${WORKSPACE_A}, ${LEAD_B}, 'Another site’s lead', ${ACTOR_A})
      `,
    ).rejects.toMatchObject({ code: '23503', constraint_name: 'lead_tasks_workspace_lead_fk' });
    // The same lead in its own site is accepted.
    await expect(
      admin`
        insert into app.lead_tasks (workspace_id, lead_id, title, created_by)
        values (${WORKSPACE_B}, ${LEAD_B}, 'Its own site’s lead', ${ACTOR_B})
      `,
    ).resolves.toBeDefined();
  });
});
