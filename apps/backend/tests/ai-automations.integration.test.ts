import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '@gt-sales/db';
import { applyMigrations } from '@gt-sales/db/migrations';
import {
  aiAutomationProposalSchema,
  type AiAutomationProposalInput,
  type FlowDraft,
} from '@gt-sales/contracts';
import { AutomationAuthoringStore } from '../src/ai/automation-authoring.js';
import { simulateAutomation } from '../src/ai/automation-simulation.js';
import { DatabaseFlowStore } from '../src/automations/flow-store.js';
import { disposableTestDatabaseUrl } from './support/flows.js';

const url = disposableTestDatabaseUrl();
const suite = url ? describe : describe.skip;
const SITE = '18000000-0000-4000-8000-000000009401';
const OTHER = '18000000-0000-4000-8000-000000009402';
const ACTOR = '28000000-0000-4000-8000-000000009401';
const scope = {
  workspaceId: SITE,
  actorId: ACTOR,
  requestId: '58000000-0000-4000-8000-000000009401',
};
const now = new Date('2026-11-04T12:00:00Z');
const key = 'test-only-signing-key-never-production';
const draft: FlowDraft = {
  schemaVersion: 1,
  trigger: { kind: 'lead_submitted', leadTypes: ['sim_order'], when: null },
  steps: [{ id: 's_wait', kind: 'wait', for: { amount: 1, unit: 'days' } }],
};
const input: AiAutomationProposalInput = {
  draft: { name: 'AI follow-up', description: 'Test draft', definition: draft },
};

suite('AI automation proposals and atomic draft saves', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let store: AutomationAuthoringStore;
  let flows: DatabaseFlowStore;
  beforeAll(async () => {
    if (!url) throw new Error('test database required');
    await applyMigrations({ connectionString: url, ssl: false });
    admin = postgres(url, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe("ALTER ROLE app_runtime PASSWORD 'local_ci_runtime_password'");
    });
    await admin`delete from app.workspaces where id in (${SITE},${OTHER})`;
    await admin`insert into app.workspaces(id,slug,name) values(${SITE},'ai-automation-9401','AI Automation'),(${OTHER},'ai-automation-9402','Other')`;
    await admin`insert into app.memberships(workspace_id,user_id,membership_type,status) values(${SITE},${ACTOR},'staff','active')`;
    database = createDatabaseClient({
      connectionString: process.env.DATABASE_URL ?? '',
      ssl: false,
      maxConnections: 4,
    });
    store = new AutomationAuthoringStore(database);
    flows = new DatabaseFlowStore(database);
  });
  afterAll(async () => {
    if (admin) {
      await admin`delete from app.workspaces where id in (${SITE},${OTHER})`;
      await admin.end();
    }
    await database?.close();
  });
  const prepare = (value: AiAutomationProposalInput = input) =>
    store.prepare(scope, value, 'AI Automation', key, now);
  it('applies the 100-proposal cap and daily housekeeping to one member only', async () => {
    const colleague = '28000000-0000-4000-8000-000000009409';
    const stale = new Date(now.getTime() - 48 * 60 * 60_000);
    try {
      // A colleague on the same site at the cap, with stale rows of their own.
      await admin`
        insert into app.ai_automation_proposals (workspace_id, actor_id, payload, digest, expires_at, created_at)
        select ${SITE}, ${colleague}, '{}'::jsonb, 'digest', ${now}, case when g <= 5 then ${stale}::timestamptz else ${now}::timestamptz end
        from generate_series(1, 100) g
      `;
      // This member's own stale row is cleared by their next proposal.
      await admin`
        insert into app.ai_automation_proposals (workspace_id, actor_id, payload, digest, expires_at, created_at)
        values (${SITE}, ${ACTOR}, '{}'::jsonb, 'digest', ${stale}, ${stale})
      `;
      await expect(prepare()).resolves.toMatchObject({ draft: { name: 'AI follow-up' } });
      const [theirs] =
        await admin`select count(*)::int as count from app.ai_automation_proposals where actor_id=${colleague}`;
      expect(theirs?.count).toBe(100);
      const [ownStale] =
        await admin`select count(*)::int as count from app.ai_automation_proposals where actor_id=${ACTOR} and created_at=${stale}`;
      expect(ownStale?.count).toBe(0);

      // At this member's own cap the next proposal is refused.
      await admin`
        insert into app.ai_automation_proposals (workspace_id, actor_id, payload, digest, expires_at)
        select ${SITE}, ${ACTOR}, '{}'::jsonb, 'digest', ${now} from generate_series(1, 100)
      `;
      await expect(prepare()).rejects.toMatchObject({ code: 'limit_reached' });
    } finally {
      await admin`delete from app.ai_automation_proposals where workspace_id=${SITE}`;
    }
  });

  it('prepares a valid visual proposal without creating a custom automation', async () => {
    const before =
      await admin`select id from app.automations where workspace_id=${SITE} and origin='custom'`;
    const proposal = await prepare();
    expect(aiAutomationProposalSchema.safeParse(proposal).success).toBe(true);
    expect(proposal.draft.definition.steps[0]?.id).not.toBe('s_wait');
    expect(
      (await admin`select id from app.automations where workspace_id=${SITE} and origin='custom'`)
        .length,
    ).toBe(before.length);
  });
  it('saves exactly once across concurrent retries and starts Off with no active version', async () => {
    const p = await prepare();
    const [a, b] = await Promise.all([
      store.save(scope, p.token, key, now),
      store.save(scope, p.token, key, now),
    ]);
    expect(a).toEqual(b);
    const flow = await flows.get(scope, a.key);
    expect(flow?.enabled).toBe(false);
    expect(flow?.activeVersion).toBeNull();
    expect(flow?.draft).not.toBeNull();
    expect(await store.save(scope, p.token, key, new Date(now.getTime() + 11 * 60_000))).toEqual(a);
    await expect(
      store.save(scope, p.token, key, new Date(now.getTime() + 24 * 60 * 60_000)),
    ).rejects.toThrow('expired');
  });
  it('rejects altered tokens, keys, expiry, other actors and other tenants', async () => {
    const p = await prepare();
    await expect(store.save(scope, p.token + 'x', key, now)).rejects.toThrow();
    await expect(store.save(scope, p.token, 'different-key', now)).rejects.toThrow();
    await expect(
      store.save(scope, p.token, key, new Date(now.getTime() + 11 * 60_000)),
    ).rejects.toThrow('expired');
    await expect(store.save({ ...scope, workspaceId: OTHER }, p.token, key, now)).rejects.toThrow();
    await expect(
      store.save({ ...scope, actorId: '28000000-0000-4000-8000-000000009499' }, p.token, key, now),
    ).rejects.toThrow();
  });
  it('supersedes the old token on revision and keeps only the reviewed draft saveable', async () => {
    const p = await prepare();
    const next = await store.revise(
      scope,
      p.token,
      { ...p.draft, name: 'Reviewed name' },
      'AI Automation',
      key,
      now,
    );
    await expect(store.save(scope, p.token, key, now)).rejects.toThrow('expired');
    const saved = await store.save(scope, next.token, key, now);
    expect((await flows.get(scope, saved.key))?.name).toBe('Reviewed name');
  });
  it('edits a selected draft, preserves IDs, and rejects concurrent human updates', async () => {
    const p = await prepare();
    const saved = await store.save(scope, p.token, key, now);
    const current = await flows.get(scope, saved.key);
    if (!current?.draft) throw new Error('missing draft');
    const definition = p.draft.definition;
    const edit = await prepare({
      draft: { ...p.draft, name: 'Edited' },
      target: { key: saved.key, expectedRevision: current.revision, base: 'draft' },
    });
    expect(edit.draft.definition.steps[0]?.id).toBe(definition.steps[0]?.id);
    await flows.updateDetails(scope, saved.key, {
      expectedRevision: current.revision,
      name: 'Human edit',
      description: '',
    });
    await expect(store.save(scope, edit.token, key, now)).rejects.toThrow('revision_conflict');
    expect((await flows.get(scope, saved.key))?.name).toBe('Human edit');
  });
  it('does not replace a manual draft using an active base', async () => {
    const p = await prepare();
    const saved = await store.save(scope, p.token, key, now);
    await expect(
      prepare({
        ...input,
        target: { key: saved.key, expectedRevision: saved.revision, base: 'active' },
      }),
    ).rejects.toThrow('manual_draft_exists');
  });
  it('rolls back creation and receipt when a later save fails', async () => {
    const p = await prepare();
    const failedSave = vi
      .spyOn(DatabaseFlowStore.prototype, 'saveDraft')
      .mockResolvedValueOnce({ status: 'invalid', issues: ['injected failure'] });
    const before =
      await admin`select id from app.automations where workspace_id=${SITE} and origin='custom'`;
    try {
      await expect(store.save(scope, p.token, key, now)).rejects.toThrow();
    } finally {
      failedSave.mockRestore();
    }
    expect(
      (await admin`select id from app.automations where workspace_id=${SITE} and origin='custom'`)
        .length,
    ).toBe(before.length);
    const [row] = await admin`select result from app.ai_automation_proposals where id=${p.id}`;
    expect(row?.result).toBeNull();
  });
  it('simulates email, waits, tasks and both branches with zero business or outbox writes', async () => {
    const definition: FlowDraft = {
      ...draft,
      steps: [
        {
          id: 's_branch',
          kind: 'if_else',
          condition: { match: 'all', items: [{ kind: 'assignee', op: 'none' }] },
          then: [
            { id: 's_email', kind: 'send_email', template: 'order_received' },
            {
              id: 's_task',
              kind: 'create_task',
              title: 'Follow up',
              dueInDays: 1,
              assignee: { kind: 'none' },
            },
          ],
          else: [{ id: 's_wait', kind: 'wait', for: { amount: 1, unit: 'days' } }],
        },
      ],
    };
    const p = await prepare({ draft: { ...input.draft, definition } });
    const counts = async () => ({
      jobs: (await admin`select id from app.outbox_jobs where workspace_id=${SITE}`).length,
      leads: (await admin`select id from app.leads where workspace_id=${SITE}`).length,
      tasks: (await admin`select id from app.lead_tasks where workspace_id=${SITE}`).length,
    });
    const before = await counts();
    for (const assignedActorId of [null, ACTOR]) {
      const result = await simulateAutomation(
        {
          scope,
          token: p.token,
          key,
          now,
          store,
          scenario: {
            leadType: 'sim_order',
            stage: 'pending',
            planId: null,
            assignedActorId,
            properties: {},
          },
        },
        database,
      );
      expect(result.emailsQueued).toBe(0);
      expect(result.triggerMatched).toBe(true);
      expect(result.steps[0]?.branch).toBe(assignedActorId ? 'no' : 'yes');
      expect(result.uncoveredBranches).toHaveLength(1);
    }
    expect(await counts()).toEqual(before);
  });
  it('simulates stage moves through the live rules and keeps an owned lead without reassign (AUTH-2)', async () => {
    const definition: FlowDraft = {
      ...draft,
      steps: [
        // pending → activated is not a move SIM orders allow.
        { id: 's_skip', kind: 'update_lead', change: { kind: 'stage', stage: 'activated' } },
        { id: 's_verify', kind: 'update_lead', change: { kind: 'stage', stage: 'verified' } },
        // verified → delivered is allowed but needs a courier and documents.
        { id: 's_deliver', kind: 'update_lead', change: { kind: 'stage', stage: 'delivered' } },
        { id: 's_assign', kind: 'assign_lead', actorId: ACTOR, reassign: false },
      ],
    };
    const p = await prepare({ draft: { ...input.draft, definition } });
    const result = await simulateAutomation(
      {
        scope,
        token: p.token,
        key,
        now,
        store,
        scenario: {
          leadType: 'sim_order',
          stage: 'pending',
          planId: null,
          assignedActorId: ACTOR,
          properties: {},
        },
      },
      database,
    );
    expect(
      result.steps.map(({ stepId, outcome, reason }) => ({ stepId, outcome, reason })),
    ).toEqual([
      { stepId: p.draft.definition.steps[0]?.id, outcome: 'skipped', reason: 'illegal_stage_move' },
      { stepId: p.draft.definition.steps[1]?.id, outcome: 'done', reason: null },
      {
        stepId: p.draft.definition.steps[2]?.id,
        outcome: 'skipped',
        reason: 'dispatch_details_required',
      },
      { stepId: p.draft.definition.steps[3]?.id, outcome: 'skipped', reason: 'already_assigned' },
    ]);
  });
  it('simulates an edit with the schema of the flow it edits (AUTH-3)', async () => {
    const p = await prepare();
    const saved = await store.save(scope, p.token, key, now);
    const current = await flows.get(scope, saved.key);
    if (!current?.draft) throw new Error('missing draft');
    const edit = await prepare({
      draft: { ...p.draft, name: 'Edited custom' },
      target: { key: saved.key, expectedRevision: current.revision, base: 'draft' },
    });
    // A built-in's `main` step id is not valid in a custom flow. The loaded
    // proposal is swapped (its digest would refuse a stored change), so only
    // the schema the simulation picks can refuse it.
    const [first, ...rest] = edit.draft.definition.steps;
    if (!first) throw new Error('missing step');
    vi.spyOn(store, 'load').mockResolvedValueOnce({
      draft: {
        ...edit.draft,
        definition: { ...edit.draft.definition, steps: [{ ...first, id: 'main' }, ...rest] },
      },
      ...(edit.target ? { target: edit.target } : {}),
    });
    await expect(
      simulateAutomation(
        {
          scope,
          token: edit.token,
          key,
          now,
          store,
          scenario: {
            leadType: 'sim_order',
            stage: 'pending',
            planId: null,
            assignedActorId: null,
            properties: {},
          },
        },
        database,
      ),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
  it('evaluates trigger conditions and reports uncovered branches without executing mismatches', async () => {
    const p = await prepare({
      draft: {
        ...input.draft,
        definition: {
          ...draft,
          trigger: {
            kind: 'lead_submitted',
            leadTypes: ['sim_order'],
            when: { match: 'all', items: [{ kind: 'assignee', op: 'any' }] },
          },
        },
      },
    });
    const result = await simulateAutomation(
      {
        scope,
        token: p.token,
        key,
        now,
        store,
        scenario: {
          leadType: 'sim_order',
          stage: 'pending',
          assignedActorId: null,
          planId: null,
          properties: {},
        },
      },
      database,
    );
    expect(result.triggerMatched).toBe(false);
    expect(result.steps).toEqual([]);
  });
  it('forces row security and actor ownership even for unfiltered runtime reads', async () => {
    const p = await prepare();
    const { sql } = await import('drizzle-orm');
    const visible = await database.withTenantTx(
      { ...scope, actorId: '28000000-0000-4000-8000-000000009499' },
      (tx) => tx.execute(sql`select id from app.ai_automation_proposals`),
    );
    expect(visible).toHaveLength(0);
    const [settings] =
      await admin`select relrowsecurity,relforcerowsecurity from pg_class where oid='app.ai_automation_proposals'::regclass`;
    expect(settings).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    await admin`update app.ai_automation_proposals set payload=jsonb_set(payload,'{draft,name}','"tampered"') where id=${p.id}`;
    await expect(store.save(scope, p.token, key, now)).rejects.toThrow();
  });
  it('rejects scenario properties that are hidden, sensitive or unavailable', async () => {
    const p = await prepare();
    await expect(
      simulateAutomation(
        {
          scope,
          token: p.token,
          key,
          now,
          store,
          scenario: {
            leadType: 'sim_order',
            stage: 'pending',
            assignedActorId: null,
            planId: null,
            properties: { sin: 'synthetic' },
          },
        },
        database,
      ),
    ).rejects.toThrow('invalid');
  });
  it('accepts a minimal provider proposal assigning new SIM orders to the signed-in user', async () => {
    const { createAutomationTools } = await import('../src/ai/automation-tools.js');
    const { TurnBudget } = await import('../src/ai/limits.js');
    const { createGatewayEngine } = await import('../src/ai/engine.js');
    const { MockLanguageModelV4 } = await import('ai/test');
    const { simulateReadableStream } = await import('ai');
    const tools = createAutomationTools({
      scope,
      site: { name: 'AI Automation', slug: 'ai-automation-9401' },
      key,
      flows,
      store,
      now: () => now,
      budget: new TurnBudget(),
      loadAccess: async () => ({
        membershipId: ACTOR,
        status: 'active',
        roles: ['owner'],
        permissions: [],
      }),
    });
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined },
    };
    const call = (toolName: string, input: unknown) => ({
      stream: simulateReadableStream({
        chunks: [
          {
            type: 'tool-call' as const,
            toolCallId: crypto.randomUUID(),
            toolName,
            input: JSON.stringify(input),
          },
          {
            type: 'finish' as const,
            finishReason: { unified: 'tool-calls' as const, raw: undefined },
            usage,
          },
        ],
      }),
    });
    const model = new MockLanguageModelV4({
      doStream: [
        call('getAutomationCatalog', { section: 'members' }),
        call('proposeAutomationCreate', {
          draft: {
            name: 'Assign new orders to me',
            definition: {
              trigger: { kind: 'lead_submitted', leadTypes: ['sim_order'] },
              steps: [{ kind: 'assign_lead', actorId: 'me' }],
            },
          },
        }),
        {
          stream: simulateReadableStream({
            chunks: [{ type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage }],
          }),
        },
      ],
    });
    const engine = createGatewayEngine({ apiKey: 'synthetic', modelId: 'synthetic/test' }, model);
    for await (const event of engine.stream({
      system: 'Prepare a draft',
      messages: [{ role: 'user', text: 'Assign new SIM orders to me' }],
      tools: tools.definitions,
      automationAuthoring: true,
      hasPreparedDraft: () => tools.proposals.length > 0,
      signal: new AbortController().signal,
    })) {
      if (event.type === 'tool-end') expect(event.ok).toBe(true);
    }
    expect(tools.proposals).toHaveLength(1);
    expect(tools.proposals[0]?.draft.definition.steps[0]).toMatchObject({
      kind: 'assign_lead',
      actorId: ACTOR,
      reassign: false,
    });
  });
});
