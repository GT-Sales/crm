import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';

import { DatabaseAiReadService } from '../src/ai/read-service.js';
import { resolveTaskDueWindow } from '../src/ai/windows.js';
import { disposableTestDatabaseUrl } from './support/flows.js';
import { TEST_RUNTIME_PASSWORD } from '@gt-sales/db/test-helpers';

const migrationUrl = disposableTestDatabaseUrl();
const databaseTest = migrationUrl ? describe : describe.skip;

const WORKSPACE = '1d000000-0000-4000-8000-000000003801';
const ACTOR = '2d000000-0000-4000-8000-000000003801';
const NOW = new Date('2026-11-19T15:00:00.000Z');
const DUE_ANY = resolveTaskDueWindow('any', NOW);
const scope = { workspaceId: WORKSPACE, actorId: ACTOR };
const page = { assignee: 'all', due: DUE_ANY, limit: 20, offset: 0 } as const;

/**
 * Ask AI's task read finds the task a person means: done tasks most recently
 * completed first, cancelled ones most recently changed first, undated active
 * tasks before the dated ones (no due window can reach them otherwise), and a
 * title filter whose `%` and `_` are taken literally.
 */
databaseTest('Ask AI finds the task to move (listOpenTasks order and title filter)', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let reads: DatabaseAiReadService;

  async function insertTask(task: {
    title: string;
    status: 'open' | 'in_progress' | 'done' | 'cancelled';
    dueAt?: string | null;
    completedAt?: string | null;
    updatedAt?: string;
  }) {
    await admin`
      insert into app.lead_tasks (
        workspace_id, lead_id, title, status, due_at, completed_at, created_by, updated_at
      ) values (
        ${WORKSPACE}, null, ${task.title}, ${task.status}, ${task.dueAt ?? null},
        ${task.completedAt ?? null}, ${ACTOR}, ${task.updatedAt ?? '2026-11-01T12:00:00.000Z'}
      )
    `;
  }

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    // Re-runnable: the cascade clears the site's tasks.
    await admin`delete from app.workspaces where id = ${WORKSPACE}`;
    await admin`
      insert into app.workspaces (id, slug, name)
      values (${WORKSPACE}, 'ci-ai-task-reads', 'CI AI Task Reads')
    `;
    // 120 dated open tasks: more than the tool's five pages of 20 can show.
    await admin`
      insert into app.lead_tasks (workspace_id, lead_id, title, status, due_at, created_by)
      select ${WORKSPACE}, null, 'Dated task ' || g, 'open',
        timestamptz '2026-10-01 12:00:00+00' + g * interval '1 day', ${ACTOR}
      from generate_series(1, 120) g
    `;
    await insertTask({ title: 'Undated plain task', status: 'open', dueAt: null });
    // 120 done tasks, completed long ago, due early: the old order put these first.
    await admin`
      insert into app.lead_tasks (
        workspace_id, lead_id, title, status, due_at, completed_at, created_by
      )
      select ${WORKSPACE}, null, 'Old done ' || g, 'done',
        timestamptz '2026-01-01 12:00:00+00' + g * interval '1 day',
        timestamptz '2026-03-01 12:00:00+00' + g * interval '1 hour', ${ACTOR}
      from generate_series(1, 120) g
    `;
    await insertTask({
      title: 'Supplier call finished today',
      status: 'done',
      dueAt: '2026-12-30T12:00:00.000Z',
      completedAt: '2026-11-19T14:00:00.000Z',
    });
    await insertTask({
      title: 'Cancelled long ago',
      status: 'cancelled',
      updatedAt: '2026-02-01T12:00:00.000Z',
    });
    await insertTask({
      title: 'Cancelled just now',
      status: 'cancelled',
      updatedAt: '2026-11-19T14:30:00.000Z',
    });
    for (const title of ['Call 100% of leads', 'a_b task', 'aXb task', 'Back\\slash task'])
      await insertTask({ title, status: 'open', dueAt: '2026-11-20T12:00:00.000Z' });

    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      maxConnections: 1,
      ssl: false,
    });
    reads = new DatabaseAiReadService(database);
  });

  afterAll(async () => {
    if (admin) await admin`delete from app.workspaces where id = ${WORKSPACE}`;
    await database?.close();
    await admin?.end();
  });

  it('lists done tasks most recently completed first', async () => {
    const done = await reads.openTasks(scope, { ...page, status: 'done' });
    expect(done.total).toBe(121);
    expect(done.rows[0]?.title).toBe('Supplier call finished today');
    expect(done.rows[1]?.title).toBe('Old done 120');
  });

  it('lists cancelled tasks most recently changed first', async () => {
    const cancelled = await reads.openTasks(scope, { ...page, status: 'cancelled' });
    expect(cancelled.rows.map((row) => row.title)).toEqual([
      'Cancelled just now',
      'Cancelled long ago',
    ]);
  });

  it('reaches an undated active task on the first page among many dated ones', async () => {
    const active = await reads.openTasks(scope, { ...page, status: 'active' });
    expect(active.total).toBe(125);
    expect(active.rows[0]?.title).toBe('Undated plain task');
    // The dated ones follow, soonest due first.
    expect(active.rows[1]?.title).toBe('Dated task 1');
  });

  it('narrows by a title fragment, case-insensitively, with % and _ taken literally', async () => {
    const titles = async (titleContains: string, status: 'active' | 'done' = 'active') =>
      (await reads.openTasks(scope, { ...page, status, titleContains })).rows.map(
        (row) => row.title,
      );
    expect(await titles('SUPPLIER', 'done')).toEqual(['Supplier call finished today']);
    expect(await titles('%')).toEqual(['Call 100% of leads']);
    expect(await titles('a_b')).toEqual(['a_b task']);
    expect(await titles('\\')).toEqual(['Back\\slash task']);
    const counted = await reads.openTasks(scope, { ...page, titleContains: 'Dated task 1' });
    // Dated task 1, 10–19 and 100–120.
    expect(counted.total).toBe(32);
  });
});
