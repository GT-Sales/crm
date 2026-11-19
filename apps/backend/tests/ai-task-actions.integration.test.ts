import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  aiActionProposalSchema,
  aiCapabilitiesResponseSchema,
  aiWirePartSchema,
  type AiActionProposal,
  type AiStreamPart,
} from '@gt-sales/contracts';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { z } from 'zod';

import { signAiAction } from '../src/ai/actions.js';
import type { AiAssistantConfig } from '../src/ai/config.js';
import type { AssistantEngine, EngineInput } from '../src/ai/engine.js';
import { DatabaseAiReadService } from '../src/ai/read-service.js';
import { DatabaseAiSiteContextStore } from '../src/ai/site-context.js';
import { createApp } from '../src/app.js';
import { DatabaseLeadStore } from '../src/leads/store.js';
import { fixedPlainTaskSchema } from '../src/leads/task-schema.js';
import { DatabaseLeadWorkStore } from '../src/leads/work-store.js';
import type { ReportStore } from '../src/reports/store.js';
import type { StaffStore } from '../src/staff/store.js';
import type { WebsiteCredentialStore } from '../src/website/store.js';
import { disposableTestDatabaseUrl } from './support/flows.js';

const migrationUrl = disposableTestDatabaseUrl();
const databaseTest = migrationUrl ? describe : describe.skip;

const WORKSPACE = '1c000000-0000-4000-8000-000000003801';
const OWNER = '2c000000-0000-4000-8000-000000003801';
const FINANCE = '2c000000-0000-4000-8000-000000003802';
const CREDENTIAL = '2c000000-0000-4000-8000-000000003803';
const KEY = 'synthetic-plain-task-signing-key';
const TEST_RUNTIME_PASSWORD = 'local_ci_runtime_password';
const NOW = new Date();
const tomorrow = new Date(NOW.getTime() + 86_400_000).toISOString().slice(0, 10);

const ROLES: Record<string, ('owner' | 'finance')[]> = {
  [OWNER]: ['owner'],
  [FINANCE]: ['finance'],
};

const staffStore: StaffStore = {
  bootstrapStaff: async () => [],
  loadStaffAccess: async (actorId, workspaceId) =>
    workspaceId === WORKSPACE && ROLES[actorId]
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

const reports: ReportStore = {
  sourceReport: async () => ({
    totals: { received: 0, submitted: 0, madeIt: 0 },
    rows: [],
    withSourceData: 0,
  }),
};

const config: AiAssistantConfig = {
  enabled: true,
  apiKey: KEY,
  signingKey: KEY,
  modelId: 'test/model',
  workspaceIds: new Set([WORKSPACE]),
};

const scriptSchema = z.array(z.object({ tool: z.string(), input: z.unknown() }));
const listThenMoveSchema = z.object({ status: z.string(), to: z.string() });
const listedSchema = z.object({
  data: z.object({ tasks: z.array(z.object({ taskId: z.string() })) }).optional(),
});

/**
 * A scripted model: each question names what it does, and every step runs
 * through the route's own tool executor (the same tools a real model gets).
 * Every tool result is kept for the test, and the system prompt of each turn.
 */
function scriptedEngine(results: { name: string; result: string }[], systems: string[]) {
  const engine: AssistantEngine = {
    kind: 'fake',
    async *stream(input: EngineInput) {
      systems.push(input.system);
      const question = input.messages.at(-1)?.text ?? '';
      const run = async (name: string, args: unknown) => {
        if (!input.executeTool) throw new Error('executor missing');
        const result = await input.executeTool(name, args);
        results.push({ name, result });
        return result;
      };
      const step = scriptSchema.parse(JSON.parse(question));
      for (const call of step) {
        if (call.tool === 'listThenMove') {
          const { status, to } = listThenMoveSchema.parse(call.input);
          const listed = listedSchema.parse(
            JSON.parse(await run('listOpenTasks', { status, due: 'any' })),
          );
          for (const task of listed.data?.tasks ?? [])
            await run('prepareTaskUpdate', { taskId: task.taskId, status: to });
        } else await run(call.tool, call.input);
      }
      yield { type: 'text', text: 'Ready for your review.' };
      yield { type: 'finish', outputTokens: 4 };
    },
  };
  return engine;
}

databaseTest('Ask AI: plain tasks and task moves', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let work: DatabaseLeadWorkStore;
  let leadStore: DatabaseLeadStore;
  let server: Server;
  let base: string;
  let pre0038: Server;
  let pre0038Base: string;
  const results: { name: string; result: string }[] = [];
  const systems: string[] = [];

  async function listen(store: DatabaseLeadWorkStore): Promise<[Server, string]> {
    const app = createApp({
      staff: {
        sessionVerifier: {
          verify: async (token) => ({ actorId: token, verifiedEmail: `${token}@example.test` }),
        },
        store: staffStore,
        credentialStore: unusedCredentialStore,
        leadStore,
        leadWorkStore: store,
        reportStore: reports,
        ai: {
          config,
          siteContext: new DatabaseAiSiteContextStore(database),
          reads: new DatabaseAiReadService(database),
          engine: scriptedEngine(results, systems),
          rateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
          now: () => new Date(),
        },
      },
    });
    const listening = app.listen(0);
    await new Promise<void>((resolve) => listening.once('listening', resolve));
    const address = listening.address();
    if (address === null || typeof address === 'string') throw new Error('expected TCP server');
    return [listening, `http://127.0.0.1:${address.port}`];
  }

  const post = (path: string, body: unknown, actor = OWNER, root = base) =>
    fetch(`${root}/api/v1/staff/workspaces/${WORKSPACE}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${actor}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  async function ask(
    steps: { tool: string; input: unknown }[],
    actor = OWNER,
    root = base,
  ): Promise<AiStreamPart[]> {
    results.length = 0;
    const response = await post(
      '/ai/chat',
      { requestId: randomUUID(), message: JSON.stringify(steps), history: [] },
      actor,
      root,
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    return text
      .split('\n\n')
      .map((frame) =>
        frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n'),
      )
      .filter((payload) => payload.length > 0 && payload !== '[DONE]')
      .map((payload) => aiWirePartSchema.parse(JSON.parse(payload)).data);
  }

  const cardsOf = (parts: AiStreamPart[]): AiActionProposal[] =>
    parts.flatMap((part) => (part.type === 'actions' ? part.actions : []));

  async function tasksTitled(title: string) {
    return admin<
      {
        id: string;
        leadId: string | null;
        status: string;
        assignedActorId: string | null;
        dueAt: Date | null;
        completedAt: Date | null;
      }[]
    >`
      select id, lead_id as "leadId", status, assigned_actor_id as "assignedActorId",
        due_at as "dueAt", completed_at as "completedAt"
      from app.lead_tasks where workspace_id = ${WORKSPACE} and title = ${title}
    `;
  }

  async function plainTask(title: string, status: 'open' | 'in_progress' = 'open') {
    const created = await work.createPlainTask({
      workspaceId: WORKSPACE,
      actorId: OWNER,
      requestId: randomUUID(),
      title,
      assignedActorId: OWNER,
    });
    if (created.status !== 'saved') throw new Error('plain task not saved');
    if (status !== 'open')
      await work.updateTask({
        workspaceId: WORKSPACE,
        actorId: OWNER,
        requestId: randomUUID(),
        taskId: created.task.id,
        status,
      });
    return created.task.id;
  }

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    await admin`delete from app.audit_events where workspace_id = ${WORKSPACE}`;
    await admin`delete from app.workspaces where id = ${WORKSPACE}`;
    await admin`
      insert into app.workspaces (id, slug, name) values (${WORKSPACE}, 'ci-ai-tasks', 'CI AI Tasks')
    `;
    await admin`
      insert into app.memberships (workspace_id, user_id, membership_type, status, accepted_at, display_name)
      values (${WORKSPACE}, ${OWNER}, 'staff', 'active', now(), 'Owner'),
             (${WORKSPACE}, ${FINANCE}, 'staff', 'active', now(), 'Finance')
    `;
    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      maxConnections: 3,
      ssl: false,
    });
    leadStore = new DatabaseLeadStore(database);
    work = new DatabaseLeadWorkStore(database);
    [server, base] = await listen(work);
    [pre0038, pre0038Base] = await listen(
      new DatabaseLeadWorkStore(database, undefined, fixedPlainTaskSchema(false)),
    );
  });

  afterAll(async () => {
    for (const listening of [server, pre0038])
      await new Promise<void>((resolve) =>
        listening ? listening.close(() => resolve()) : resolve(),
      );
    await database?.close();
    await admin?.end();
  });

  it('offers plain tasks and task moves in the capabilities, beside the unchanged actions', async () => {
    const response = await fetch(`${base}/api/v1/staff/workspaces/${WORKSPACE}/ai/capabilities`, {
      headers: { authorization: `Bearer ${OWNER}` },
    });
    const capabilities = aiCapabilitiesResponseSchema.parse(await response.json());
    expect(capabilities.actions).toEqual(['task', 'note', 'email', 'lead_update']);
    expect(capabilities.taskActions).toEqual(['plain_task', 'task_update']);
    const early = await fetch(
      `${pre0038Base}/api/v1/staff/workspaces/${WORKSPACE}/ai/capabilities`,
      { headers: { authorization: `Bearer ${OWNER}` } },
    );
    expect(aiCapabilitiesResponseSchema.parse(await early.json()).taskActions).toEqual([
      'task_update',
    ]);
  });

  it('prepares a plain task when asked for one with no lead, and saves it only on Confirm', async () => {
    const title = 'Call the supplier';
    const parts = await ask([
      {
        tool: 'prepareTask',
        input: { leadId: null, title, dueDate: tomorrow, assignee: 'me' },
      },
    ]);
    expect(JSON.parse(results[0]?.result ?? '{}').status).toBe('confirmation_required');
    const [card] = cardsOf(parts);
    if (!card) throw new Error('expected a card');
    expect(card.draft).toEqual({ kind: 'task', title, dueDate: tomorrow, assignee: 'me' });
    expect(card.leadLabel).toBeUndefined();
    expect(card.leadHref).toBeUndefined();
    expect(await tasksTitled(title)).toEqual([]);

    const confirm = () => post('/ai/actions/confirm', { token: card.token });
    const saved = await confirm();
    expect(saved.status).toBe(200);
    const receipt = await saved.json();
    expect(receipt).toMatchObject({ status: 'saved', kind: 'task', actionId: card.id });
    const [task] = await tasksTitled(title);
    expect(task).toMatchObject({
      id: receipt.recordId,
      leadId: null,
      status: 'open',
      assignedActorId: OWNER,
    });
    expect(task?.dueAt?.toISOString()).toBe(`${tomorrow}T12:00:00.000Z`);
    // A retry is the same save.
    expect((await (await confirm()).json()).recordId).toBe(receipt.recordId);
    expect(await tasksTitled(title)).toHaveLength(1);
    const [audit] = await admin<{ after: Record<string, unknown> }[]>`
      select after from app.audit_events
      where workspace_id = ${WORKSPACE} and entity_id = ${receipt.recordId} and action = 'lead.task_created'
    `;
    expect(audit?.after).toEqual({
      leadId: null,
      dueAt: `${tomorrow}T12:00:00.000Z`,
      assignedActorId: OWNER,
      aiActionId: card.id,
      aiCardId: card.id,
    });
  });

  it('still attaches a lead a person names, and checks it exists in the site', async () => {
    const lead = await leadStore.createLead({
      workspaceId: WORKSPACE,
      actorId: CREDENTIAL,
      requestId: randomUUID(),
      leadType: 'internet',
      consentVersion: 'ci',
      contact: { fullName: 'Robin Lead', email: `${randomUUID()}@example.test` },
      submit: true,
    });
    const parts = await ask([
      {
        tool: 'prepareTask',
        input: { leadId: lead.lead.id, title: 'Call Robin', dueDate: null, assignee: 'none' },
      },
      {
        tool: 'prepareTask',
        input: { leadId: randomUUID(), title: 'Call nobody', dueDate: null, assignee: 'none' },
      },
    ]);
    const cards = cardsOf(parts);
    expect(cards.map((card) => card.draft)).toEqual([
      { kind: 'task', leadId: lead.lead.id, title: 'Call Robin', dueDate: null, assignee: 'none' },
    ]);
    expect(cards[0]?.leadHref).toBe(`/w/ci-ai-tasks/leads/${lead.lead.id}`);
    expect(JSON.parse(results[1]?.result ?? '{}').status).toBe('not_available');
  });

  it('keeps a revised plain-task card plain, and saves the draft once', async () => {
    const parts = await ask([
      {
        tool: 'prepareTask',
        input: { leadId: null, title: 'Order SIM stock', dueDate: null, assignee: 'none' },
      },
    ]);
    const [card] = cardsOf(parts);
    if (!card) throw new Error('expected a card');
    // A revision may not attach a lead the card did not have.
    const attached = await post('/ai/actions/revise', {
      token: card.token,
      draft: {
        kind: 'task',
        leadId: randomUUID(),
        title: 'Order SIM stock',
        dueDate: null,
        assignee: 'none',
      },
    });
    expect(attached.status).toBe(400);
    const revised = await post('/ai/actions/revise', {
      token: card.token,
      draft: { kind: 'task', title: 'Order 50 SIM cards', dueDate: tomorrow, assignee: 'me' },
    });
    expect(revised.status).toBe(200);
    const next = aiActionProposalSchema.parse(await revised.json());
    expect(next.draft).toEqual({
      kind: 'task',
      title: 'Order 50 SIM cards',
      dueDate: tomorrow,
      assignee: 'me',
    });
    expect(next.leadLabel).toBeUndefined();
    expect(await tasksTitled('Order 50 SIM cards')).toEqual([]);
    expect((await post('/ai/actions/confirm', { token: next.token })).status).toBe(200);
    const [task] = await tasksTitled('Order 50 SIM cards');
    expect(task).toMatchObject({ id: card.id, leadId: null });
    // The first version is then another version of a saved draft.
    const first = await post('/ai/actions/confirm', { token: card.token });
    expect(first.status).toBe(409);
    expect((await first.json()).error.details).toEqual({ reason: 'superseded' });
  });

  it('finds tasks by stage and moves them between stages through confirmed cards', async () => {
    const working = await plainTask('Working plain task', 'in_progress');
    const open = await plainTask('Open plain task');
    const parts = await ask([
      { tool: 'listThenMove', input: { status: 'in_progress', to: 'done' } },
    ]);
    const listed = JSON.parse(results[0]?.result ?? '{}');
    expect(listed.data.tasks).toEqual([
      expect.objectContaining({
        taskId: working,
        leadId: null,
        title: 'Working plain task',
        status: 'in_progress',
      }),
    ]);
    expect(JSON.stringify(listed)).not.toContain(open);
    const [card] = cardsOf(parts);
    if (!card) throw new Error('expected a move card');
    expect(card.draft).toEqual({ kind: 'task_update', taskId: working, status: 'done' });
    expect(card.taskUpdateContext).toMatchObject({
      title: 'Working plain task',
      before: 'in_progress',
      leadId: null,
    });
    expect(card.leadLabel).toBeUndefined();
    expect((await tasksTitled('Working plain task'))[0]?.status).toBe('in_progress');

    const saved = await post('/ai/actions/confirm', { token: card.token });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ kind: 'task_update', recordId: working });
    const [task] = await tasksTitled('Working plain task');
    expect(task?.status).toBe('done');
    expect(task?.completedAt).not.toBeNull();
    // A retry returns the receipt without moving it again.
    expect((await post('/ai/actions/confirm', { token: card.token })).status).toBe(200);
    const audits = await admin<{ action: string }[]>`
      select action from app.audit_events
      where workspace_id = ${WORKSPACE} and entity_id = ${working}
        and action in ('lead.task_updated', 'ai.task_updated')
      order by created_at, action
    `;
    // The setup's move to In progress, the confirmed move, and its one receipt.
    expect(audits.filter((row) => row.action === 'lead.task_updated')).toHaveLength(2);
    expect(audits.filter((row) => row.action === 'ai.task_updated')).toHaveLength(1);
  });

  it('refuses a stale move card, as a stale lead update is refused', async () => {
    const id = await plainTask('Changes under the card');
    const parts = await ask([
      { tool: 'prepareTaskUpdate', input: { taskId: id, status: 'in_progress' } },
    ]);
    const [card] = cardsOf(parts);
    if (!card) throw new Error('expected a move card');
    // Someone renames it on the Tasks page before Confirm.
    await work.updateTask({
      workspaceId: WORKSPACE,
      actorId: OWNER,
      requestId: randomUUID(),
      taskId: id,
      title: 'Changed under the card',
    });
    const refused = await post('/ai/actions/confirm', { token: card.token });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.code).toBe('conflict');
    expect((await tasksTitled('Changed under the card'))[0]?.status).toBe('open');
  });

  it('prepares no move to the stage a task is already in', async () => {
    const id = await plainTask('Already open');
    const parts = await ask([{ tool: 'prepareTaskUpdate', input: { taskId: id, status: 'open' } }]);
    expect(cardsOf(parts)).toEqual([]);
    expect(JSON.parse(results[0]?.result ?? '{}').status).toBe('not_available');
  });

  it('gives a member without lead.manage no card, and refuses a card signed for them', async () => {
    const capabilities = aiCapabilitiesResponseSchema.parse(
      await (
        await fetch(`${base}/api/v1/staff/workspaces/${WORKSPACE}/ai/capabilities`, {
          headers: { authorization: `Bearer ${FINANCE}` },
        })
      ).json(),
    );
    expect(capabilities.actions).toEqual([]);
    expect(capabilities.taskActions).toBeUndefined();
    const id = await plainTask('Not finance’s to move');
    const version = (
      await work.previewAiTaskUpdate({ workspaceId: WORKSPACE, actorId: FINANCE, taskId: id })
    )?.version;
    for (const draft of [
      { kind: 'task' as const, title: 'Forged plain task', dueDate: null, assignee: 'me' as const },
      { kind: 'task_update' as const, taskId: id, status: 'done' as const },
    ]) {
      const token = signAiAction(
        {
          id: randomUUID(),
          workspaceId: WORKSPACE,
          actorId: FINANCE,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          draft,
          ...(draft.kind === 'task_update' && version ? { taskUpdateVersion: version } : {}),
        },
        KEY,
      );
      const refused = await post('/ai/actions/confirm', { token }, FINANCE);
      expect(refused.status).toBe(403);
    }
    expect(await tasksTitled('Forged plain task')).toEqual([]);
    expect((await tasksTitled('Not finance’s to move'))[0]?.status).toBe('open');
  });

  it('before 0038 asks for a lead instead of preparing a plain task', async () => {
    const parts = await ask(
      [
        {
          tool: 'prepareTask',
          input: { leadId: null, title: 'Too early', dueDate: null, assignee: 'me' },
        },
      ],
      OWNER,
      pre0038Base,
    );
    expect(cardsOf(parts)).toEqual([]);
    const result = JSON.parse(results[0]?.result ?? '{}');
    expect(result.status).toBe('not_available');
    expect(result.message).toMatch(/lead/i);
    expect(systems.at(-1)).toContain('Every task needs a lead on this site for now');
    // A forged plain card is refused cleanly there, never a 500.
    const token = signAiAction(
      {
        id: randomUUID(),
        workspaceId: WORKSPACE,
        actorId: OWNER,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        draft: { kind: 'task', title: 'Too early', dueDate: null, assignee: 'me' },
      },
      KEY,
    );
    const refused = await post('/ai/actions/confirm', { token }, OWNER, pre0038Base);
    expect(refused.status).toBe(503);
    expect((await refused.json()).error.code).toBe('plain_tasks_unavailable');
  });
});
