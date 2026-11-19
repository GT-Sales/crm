import { describe, expect, it } from 'vitest';

import { TurnBudget } from '../src/ai/limits.js';
import type { AiReadService } from '../src/ai/read-service.js';
import { SourceRegistry } from '../src/ai/sources.js';
import { createAssistantTools, toolInputSchemas } from '../src/ai/tools.js';

const SITE = '10000000-0000-4000-8000-000000003812';
const ACTOR = '20000000-0000-4000-8000-000000003812';
const NOW = new Date('2026-11-19T12:00:00Z');

describe('listOpenTasks takes a short title filter', () => {
  it('accepts 1–100 characters and refuses an empty or a longer one', () => {
    const schema = toolInputSchemas.listOpenTasks;
    expect(schema.safeParse({ titleContains: 'supplier' }).success).toBe(true);
    expect(schema.safeParse({ titleContains: 'x'.repeat(100) }).success).toBe(true);
    expect(schema.safeParse({ titleContains: '' }).success).toBe(false);
    expect(schema.safeParse({ titleContains: '   ' }).success).toBe(false);
    expect(schema.safeParse({ titleContains: 'x'.repeat(101) }).success).toBe(false);
  });

  it('tells the model to find a task by a few words of its title before moving it', () => {
    const unused = () => Promise.reject(new Error('unused'));
    const reads: AiReadService = {
      isActiveMember: unused,
      overview: unused,
      findLeads: unused,
      leadSummary: unused,
      openTasks: unused,
      leadHint: unused,
    };
    const toolset = createAssistantTools({
      scope: { workspaceId: SITE, actorId: ACTOR },
      site: { siteId: SITE, slug: 'site', name: 'Site', leadTypes: [] },
      now: NOW,
      budget: new TurnBudget(),
      sources: new SourceRegistry({ workspaceSlug: 'site', asOf: NOW }),
      reads,
      reports: { sourceReport: unused },
      loadAccess: unused,
    });
    expect(toolset.definitions['listOpenTasks']?.description).toContain('titleContains');
  });
});
