/*
 * A tool result is a JSON string on purpose (it is what the model receives), so
 * these tests parse it and narrow the untyped envelope with assertions. The
 * production modules keep the repository's no-assertion rule.
 */
/* eslint-disable @typescript-eslint/consistent-type-assertions */
import { describe, expect, it, vi } from 'vitest';
import type { SourceReportRow } from '@gt-sales/contracts';

import { TurnBudget } from '../src/ai/limits.js';
import type { LeadRow, TaskRow } from '../src/ai/projections.js';
import type { AiReadService, LeadPage, TaskPage } from '../src/ai/read-service.js';
import type { AiSiteContext } from '../src/ai/site-context.js';
import { SourceRegistry } from '../src/ai/sources.js';
import {
  AssistantAccessRevokedError,
  createAssistantTools,
  type ToolContext,
} from '../src/ai/tools.js';
import type { ReportStore } from '../src/reports/store.js';
import type { StaffAccessSnapshot } from '../src/staff/authorization.js';

const WORKSPACE = '10000000-0000-4000-8000-000000000b71';
const ACTOR = '20000000-0000-4000-8000-000000000b71';
const LEAD = '40000000-0000-4000-8000-000000000b71';
const NOW = new Date('2026-11-02T12:00:00.000Z');

const site: AiSiteContext = {
  siteId: WORKSPACE,
  slug: 'getcanadasim',
  name: 'Get Canada Sim',
  leadTypes: ['sim_order', 'internet'],
};

const owner: StaffAccessSnapshot = {
  membershipId: '30000000-0000-4000-8000-000000000b71',
  status: 'active',
  roles: ['owner'],
  permissions: [],
};

function leadRow(overrides: Partial<LeadRow> = {}): LeadRow {
  return {
    id: LEAD,
    lead_type: 'sim_order',
    stage: 'pending',
    status: 'submitted',
    external_ref: 'MS-TEST-101',
    full_name: 'Ada Lovelace',
    assignee_name: 'Owner',
    created_at: new Date('2026-10-20T12:00:00.000Z'),
    updated_at: new Date('2026-10-21T12:00:00.000Z'),
    deleted_at: null,
    ...overrides,
  };
}

function taskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: '50000000-0000-4000-8000-000000000b71',
    lead_id: LEAD,
    lead_ref: 'MS-TEST-101',
    lead_name: 'Ada Lovelace',
    title: 'Call about permit',
    assignee_name: 'Owner',
    due_at: new Date('2026-11-01T12:00:00.000Z'),
    ...overrides,
  };
}

function fakeReads(overrides: Partial<AiReadService> = {}): AiReadService {
  const emptyPage: LeadPage = { rows: [], total: 0 };
  const emptyTasks: TaskPage = { rows: [], total: 0 };
  return {
    overview: vi.fn(async () => ({ received: 0, submitted: 0, byStage: [] })),
    findLeads: vi.fn(async () => emptyPage),
    leadSummary: vi.fn(async () => undefined),
    openTasks: vi.fn(async () => emptyTasks),
    isActiveMember: async () => true,
    leadHint: vi.fn(async () => undefined),
    ...overrides,
  };
}

function fakeReports(): ReportStore & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    sourceReport: async (input) => {
      calls.push(input);
      const rows: SourceReportRow[] = [
        {
          source: 'utm:google/cpc',
          kind: 'utm',
          received: 10,
          submitted: 6,
          madeIt: 2,
          campaigns: [],
        },
        {
          source: 'Other',
          kind: 'other',
          received: 4,
          submitted: 1,
          madeIt: 0,
          campaigns: [],
        },
      ];
      return { totals: { received: 14, submitted: 7, madeIt: 2 }, rows, withSourceData: 14 };
    },
  };
}

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    scope: { workspaceId: WORKSPACE, actorId: ACTOR },
    site,
    now: NOW,
    budget: new TurnBudget(),
    sources: new SourceRegistry({ workspaceSlug: 'getcanadasim', asOf: NOW }),
    reads: fakeReads(),
    reports: fakeReports(),
    loadAccess: async () => owner,
    ...overrides,
  };
}

const parse = (value: string) => JSON.parse(value) as Record<string, unknown>;

describe('tool catalogue', () => {
  it.each(['sql', 'query', 'table', 'schema', 'workspaceId', 'actorId'])(
    'rejects model-supplied %s arguments before calling a read store',
    async (field) => {
      const reads = fakeReads();
      const toolset = createAssistantTools(context({ reads }));
      await expect(
        toolset.execute('findLeads', { [field]: "'; DROP TABLE app.leads; --" }),
      ).rejects.toThrow();
      expect(reads.findLeads).not.toHaveBeenCalled();
    },
  );

  it('exposes exactly the five version-1 tools', () => {
    const toolset = createAssistantTools(context());
    expect(Object.keys(toolset.definitions).sort()).toEqual([
      'findLeads',
      'getLeadSummary',
      'getSiteOverview',
      'getSourcePerformance',
      'listOpenTasks',
    ]);
  });

  it('rejects an input that names a field outside the schema', async () => {
    const toolset = createAssistantTools(context());
    await expect(
      toolset.execute('getSiteOverview', { leadType: 'sim_order', workspaceId: WORKSPACE }),
    ).rejects.toThrow();
  });
});

describe('getSiteOverview', () => {
  it('discloses the default 30-day window and the site it counted', async () => {
    const toolset = createAssistantTools(
      context({
        reads: fakeReads({
          overview: async () => ({
            received: 12,
            submitted: 7,
            byStage: [{ stage: 'pending', stageLabel: 'pending', count: 9 }],
          }),
        }),
      }),
    );
    const result = parse(await toolset.execute('getSiteOverview', { leadType: 'sim_order' }));
    expect(result['status']).toBe('ok');
    expect(result['total']).toBe(12);
    const scope = result['scope'] as Record<string, unknown>;
    expect(scope['leadType']).toBe('sim_order');
    const window = scope['window'] as Record<string, unknown>;
    expect(window['label']).toBe('the last 30 days');
    expect(window['timezone']).toBe('America/Toronto');
    const data = result['data'] as { received: number; byStage: { stageLabel: string }[] };
    expect(data.received).toBe(12);
    expect(data.byStage[0]?.stageLabel).toBe('Pending');
  });

  it('answers zero for a real lead type this site has no leads of yet', async () => {
    const toolset = createAssistantTools(context());
    const result = parse(await toolset.execute('getSiteOverview', { leadType: 'mobility' }));
    // Mobility is a type this CRM knows; a site with none yet has zero, and
    // saying "unknown type" would turn a real zero into a missing answer.
    expect(result['status']).toBe('ok');
    expect(result['total']).toBe(0);
  });

  it('answers invalid_filter for a type the catalogue does not know', async () => {
    const toolset = createAssistantTools(context());
    const result = parse(await toolset.execute('getSiteOverview', { leadType: 'nonsense' }));
    expect(result['status']).toBe('invalid_filter');
    expect(result['data']).toBeUndefined();
    expect(String(result['message'])).toContain('sim_order');
  });

  it('sums the site’s own types for a site-wide question', async () => {
    const reads = fakeReads({
      overview: vi.fn(async (_scope, query) => ({
        received: query.leadType === 'sim_order' ? 5 : 3,
        submitted: 0,
        byStage: [],
      })),
    });
    const toolset = createAssistantTools(context({ reads }));
    const result = parse(await toolset.execute('getSiteOverview', {}));
    expect(result['total']).toBe(8);
    expect(reads.overview).toHaveBeenCalledTimes(2);
  });
});

describe('findLeads', () => {
  it('projects only allowed fields and registers a site-relative source', async () => {
    const reads = fakeReads({
      findLeads: async () => ({ rows: [leadRow()], total: 1 }),
    });
    const toolset = createAssistantTools(context({ reads }));
    const result = parse(await toolset.execute('findLeads', { search: 'Ada' }));
    const data = result['data'] as { leads: Record<string, unknown>[] };
    const lead = data.leads[0]!;
    expect(Object.keys(lead).sort()).toEqual([
      'archived',
      'assignee',
      'createdAt',
      'leadId',
      'leadType',
      'leadTypeLabel',
      'name',
      'reference',
      'stage',
      'stageLabel',
      'status',
      'updatedAt',
    ]);
    expect(lead).not.toHaveProperty('email');
    expect(lead).not.toHaveProperty('phone');
    const sources = result['sources'] as { href: string }[];
    expect(sources[0]?.href).toBe(`/w/getcanadasim/leads/${LEAD}`);
  });

  it('marks truncation without changing the exact total', async () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      leadRow({ id: `40000000-0000-4000-8000-0000000000${String(index).padStart(2, '0')}` }),
    );
    const reads = fakeReads({ findLeads: async () => ({ rows, total: 240 }) });
    const toolset = createAssistantTools(context({ reads }));
    const result = parse(await toolset.execute('findLeads', { leadType: 'sim_order' }));
    expect(result['total']).toBe(240);
    expect(result['hasMore']).toBe(true);
  });

  it('answers invalid_filter for a stage that does not belong to the type', async () => {
    const toolset = createAssistantTools(context());
    const result = parse(
      await toolset.execute('findLeads', { leadType: 'sim_order', stage: 'won' }),
    );
    expect(result['status']).toBe('invalid_filter');
  });

  it('requests the archive only when the question asks for it', async () => {
    const reads = fakeReads();
    const toolset = createAssistantTools(context({ reads }));
    await toolset.execute('findLeads', { archived: true });
    expect(reads.findLeads).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ archived: true }),
    );
    await toolset.execute('findLeads', {});
    expect(reads.findLeads).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.not.objectContaining({ archived: true }),
    );
  });
});

describe('getLeadSummary', () => {
  it('gives the same neutral answer for an unknown, foreign or restricted lead', async () => {
    const toolset = createAssistantTools(
      context({ reads: fakeReads({ leadSummary: async () => undefined }) }),
    );
    const result = parse(await toolset.execute('getLeadSummary', { leadId: LEAD }));
    expect(result['status']).toBe('not_available');
    expect(result['sources']).toEqual([]);
  });

  it('includes notes only when the notes section was requested', async () => {
    const summary = {
      lead: leadRow(),
      openTasks: [taskRow()],
      activity: [
        {
          kind: 'note',
          at: NOW,
          body: 'A note in the recent-activity list never becomes an excerpt.',
        },
        { kind: 'status_change', at: NOW, body: null },
      ],
      notes: [{ kind: 'note', at: NOW, body: 'Customer asked for a callback.' }],
    };
    const withoutNotes = createAssistantTools(
      context({ reads: fakeReads({ leadSummary: async () => summary }) }),
    );
    const plain = parse(await withoutNotes.execute('getLeadSummary', { leadId: LEAD }));
    const plainActivity = (plain['data'] as { recentActivity: Record<string, unknown>[] })
      .recentActivity;
    expect(plainActivity.some((entry) => 'noteExcerpt' in entry)).toBe(false);

    const withNotes = createAssistantTools(
      context({ reads: fakeReads({ leadSummary: async () => summary }) }),
    );
    const noted = parse(
      await withNotes.execute('getLeadSummary', { leadId: LEAD, sections: ['notes'] }),
    );
    const notedActivity = (noted['data'] as { recentActivity: Record<string, unknown>[] })
      .recentActivity;
    expect(notedActivity.find((entry) => 'noteExcerpt' in entry)?.['noteExcerpt']).toBe(
      'Customer asked for a callback.',
    );
  });

  it('stops after three lead summaries in one turn', async () => {
    const summary = { lead: leadRow(), openTasks: [], activity: [], notes: [] };
    const toolset = createAssistantTools(
      context({ reads: fakeReads({ leadSummary: async () => summary }) }),
    );
    const three = [1, 2, 3].map(
      (n) => `40000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`,
    );
    for (const leadId of three) {
      expect(parse(await toolset.execute('getLeadSummary', { leadId }))['status']).toBe('ok');
    }
    const fourth = parse(
      await toolset.execute('getLeadSummary', { leadId: '40000000-0000-4000-8000-000000000004' }),
    );
    expect(fourth['status']).toBe('not_available');
    expect(String(fourth['message'])).toContain('maximum number of leads');
  });
});

describe('listOpenTasks', () => {
  it('filters "due today or earlier" against the next UTC midnight of the Toronto day', async () => {
    const reads = fakeReads({ openTasks: vi.fn(async () => ({ rows: [taskRow()], total: 1 })) });
    const toolset = createAssistantTools(context({ reads }));
    const result = parse(await toolset.execute('listOpenTasks', {}));
    expect(reads.openTasks).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        due: expect.objectContaining({ before: new Date('2026-11-03T00:00:00.000Z') }),
      }),
    );
    const data = result['data'] as { tasks: { dueDay: string }[] };
    expect(data.tasks[0]?.dueDay).toBe('2026-11-01');
  });
});

describe('getSourcePerformance', () => {
  it('preserves the report’s Other row and says the rows are aggregated', async () => {
    const toolset = createAssistantTools(context());
    const result = parse(await toolset.execute('getSourcePerformance', { leadType: 'sim_order' }));
    const data = result['data'] as {
      rows: { source: string; other: boolean }[];
      aggregatedOther: boolean;
      sourcesShown: number;
    };
    expect(data.aggregatedOther).toBe(true);
    expect(data.rows.at(-1)?.source).toBe('Other');
    expect(data.sourcesShown).toBe(1);
    expect(result['total']).toBe(14);
  });

  it('refuses a lead type the catalogue does not know', async () => {
    const toolset = createAssistantTools(context());
    const result = parse(await toolset.execute('getSourcePerformance', { leadType: 'nonsense' }));
    expect(result['status']).toBe('invalid_filter');
  });
});

describe('turn budgets and access', () => {
  it('refuses the seventh tool call in one turn', async () => {
    const toolset = createAssistantTools(context());
    const distinct: Record<string, unknown>[] = [
      { page: 1 },
      { page: 2 },
      { page: 3 },
      { page: 4 },
      { page: 5 },
      { search: 'Ada' },
    ];
    for (const input of distinct) {
      expect(parse(await toolset.execute('findLeads', input))['status']).toBe('ok');
    }
    const seventh = parse(await toolset.execute('findLeads', { search: 'Grace' }));
    expect(seventh['status']).toBe('not_available');
    expect(String(seventh['message'])).toContain('tool budget');
  });

  it('serves an identical repeat inside one turn without a second database read', async () => {
    const reads = fakeReads();
    const toolset = createAssistantTools(context({ reads }));
    await toolset.execute('findLeads', { search: 'Ada' });
    await toolset.execute('findLeads', { search: 'Ada' });
    expect(reads.findLeads).toHaveBeenCalledTimes(1);
  });

  it('aborts the turn when the membership is revoked mid-turn', async () => {
    const revoked: StaffAccessSnapshot = {
      membershipId: owner.membershipId,
      status: 'revoked',
      roles: ['owner'],
      permissions: [],
    };
    const toolset = createAssistantTools(context({ loadAccess: async () => revoked }));
    await expect(toolset.execute('findLeads', {})).rejects.toBeInstanceOf(
      AssistantAccessRevokedError,
    );
  });

  it('turns a read failure into temporary evidence, never a zero', async () => {
    const toolset = createAssistantTools(
      context({
        reads: fakeReads({
          overview: async () => {
            throw new Error('connection reset');
          },
        }),
      }),
    );
    const result = parse(await toolset.execute('getSiteOverview', { leadType: 'sim_order' }));
    expect(result['status']).toBe('temporary_failure');
    expect(result['data']).toBeUndefined();
  });

  it('charges records against the turn, not against a single page', async () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      leadRow({ id: `40000000-0000-4000-8000-0000000001${String(index).padStart(2, '0')}` }),
    );
    const budget = new TurnBudget();
    const toolset = createAssistantTools(
      context({ budget, reads: fakeReads({ findLeads: async () => ({ rows, total: 10 }) }) }),
    );
    for (let page = 0; page < 5; page += 1) await toolset.execute('findLeads', { page: page + 1 });
    expect(budget.usage.records).toBeGreaterThanOrEqual(30);
    expect(budget.usage.records).toBeLessThanOrEqual(50);
  });
});

describe('review regressions', () => {
  it('validates the assignee against the selected site before searching', async () => {
    const reads = fakeReads({ isActiveMember: async () => false });
    const tools = createAssistantTools(context({ reads }));
    expect(parse(await tools.execute('findLeads', { assignee: ACTOR }))['status']).toBe(
      'invalid_filter',
    );
    expect(reads.findLeads).not.toHaveBeenCalled();
  });

  it('rejects prototype property names as lead types', async () => {
    const tools = createAssistantTools(context());
    expect(
      parse(await tools.execute('getSiteOverview', { leadType: 'constructor' }))['status'],
    ).toBe('invalid_filter');
  });

  it('never sends a single oversized row beyond the per-result budget', async () => {
    const tools = createAssistantTools(
      context({
        reads: fakeReads({
          findLeads: async () => ({ rows: [leadRow({ full_name: 'x'.repeat(20000) })], total: 1 }),
        }),
      }),
    );
    const result = await tools.execute('findLeads', {});
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(6 * 1024);
    expect(parse(result)['truncated']).toBe(true);
    expect(parse(result)['total']).toBe(1);
  });

  it('bounds nested summary records and serializes only what it charges', async () => {
    const budget = new TurnBudget();
    const tools = createAssistantTools(
      context({
        budget,
        reads: fakeReads({
          leadSummary: async () => ({
            lead: leadRow(),
            openTasks: [],
            activity: [],
            notes: Array.from({ length: 5 }, () => ({
              kind: 'note',
              at: NOW,
              body: '😀'.repeat(500),
            })),
          }),
        }),
      }),
    );
    const result = await tools.execute('getLeadSummary', { leadId: LEAD, sections: ['notes'] });
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(6 * 1024);
    expect(budget.usage.dataBytes).toBe(Buffer.byteLength(result));
  });
});
