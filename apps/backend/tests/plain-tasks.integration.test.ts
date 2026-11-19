import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  leadTaskResponseSchema,
  leadTaskSchema,
  listWorkspaceTasksResponseSchema,
  type LeadTask,
} from '@gt-sales/contracts';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';

import { createApp } from '../src/app.js';
import { DatabaseLeadStore } from '../src/leads/store.js';
import { fixedPlainTaskSchema } from '../src/leads/task-schema.js';
import { DatabaseLeadWorkStore } from '../src/leads/work-store.js';
import type { StaffStore } from '../src/staff/store.js';
import type { WebsiteCredentialStore } from '../src/website/store.js';
import { disposableTestDatabaseUrl, flowKey, insertActiveFlow } from './support/flows.js';

const migrationUrl = disposableTestDatabaseUrl();
const databaseTest = migrationUrl ? describe : describe.skip;

// Its own id range and sites, so every count below is exact on a shared database.
const WORKSPACE = '1b000000-0000-4000-8000-000000003801';
const PRE_0038_WORKSPACE = '1b000000-0000-4000-8000-000000003802';
const OWNER = '2b000000-0000-4000-8000-000000003801';
const COLLEAGUE = '2b000000-0000-4000-8000-000000003802';
const VIEWER = '2b000000-0000-4000-8000-000000003803';
const FINANCE = '2b000000-0000-4000-8000-000000003804';
const OUTSIDER = '2b000000-0000-4000-8000-000000003805';
const CREDENTIAL = '2b000000-0000-4000-8000-000000003806';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';

const ROLES: Record<string, ('owner' | 'leads' | 'viewer' | 'finance')[]> = {
  [OWNER]: ['owner'],
  [COLLEAGUE]: ['leads'],
  [VIEWER]: ['viewer'],
  [FINANCE]: ['finance'],
};

/** Each bearer token is the actor id it names; the roles come from `ROLES`. */
const staffStore: StaffStore = {
  bootstrapStaff: async () => [],
  loadStaffAccess: async (actorId, workspaceId) =>
    (workspaceId === WORKSPACE || workspaceId === PRE_0038_WORKSPACE) && ROLES[actorId]
      ? { membershipId: actorId, status: 'active', roles: ROLES[actorId] ?? [], permissions: [] }
      : undefined,
  inviteStaff: async () => {
    throw new Error('unused');
  },
  revokeStaff: async () => 'not_found',
  listAssignableMembers: async () => [],
  setDisplayName: async () => 0,
};

const unusedCredentialStore: WebsiteCredentialStore = {
  createCredential: async () => {
    throw new Error('unused');
  },
  listCredentials: async () => [],
  revokeCredential: async () => ({ status: 'not_found' }),
};

const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const noon = (day: string) => `${day}T12:00:00.000Z`;

databaseTest('plain tasks (a task with no lead)', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let work: DatabaseLeadWorkStore;
  let leadStore: DatabaseLeadStore;
  let server: Server;
  let base: string;
  let pre0038Server: Server;
  let pre0038Base: string;

  const call = (
    method: string,
    path: string,
    actor: string,
    body?: unknown,
    root = base,
  ): Promise<Response> =>
    fetch(`${root}/api/v1/staff/workspaces/${WORKSPACE}${path}`, {
      method,
      headers: { authorization: `Bearer ${actor}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  async function listen(app: ReturnType<typeof createApp>): Promise<[Server, string]> {
    const listening = app.listen(0);
    await new Promise<void>((resolve) => listening.once('listening', resolve));
    const address = listening.address();
    if (address === null || typeof address === 'string') throw new Error('expected TCP server');
    return [listening, `http://127.0.0.1:${address.port}`];
  }

  function appWith(store: DatabaseLeadWorkStore) {
    return createApp({
      staff: {
        sessionVerifier: {
          verify: async (token) => ({ actorId: token, verifiedEmail: `${token}@example.test` }),
        },
        store: staffStore,
        credentialStore: unusedCredentialStore,
        leadStore,
        leadWorkStore: store,
      },
    });
  }

  async function createPlain(body: unknown, actor = OWNER): Promise<LeadTask> {
    const response = await call('POST', '/tasks', actor, body);
    expect(response.status).toBe(201);
    return leadTaskResponseSchema.parse(await response.json()).task;
  }

  async function createLead(): Promise<string> {
    const created = await leadStore.createLead({
      workspaceId: WORKSPACE,
      actorId: CREDENTIAL,
      requestId: randomUUID(),
      leadType: 'internet',
      consentVersion: 'ci',
      contact: { fullName: 'Robin Lead', email: `${randomUUID()}@example.test` },
      submit: true,
    });
    return created.lead.id;
  }

  async function list(query: string, actor = OWNER) {
    const response = await call('GET', `/tasks?${query}`, actor);
    expect(response.status).toBe(200);
    return listWorkspaceTasksResponseSchema.parse(await response.json());
  }

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    // Re-runnable: the cascade clears both sites' leads, tasks, flows and timers.
    await admin`delete from app.audit_events where workspace_id in (${WORKSPACE}, ${PRE_0038_WORKSPACE})`;
    await admin`delete from app.workspaces where id in (${WORKSPACE}, ${PRE_0038_WORKSPACE})`;
    await admin`
      insert into app.workspaces (id, slug, name)
      values (${WORKSPACE}, 'ci-plain-tasks', 'CI Plain Tasks'),
             (${PRE_0038_WORKSPACE}, 'ci-plain-tasks-pre', 'CI Plain Tasks Pre')
    `;
    await admin`
      insert into app.memberships (workspace_id, user_id, membership_type, status, accepted_at)
      values (${WORKSPACE}, ${OWNER}, 'staff', 'active', now()),
             (${WORKSPACE}, ${COLLEAGUE}, 'staff', 'active', now()),
             (${WORKSPACE}, ${VIEWER}, 'staff', 'active', now()),
             (${WORKSPACE}, ${FINANCE}, 'staff', 'active', now())
    `;
    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      maxConnections: 2,
      ssl: false,
    });
    leadStore = new DatabaseLeadStore(database);
    work = new DatabaseLeadWorkStore(database);
    [server, base] = await listen(appWith(work));
    // The same backend before the owner applies 0038: the probe's fixed seam says not ready.
    [pre0038Server, pre0038Base] = await listen(
      appWith(new DatabaseLeadWorkStore(database, undefined, fixedPlainTaskSchema(false))),
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await new Promise<void>((resolve) =>
      pre0038Server ? pre0038Server.close(() => resolve()) : resolve(),
    );
    await database?.close();
    await admin?.end();
  });

  it('creates a plain task with an audit of keys only and no timeline entry', async () => {
    const task = await createPlain({
      title: 'Call the supplier',
      dueAt: noon(today),
      assignedActorId: OWNER,
    });
    expect(task).toMatchObject({
      leadId: null,
      title: 'Call the supplier',
      dueAt: noon(today),
      assignedActorId: OWNER,
      status: 'open',
      completedAt: null,
      createdBy: OWNER,
    });
    const audits = await admin<{ action: string; entity: string; after: unknown }[]>`
      select action, entity, after from app.audit_events
      where workspace_id = ${WORKSPACE} and entity_id = ${task.id}
    `;
    expect(audits).toEqual([
      {
        action: 'lead.task_created',
        entity: 'lead_task',
        after: { leadId: null, dueAt: noon(today), assignedActorId: OWNER },
      },
    ]);
    expect(JSON.stringify(audits)).not.toContain('supplier');
    const [entries] = await admin<{ count: number }[]>`
      select count(*)::int as count from app.lead_activities where workspace_id = ${WORKSPACE}
    `;
    expect(entries?.count).toBe(0);
  });

  it('defaults to no due date and no assignee, as the lead task form does', async () => {
    const task = await createPlain({ title: '  Order SIM stock  ' });
    expect(task).toMatchObject({ title: 'Order SIM stock', dueAt: null, assignedActorId: null });
  });

  it('needs lead.manage to create a plain task, like a lead’s task', async () => {
    for (const actor of [VIEWER, FINANCE]) {
      const response = await call('POST', '/tasks', actor, { title: 'Not allowed' });
      expect(response.status, actor).toBe(403);
    }
    // The Leads role may, as it may add a lead's task.
    await createPlain({ title: 'Leads may', assignedActorId: COLLEAGUE }, COLLEAGUE);
    const [refused] = await admin<{ count: number }[]>`
      select count(*)::int as count from app.lead_tasks
      where workspace_id = ${WORKSPACE} and title = 'Not allowed'
    `;
    expect(refused?.count).toBe(0);
  });

  it('refuses what the lead task route refuses', async () => {
    for (const body of [
      {},
      { title: '' },
      { title: 'x'.repeat(201) },
      { title: 'Bad day', dueAt: today },
      { title: 'Has a lead', leadId: randomUUID() },
    ]) {
      const response = await call('POST', '/tasks', OWNER, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    const stranger = await call('POST', '/tasks', OWNER, {
      title: 'For someone else',
      assignedActorId: OUTSIDER,
    });
    expect(stranger.status).toBe(422);
    expect((await stranger.json()).error.code).toBe('assignee_not_found');
  });

  it('moves a plain task through its stages exactly as a lead’s task, auditing only', async () => {
    const task = await createPlain({ title: 'Move me', assignedActorId: OWNER });
    const patch = async (status: string) => {
      const response = await call('PATCH', `/tasks/${task.id}`, OWNER, { status });
      expect(response.status, status).toBe(200);
      return leadTaskResponseSchema.parse(await response.json()).task;
    };
    expect(await patch('in_progress')).toMatchObject({ status: 'in_progress', completedAt: null });
    const done = await patch('done');
    expect(done.status).toBe('done');
    expect(done.completedAt).not.toBeNull();
    expect(await patch('open')).toMatchObject({ status: 'open', completedAt: null });
    const edited = await call('PATCH', `/tasks/${task.id}`, OWNER, {
      title: 'Moved and renamed',
      dueAt: noon(today),
      assignedActorId: COLLEAGUE,
    });
    expect(leadTaskResponseSchema.parse(await edited.json()).task).toMatchObject({
      leadId: null,
      title: 'Moved and renamed',
      dueAt: noon(today),
      assignedActorId: COLLEAGUE,
    });
    const audits = await admin<{ action: string; after: { status: string } }[]>`
      select action, after from app.audit_events
      where workspace_id = ${WORKSPACE} and entity_id = ${task.id} and action = 'lead.task_updated'
      order by created_at
    `;
    expect(audits.map((row) => row.after.status)).toEqual(['in_progress', 'done', 'open', 'open']);
    expect(JSON.stringify(audits)).not.toContain('renamed');
    const [entries] = await admin<{ count: number }[]>`
      select count(*)::int as count from app.lead_activities where workspace_id = ${WORKSPACE}
    `;
    expect(entries?.count).toBe(0);
  });

  it('shows a plain task on the board and in its assignee’s My tasks, only when asked for', async () => {
    const leadId = await createLead();
    const leadTask = await work.createTask({
      workspaceId: WORKSPACE,
      actorId: COLLEAGUE,
      requestId: randomUUID(),
      leadId,
      title: 'Lead follow-up',
      assignedActorId: COLLEAGUE,
    });
    if (leadTask.status !== 'saved') throw new Error('lead task not saved');
    const plain = await createPlain(
      { title: 'Colleague’s plain task', assignedActorId: COLLEAGUE },
      COLLEAGUE,
    );

    const mine = await list('assignee=me&status=active&plain=include', COLLEAGUE);
    const byId = new Map(mine.tasks.map((task) => [task.id, task]));
    expect(byId.get(plain.id)?.lead).toBeNull();
    expect(byId.get(leadTask.task.id)?.lead?.id).toBe(leadId);
    expect(byId.has(plain.id)).toBe(true);
    // Everyone's board too, and the owner's own list does not hold it.
    expect((await list('assignee=all&status=active&plain=include')).tasks.map((t) => t.id)).toEqual(
      expect.arrayContaining([plain.id, leadTask.task.id]),
    );
    expect((await list('assignee=me&plain=include')).tasks.map((t) => t.id)).not.toContain(
      plain.id,
    );
    // The board's Done column reads done tasks the same way.
    await call('PATCH', `/tasks/${plain.id}`, COLLEAGUE, { status: 'done' });
    const doneColumn = await list(
      `assignee=me&status=done&completedSince=${today}&plain=include`,
      COLLEAGUE,
    );
    expect(doneColumn.tasks.map((task) => task.id)).toContain(plain.id);
  });

  it('leaves plain tasks out for an older admin, whose list schema needs every task’s lead', async () => {
    const plain = await createPlain({ title: 'Invisible to older admins', assignedActorId: OWNER });
    const response = await call('GET', '/tasks?assignee=all&status=active', OWNER);
    const raw = await response.json();
    // The list item as an older admin parses it: a lead id and a lead summary required.
    const olderList = z.object({
      tasks: z.array(
        leadTaskSchema.extend({ leadId: z.uuid(), lead: z.object({ id: z.uuid() }).loose() }),
      ),
    });
    expect(olderList.safeParse(raw).success).toBe(true);
    expect(JSON.stringify(raw)).not.toContain(plain.id);
  });

  it('counts plain tasks as tasks, never as a lead’s follow-ups', async () => {
    const leadId = await createLead();
    const before = (await work.summary({ workspaceId: WORKSPACE, actorId: OWNER, dueBy: today }))
      .types;
    await createPlain({ title: 'Due today, no lead', dueAt: noon(today), assignedActorId: OWNER });
    const after = (await work.summary({ workspaceId: WORKSPACE, actorId: OWNER, dueBy: today }))
      .types;
    expect(after).toEqual(before);
    // A lead task due today is one.
    await work.createTask({
      workspaceId: WORKSPACE,
      actorId: OWNER,
      requestId: randomUUID(),
      leadId,
      title: 'Due today on a lead',
      dueAt: noon(today),
    });
    const counted = (
      await work.summary({ workspaceId: WORKSPACE, actorId: OWNER, dueBy: today })
    ).types.find((entry) => entry.leadType === 'internet');
    expect(counted?.followUpsDue).toBe(
      (before.find((entry) => entry.leadType === 'internet')?.followUpsDue ?? 0) + 1,
    );
    // The dashboard's "Follow-ups due" card (the task list) holds both.
    const due = await list(`assignee=all&status=active&dueBy=${today}&plain=include&pageSize=200`);
    expect(due.tasks.map((task) => task.title)).toEqual(
      expect.arrayContaining(['Due today, no lead', 'Due today on a lead']),
    );
  });

  it('never starts a task_overdue flow for a plain task (a flow runs on a lead)', async () => {
    await insertActiveFlow(admin, {
      workspaceId: WORKSPACE,
      key: flowKey('3801', 1),
      name: 'Overdue tasks',
      enabled: true,
      definition: {
        schemaVersion: 1,
        trigger: { kind: 'task_overdue', leadTypes: [], after: null, when: null },
        steps: [{ id: 's_notify', kind: 'send_email', template: 'cancelled' }],
      },
      actorId: OWNER,
    });
    const plain = await createPlain({ title: 'Overdue, no lead', dueAt: noon(yesterday) });
    // Reopened with a new due day: the store's other timer path.
    await call('PATCH', `/tasks/${plain.id}`, OWNER, { status: 'done' });
    await call('PATCH', `/tasks/${plain.id}`, OWNER, { status: 'open', dueAt: noon(today) });
    const leadId = await createLead();
    const leadTask = await work.createTask({
      workspaceId: WORKSPACE,
      actorId: OWNER,
      requestId: randomUUID(),
      leadId,
      title: 'Overdue on a lead',
      dueAt: noon(yesterday),
    });
    if (leadTask.status !== 'saved') throw new Error('lead task not saved');
    const timers = await admin<{ subjectId: string }[]>`
      select subject_id as "subjectId" from app.automation_timers
      where workspace_id = ${WORKSPACE} and trigger_kind = 'task_overdue'
    `;
    expect(timers.map((timer) => timer.subjectId)).toEqual([leadTask.task.id]);
  });

  it('answers 503 plain_tasks_unavailable, writing nothing, before 0038 is applied', async () => {
    const response = await fetch(
      `${pre0038Base}/api/v1/staff/workspaces/${PRE_0038_WORKSPACE}/tasks`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${OWNER}`, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Too early' }),
      },
    );
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.code).toBe('plain_tasks_unavailable');
    expect(JSON.stringify(body)).not.toMatch(/stack|lead_id|23502/);
    const [rows] = await admin<{ count: number }[]>`
      select count(*)::int as count from app.lead_tasks where workspace_id = ${PRE_0038_WORKSPACE}
    `;
    expect(rows?.count).toBe(0);
    // Everything else about tasks still answers on that backend.
    const listed = await fetch(
      `${pre0038Base}/api/v1/staff/workspaces/${PRE_0038_WORKSPACE}/tasks?assignee=all&plain=include`,
      { headers: { authorization: `Bearer ${OWNER}` } },
    );
    expect(listed.status).toBe(200);
  });
});
