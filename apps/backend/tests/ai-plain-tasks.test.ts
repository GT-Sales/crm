import { describe, expect, it } from 'vitest';

import { createActionProposalTools } from '../src/ai/actions.js';
import { crmGuideIndex, readCrmGuide } from '../src/ai/crm-guide.js';
import { TurnBudget } from '../src/ai/limits.js';
import { AI_PROMPT_VERSION, buildSystemPrompt } from '../src/ai/prompt.js';
import type { AiReadService } from '../src/ai/read-service.js';
import { assertAssistantToolPolicy } from '../src/ai/tool-policy.js';
import { toolInputSchemas } from '../src/ai/tools.js';

const scope = {
  workspaceId: '10000000-0000-4000-8000-000000003811',
  actorId: '20000000-0000-4000-8000-000000003811',
};

const prompt = (plainTasksAvailable: boolean) =>
  buildSystemPrompt({
    siteName: 'Get Canada Sim',
    leadTypes: ['sim_order'],
    today: '2026-11-19',
    timeZone: 'America/Toronto',
    actionsAvailable: true,
    plainTasksAvailable,
  });

function tools(plainTasks: boolean) {
  const reads: AiReadService = {
    isActiveMember: async () => true,
    overview: async () => ({ received: 0, submitted: 0, byStage: [] }),
    findLeads: async () => ({ rows: [], total: 0 }),
    leadSummary: async () => undefined,
    openTasks: async () => ({ rows: [], total: 0 }),
    leadHint: async () => undefined,
  };
  return createActionProposalTools({
    scope,
    site: { name: 'Get Canada Sim', slug: 'getcanadasim' },
    key: 'synthetic-signing-key',
    reads,
    plainTasks,
    taskUpdatePreview: async () => undefined,
    loadAccess: async () => ({
      membershipId: scope.actorId,
      status: 'active',
      roles: ['owner'],
      permissions: [],
    }),
    now: () => new Date('2026-11-19T12:00:00Z'),
    budget: new TurnBudget(),
  });
}

describe('Ask AI no longer insists that a task has a lead', () => {
  it('drops the instruction that made it ask which lead a task is for', () => {
    expect(AI_PROMPT_VERSION).toBe(15);
    const system = prompt(true);
    // The old rule sent every task through "resolve the exact lead" first.
    expect(system).not.toContain(
      'Resolve the exact lead with fresh read tools; clarify ambiguous matches or missing content/dates before preparing.',
    );
    expect(system).toContain('plain task');
    expect(system).toContain('Never refuse a task because it has no lead');
    expect(system).toContain('prepareTaskUpdate');
  });

  it('asks for a lead, once, only while the database cannot hold a plain task', () => {
    expect(prompt(false)).toContain('Every task needs a lead on this site for now');
    expect(prompt(true)).not.toContain('Every task needs a lead on this site for now');
  });

  it('describes the task tool without "for an identified lead" and takes an explicit null lead', async () => {
    const toolset = tools(true);
    const prepareTask = toolset.definitions['prepareTask'];
    expect(prepareTask?.description).not.toContain('for an identified lead');
    expect(prepareTask?.description).toContain('leadId null');
    const base = { title: 'Call the supplier', dueDate: null, assignee: 'me' };
    // The key is required: a model must say "no lead" (null), never forget one.
    expect(() => toolset.execute('prepareTask', base)).toThrow();
    expect(JSON.parse(await toolset.execute('prepareTask', { ...base, leadId: null })).status).toBe(
      'confirmation_required',
    );
    expect(toolset.definitions['prepareTaskUpdate']?.description).toContain('stage');
  });

  it('refuses a plain task, asking for a lead, before migration 0038', async () => {
    const result = JSON.parse(
      await tools(false).execute('prepareTask', {
        leadId: null,
        title: 'Too early',
        dueDate: null,
        assignee: 'me',
      }),
    );
    expect(result.status).toBe('not_available');
    expect(result.message).toContain('Ask the person which lead');
  });

  it('allows the move tool by policy and lists tasks by stage', () => {
    expect(() => assertAssistantToolPolicy(tools(true).definitions)).not.toThrow();
    expect(toolInputSchemas.listOpenTasks.safeParse({ status: 'in_progress' }).success).toBe(true);
    expect(toolInputSchemas.listOpenTasks.safeParse({ status: 'waiting' }).success).toBe(false);
  });

  it('teaches the New task control and Ask AI’s plain tasks and moves in the CRM guide', () => {
    const guide = readCrmGuide({ topics: ['tasks', 'ask-ai'] });
    expect(guide).toContain('New task');
    expect(guide).toContain('No lead');
    expect(guide).toContain('move a task');
    expect(crmGuideIndex()).not.toContain('Creating follow-up tasks on a lead, completing them');
  });
});
