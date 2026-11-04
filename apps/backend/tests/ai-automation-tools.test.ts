import { describe, it, expect, vi } from 'vitest';
import { createAutomationTools } from '../src/ai/automation-tools.js';
import { DatabaseFlowStore } from '../src/automations/flow-store.js';
import { AutomationAuthoringStore } from '../src/ai/automation-authoring.js';
import { TurnBudget } from '../src/ai/limits.js';
import type { StaffAccessSnapshot } from '../src/staff/authorization.js';
const scope = {
  workspaceId: '18000000-0000-4000-8000-000000009401',
  actorId: '28000000-0000-4000-8000-000000009401',
};
function setup(roles: StaffAccessSnapshot['roles'] = ['owner']) {
  const flows = new DatabaseFlowStore(),
    store = new AutomationAuthoringStore();
  const list = vi
    .spyOn(flows, 'list')
    .mockResolvedValue({ flows: [], needsAttention: new Map(), warnings: [], nextBefore: null });
  const access = { membershipId: scope.actorId, status: 'active' as const, roles, permissions: [] };
  const tools = createAutomationTools({
    scope,
    site: { name: 'Test', slug: 'test' },
    key: 'synthetic',
    flows,
    store,
    loadAccess: async () => access,
    now: () => new Date(),
    budget: new TurnBudget(),
  });
  return { tools, list, access, flows, store };
}
describe('automation tool authority and budgets', () => {
  it('rereads access and stops exposing flows when permissions change', async () => {
    const { tools, list, access } = setup();
    await tools.execute('listAutomations', {});
    expect(list).toHaveBeenCalledOnce();
    access.roles = ['viewer'];
    expect(JSON.parse(await tools.execute('listAutomations', {})).status).toBe('not_available');
    expect(list).toHaveBeenCalledOnce();
  });
  it('identifies the signed-in member independently of member pagination', async () => {
    const { tools, flows } = setup();
    vi.spyOn(flows, 'catalog').mockResolvedValue({
      leadTypes: [],
      templates: [],
      members: [{ actorId: scope.actorId, displayName: 'Casey' }],
      plans: [],
      properties: [],
      taskVariables: [],
    });
    const result = JSON.parse(
      await tools.execute('getAutomationCatalog', { section: 'members', offset: 10 }),
    );
    expect(result.currentMember).toEqual({
      reference: 'me',
      actorId: scope.actorId,
      displayName: 'Casey',
    });
    expect(result.entries).toEqual([]);
  });
  it('does not produce duplicate cards when a model repeats a proposal', async () => {
    const { tools, flows, store } = setup();
    const catalog = {
      leadTypes: [],
      templates: [],
      members: [{ actorId: scope.actorId, displayName: 'Casey' }],
      plans: [],
      properties: [],
      taskVariables: [],
    };
    vi.spyOn(flows, 'catalog').mockResolvedValue(catalog);
    const prepare = vi
      .spyOn(store, 'prepare')
      .mockImplementation(async (_scope, input, siteName, _key, now) => ({
        id: crypto.randomUUID(),
        token: 'synthetic',
        expiresAt: new Date(now.getTime() + 600000).toISOString(),
        siteName,
        draft: input.draft,
        ...(input.target ? { target: input.target } : {}),
        issues: [],
        changes: [],
        catalog,
      }));
    const input = {
      draft: {
        name: 'Assign my SIM orders',
        definition: {
          trigger: { kind: 'lead_submitted', leadTypes: ['sim_order'] },
          steps: [{ kind: 'assign_lead', actorId: 'me' }],
        },
      },
    };
    for (let i = 0; i < 3; i++)
      expect(JSON.parse(await tools.execute('proposeAutomationCreate', input)).status).toBe(
        'confirmation_required',
      );
    expect(prepare).toHaveBeenCalledOnce();
    expect(tools.proposals).toHaveLength(1);
  });
  it('enforces a turn budget across read and proposal tools', async () => {
    const { tools, list } = setup();
    for (let n = 0; n < 6; n++) await tools.execute('listAutomations', {});
    expect(JSON.parse(await tools.execute('listAutomations', {})).status).toBe('budget_exceeded');
    expect(list).toHaveBeenCalledTimes(6);
  });
  it('rejects model-supplied scope overrides before reading', async () => {
    const { tools, list } = setup();
    expect(
      JSON.parse(await tools.execute('listAutomations', { workspaceId: scope.workspaceId })).status,
    ).toBe('invalid');
    expect(list).not.toHaveBeenCalled();
  });
});

it('the installed AI SDK can serialize all automation tool schemas for a provider', async () => {
  const { MockLanguageModelV4 } = await import('ai/test');
  const { simulateReadableStream } = await import('ai');
  const { createGatewayEngine } = await import('../src/ai/engine.js');
  const model = new MockLanguageModelV4({
    doStream: {
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: 'answer' },
          { type: 'text-delta', id: 'answer', delta: 'Ready' },
          { type: 'text-end', id: 'answer' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: undefined },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 1, text: 1, reasoning: undefined },
            },
          },
        ],
      }),
    },
  });
  const { tools } = setup();
  const engine = createGatewayEngine({ apiKey: 'synthetic', modelId: 'synthetic/test' }, model);
  for await (const event of engine.stream({
    system: 'Prepare drafts only',
    messages: [{ role: 'user', text: 'Hello' }],
    tools: tools.definitions,
    automationAuthoring: true,
    signal: new AbortController().signal,
  }))
    expect(event.type).not.toBe('error');
  expect(model.doStreamCalls[0]?.tools).toHaveLength(6);
  expect(model.doStreamCalls[0]?.maxOutputTokens).toBe(4800);
});
