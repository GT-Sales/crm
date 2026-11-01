import {
  AI_ASSISTANT_LIMITS,
  aiPeriodSchema,
  isLeadStage,
  leadStageLabel,
  leadTypeCatalog,
  type AiPeriod,
} from '@gt-sales/contracts';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

import type { ReportStore } from '../reports/store.js';
import type { Scope } from '../tenant-scope.js';
import { decideAiAccess } from '../routes/ai-assistant.js';
import { decideAccess, type StaffAccessSnapshot } from '../staff/authorization.js';
import { TurnBudget } from './limits.js';
import {
  activityKindWords,
  noteExcerpt,
  projectLead,
  projectTask,
  serializedBytes,
  type ActivityProjection,
  type FindLeadsData,
  type LeadSummaryData,
  type OpenTasksData,
  type OverviewData,
  type SourcePerformanceData,
  type OverviewStageCount,
  type ToolResult,
  type ToolScope,
} from './projections.js';
import type { AiReadService } from './read-service.js';
import type { AiSiteContext } from './site-context.js';
import type { SourceRegistry } from './sources.js';
import {
  AI_DEFAULT_PERIOD,
  resolvePeriod,
  resolveTaskDueWindow,
  type ResolvedWindow,
  type TaskDueFilter,
} from './windows.js';

/**
 * The version-1 tool catalogue: five read-only tools, each with a strict input
 * schema, an explicit projection and a hard budget.
 *
 * The model sees only the argument schema — never a site id, an actor id, a
 * role, a table name or a URL. Site and actor come from the server-side closure
 * this module is built with. Every execution re-reads the caller's membership
 * first, because a session can lose a role between two tool calls of one turn.
 */

/** Thrown when access is revoked mid-turn: the route stops and clears the chat. */
export class AssistantAccessRevokedError extends Error {
  constructor() {
    super('assistant access revoked');
    this.name = 'AssistantAccessRevokedError';
  }
}

export const TOOL_NAMES = [
  'getSiteOverview',
  'findLeads',
  'getLeadSummary',
  'listOpenTasks',
  'getSourcePerformance',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/** The model's whole tool input vocabulary; no field can widen the scope. */
export const toolInputSchemas = {
  getSiteOverview: z
    .object({
      leadType: z.string().min(1).max(64).optional(),
      period: aiPeriodSchema.optional(),
    })
    .strict(),
  findLeads: z
    .object({
      search: z.string().trim().min(1).max(120).optional(),
      leadType: z.string().min(1).max(64).optional(),
      stage: z.string().min(1).max(64).optional(),
      assignee: z.union([z.enum(['me', 'none']), z.uuid()]).optional(),
      archived: z.boolean().optional(),
      page: z.int().min(1).max(5).optional(),
    })
    .strict(),
  getLeadSummary: z
    .object({
      leadId: z.uuid(),
      sections: z
        .array(z.enum(['tasks', 'activity', 'notes']))
        .max(3)
        .optional(),
    })
    .strict(),
  listOpenTasks: z
    .object({
      assignee: z.union([z.enum(['me', 'all', 'none']), z.uuid()]).optional(),
      due: z.enum(['any', 'overdue', 'due_today', 'due_today_or_earlier']).optional(),
      page: z.int().min(1).max(5).optional(),
    })
    .strict(),
  getSourcePerformance: z
    .object({
      leadType: z.string().min(1).max(64),
      days: z.union([z.literal(7), z.literal(30), z.literal(90)]).optional(),
    })
    .strict(),
} as const;

const FIND_LEADS_PAGE_SIZE = 10;
const TASKS_PAGE_SIZE = 20;

export interface ToolContext {
  readonly scope: Scope;
  readonly site: AiSiteContext;
  readonly now: Date;
  readonly budget: TurnBudget;
  readonly sources: SourceRegistry;
  readonly reads: AiReadService;
  readonly reports: ReportStore;
  /** The live membership read used again before every tool executes. */
  readonly loadAccess: () => Promise<StaffAccessSnapshot | undefined>;
  /**
   * Called when a tool finds the membership gone: the route aborts the model
   * loop at once instead of letting it write the rest of an answer nobody may
   * receive. The throw below remains the tools' own stop signal.
   */
  readonly onAccessRevoked?: () => void;
}

export interface AssistantToolset {
  readonly definitions: ToolSet;
  execute(name: ToolName, input: unknown, options?: { signal?: AbortSignal }): Promise<string>;
}

function scopeOf(
  context: ToolContext,
  input: {
    leadType?: string | null;
    window: ResolvedWindow | null;
    archivePolicy?: ToolScope['archivePolicy'];
    filters?: Record<string, string | readonly string[]>;
  },
): ToolScope {
  return {
    siteId: context.site.siteId,
    siteName: context.site.name,
    leadType: input.leadType ?? null,
    archivePolicy: input.archivePolicy ?? 'active_only',
    window:
      input.window === null
        ? null
        : {
            start: input.window.start.toISOString(),
            end: input.window.end.toISOString(),
            timezone: input.window.timezone,
            label: input.window.label,
          },
    filters: input.filters ?? {},
  };
}

function unavailable<T>(scope: ToolScope, asOf: string, message: string): ToolResult<T> {
  return { status: 'not_available', asOf, scope, sources: [], message };
}

/** The catalogue's own words for a stage, so a filter never invents one. */
function stageLabelOf(leadType: string | undefined, stage: string): string {
  return leadType === undefined ? stage : leadStageLabel(leadType, stage);
}

/**
 * A lead type is valid when the catalogue knows it. Whether this site has any
 * leads of that type is a counting question, not a validation one: a site that
 * sells mobility but has none yet must answer "0", not "unknown type".
 */
function validLeadType(value: string | undefined): boolean {
  return value === undefined || value in leadTypeCatalog;
}

export function createAssistantTools(context: ToolContext): AssistantToolset {
  const asOf = () => context.now.toISOString();

  async function reauthorize(): Promise<void> {
    const access = await context.loadAccess();
    const decision = decideAiAccess(access);
    if (!decision.allowed) {
      context.onAccessRevoked?.();
      throw new AssistantAccessRevokedError();
    }
  }

  /**
   * Serializes a result, trims whole rows until it fits the per-result budget,
   * then charges the turn budget. Totals never change under truncation: only
   * the row list shrinks, and `truncated`/`returnedCount` say so.
   *
   * `countRecords` states how many records a kept result really is (nested
   * task/note/activity items count); it defaults to the row list's length.
   */
  function finish<T, TRow>(
    result: Omit<ToolResult<T>, 'data'>,
    rows: readonly TRow[],
    build: (kept: readonly TRow[]) => T,
    countRecords: (kept: readonly TRow[]) => number = (kept) => kept.length,
  ): string {
    let kept = [...rows];
    let candidate: ToolResult<T> = { ...result, data: build(kept) };
    while (serializedBytes(candidate) > AI_ASSISTANT_LIMITS.maxToolResultBytes && kept.length > 1) {
      kept = kept.slice(0, Math.max(1, Math.floor(kept.length / 2)));
      candidate = {
        ...result,
        data: build(kept),
        truncated: true,
        returnedCount: countRecords(kept),
      };
    }
    const acceptance = context.budget.acceptResult({
      bytes: serializedBytes(candidate),
      records: countRecords(kept),
    });
    if (acceptance.rejected) {
      return JSON.stringify(
        unavailable<T>(
          result.scope,
          result.asOf,
          'The answer would exceed this turn’s data budget. Ask a narrower question.',
        ),
      );
    }
    if (acceptance.truncated && countRecords(kept) > acceptance.allowedRecords) {
      // A result whose records are nested (one lead plus its tasks and notes)
      // cannot be shrunk by dropping rows; better a clear refusal than an
      // answer that silently exceeds the budget.
      if (kept.length <= 1) {
        return JSON.stringify(
          unavailable<T>(
            result.scope,
            result.asOf,
            'This answer is larger than the remaining budget for one question. Ask something narrower.',
          ),
        );
      }
      kept = kept.slice(0, Math.max(acceptance.allowedRecords, 1));
      candidate = {
        ...result,
        data: build(kept),
        truncated: true,
        returnedCount: countRecords(kept),
      };
    }
    return JSON.stringify(candidate);
  }

  async function getSiteOverview(input: z.infer<(typeof toolInputSchemas)['getSiteOverview']>) {
    await reauthorize();
    const period: AiPeriod = input.period ?? AI_DEFAULT_PERIOD;
    const window = resolvePeriod(period, context.now);
    const scope = scopeOf(context, {
      leadType: input.leadType ?? null,
      window,
      filters: { period },
    });

    if (input.leadType === undefined) {
      // A site-wide count is allowed, but only over the types this site holds.
      const totals = await overviewForAllTypes(context, window);
      if (!totals) {
        return JSON.stringify(
          unavailable<OverviewData>(scope, asOf(), 'Lead counts could not be read.'),
        );
      }
      const data: OverviewData = {
        received: totals.received,
        submitted: totals.submitted,
        byStage: totals.byStage,
      };
      context.sources.leadsInbox(
        `${context.site.name} · all lead types · ${window.label} · drafts included, archived and restricted excluded`,
      );
      return finish(
        {
          status: 'ok',
          asOf: asOf(),
          scope,
          total: data.received,
          returnedCount: data.byStage.length,
          sources: context.sources.list(),
        },
        data.byStage,
        (kept) => ({ ...data, byStage: kept }),
      );
    }

    if (!validLeadType(input.leadType)) {
      return JSON.stringify(
        invalidFilter<OverviewData>(
          scope,
          asOf(),
          `"${input.leadType ?? ''}" is not a lead type in this CRM. This site's types are: ${context.site.leadTypes.join(', ')}.`,
        ),
      );
    }

    const leadType = input.leadType;
    let totals;
    try {
      totals = await context.reads.overview(context.scope, { leadType, window });
    } catch {
      return JSON.stringify(
        unavailable<OverviewData>(scope, asOf(), 'Lead counts could not be read just now.'),
      );
    }
    const data: OverviewData = {
      received: totals.received,
      submitted: totals.submitted,
      byStage: totals.byStage.map((entry) => ({
        ...entry,
        stageLabel: stageLabelOf(leadType, entry.stage),
      })),
    };
    context.sources.leadsInbox(
      `${context.site.name} · ${leadType} · ${window.label} · drafts included, archived and restricted excluded`,
    );
    return finish(
      {
        status: 'ok',
        asOf: asOf(),
        scope,
        total: data.received,
        returnedCount: data.byStage.length,
        sources: context.sources.list(),
      },
      data.byStage,
      (kept) => ({ ...data, byStage: kept }),
    );
  }

  async function overviewForAllTypes(
    context: ToolContext,
    window: ResolvedWindow,
  ): Promise<{ received: number; submitted: number; byStage: OverviewStageCount[] } | undefined> {
    // Sum the site's own types one by one: the catalogue stays the source of
    // truth for which types exist, and each read stays a bounded query.
    const byStage: OverviewStageCount[] = [];
    let received = 0;
    let submitted = 0;
    for (const leadType of context.site.leadTypes) {
      try {
        const totals = await context.reads.overview(context.scope, { leadType, window });
        received += totals.received;
        submitted += totals.submitted;
        for (const entry of totals.byStage) {
          byStage.push({ ...entry, stageLabel: stageLabelOf(leadType, entry.stage) });
        }
      } catch {
        return undefined;
      }
    }
    byStage.sort((a, b) => b.count - a.count);
    return { received, submitted, byStage };
  }

  async function findLeads(input: z.infer<(typeof toolInputSchemas)['findLeads']>) {
    await reauthorize();
    const page = input.page ?? 1;
    const scope = scopeOf(context, {
      leadType: input.leadType ?? null,
      window: null,
      archivePolicy: input.archived === true ? 'including_archived' : 'active_only',
      filters: {
        ...(input.search === undefined ? {} : { search: 'provided' }),
        ...(input.stage === undefined ? {} : { stage: input.stage }),
        ...(input.assignee === undefined ? {} : { assignee: input.assignee }),
      },
    });
    if (!validLeadType(input.leadType)) {
      return JSON.stringify(
        invalidFilter<FindLeadsData>(
          scope,
          asOf(),
          `"${input.leadType ?? ''}" is not a lead type in this CRM. This site's types are: ${context.site.leadTypes.join(', ')}.`,
        ),
      );
    }
    const stage = input.stage;
    if (
      stage !== undefined &&
      (input.leadType === undefined
        ? !Object.keys(leadTypeCatalog).some((type) => isLeadStage(type, stage))
        : !isLeadStage(input.leadType, stage))
    ) {
      return JSON.stringify(
        invalidFilter<FindLeadsData>(
          scope,
          asOf(),
          `“${input.stage}” is not a stage of this lead type.`,
        ),
      );
    }

    let result;
    try {
      result = await context.reads.findLeads(context.scope, {
        ...(input.search === undefined ? {} : { search: input.search }),
        ...(input.leadType === undefined ? {} : { leadType: input.leadType }),
        ...(input.stage === undefined ? {} : { stage: input.stage }),
        ...(input.assignee === undefined ? {} : { assignee: input.assignee }),
        ...(input.archived === undefined ? {} : { archived: input.archived }),
        limit: FIND_LEADS_PAGE_SIZE,
        offset: (page - 1) * FIND_LEADS_PAGE_SIZE,
      });
    } catch {
      return JSON.stringify(
        unavailable<FindLeadsData>(scope, asOf(), 'Leads could not be searched just now.'),
      );
    }

    const leads = result.rows.map(projectLead);
    for (const lead of leads) {
      context.sources.lead(
        lead.leadId,
        lead.reference ?? lead.name ?? 'Lead',
        `${context.site.name} · ${lead.leadTypeLabel} · ${lead.stageLabel}`,
      );
    }
    const hasMore = page < 5 && result.total > page * FIND_LEADS_PAGE_SIZE;
    return finish(
      {
        status: 'ok',
        asOf: asOf(),
        scope,
        total: result.total,
        returnedCount: leads.length,
        hasMore,
        sources: context.sources.list(),
      },
      leads,
      (kept) => ({ leads: kept }),
    );
  }

  async function getLeadSummary(input: z.infer<(typeof toolInputSchemas)['getLeadSummary']>) {
    await reauthorize();
    const sections = new Set(input.sections ?? ['tasks', 'activity']);
    const scope = scopeOf(context, { window: null, filters: { leadId: input.leadId } });
    if (!context.budget.reserveLeadSummary()) {
      return JSON.stringify(
        unavailable<LeadSummaryData>(
          scope,
          asOf(),
          'This turn has already summarized the maximum number of leads. Ask about one of them instead.',
        ),
      );
    }

    let summary;
    try {
      summary = await context.reads.leadSummary(context.scope, {
        leadId: input.leadId,
        ...(sections.has('notes') ? { includeNotes: true } : {}),
      });
    } catch {
      return JSON.stringify(
        unavailable<LeadSummaryData>(scope, asOf(), 'That lead could not be read just now.'),
      );
    }
    if (!summary) {
      // The same neutral answer for unknown, other-site and restricted leads.
      return JSON.stringify(
        unavailable<LeadSummaryData>(
          scope,
          asOf(),
          'No lead with that id is available in this site.',
        ),
      );
    }

    const lead = projectLead(summary.lead);
    const openTasks = sections.has('tasks') ? summary.openTasks.map(projectTask) : [];
    const recentActivity: ActivityProjection[] = [];
    if (sections.has('activity') || sections.has('notes')) {
      for (const entry of summary.activity) {
        // Notes are carried by the separate, bounded notes read below, so a
        // lead whose last activities were status changes still shows its notes.
        if (entry.kind === 'note') continue;
        recentActivity.push({
          kind: activityKindWords(entry.kind),
          at: entry.at.toISOString(),
        });
      }
    }
    if (sections.has('notes')) {
      for (const note of summary.notes) {
        const excerpt = noteExcerpt(note.body);
        if (excerpt === null) continue;
        recentActivity.push({
          kind: 'note',
          at: note.at.toISOString(),
          noteExcerpt: excerpt,
        });
      }
    }

    context.sources.lead(
      lead.leadId,
      lead.reference ?? lead.name ?? 'Lead',
      `${context.site.name} · ${lead.leadTypeLabel} · ${lead.stageLabel}`,
    );
    const data: LeadSummaryData = { lead, openTasks, recentActivity };
    const countRecords = () => 1 + openTasks.length + recentActivity.length;
    return finish(
      {
        status: 'ok',
        asOf: asOf(),
        scope,
        total: 1,
        returnedCount: countRecords(),
        sources: context.sources.list(),
      },
      [data],
      () => data,
      countRecords,
    );
  }

  async function listOpenTasks(input: z.infer<(typeof toolInputSchemas)['listOpenTasks']>) {
    await reauthorize();
    const page = input.page ?? 1;
    const dueFilter: TaskDueFilter = input.due ?? 'due_today_or_earlier';
    const due = resolveTaskDueWindow(dueFilter, context.now);
    const assignee = input.assignee ?? 'all';
    const scope = scopeOf(context, {
      window: null,
      filters: {
        due: dueFilter,
        dueLabel: due.label,
        assignee,
      },
    });

    let result;
    try {
      result = await context.reads.openTasks(context.scope, {
        assignee,
        due,
        limit: TASKS_PAGE_SIZE,
        offset: (page - 1) * TASKS_PAGE_SIZE,
      });
    } catch {
      return JSON.stringify(
        unavailable<OpenTasksData>(scope, asOf(), 'Follow-ups could not be read just now.'),
      );
    }

    const tasks = result.rows.map(projectTask);
    context.sources.tasks(`${context.site.name} · open follow-ups · ${due.label}`);
    const hasMore = page < 5 && result.total > page * TASKS_PAGE_SIZE;
    return finish(
      {
        status: 'ok',
        asOf: asOf(),
        scope,
        total: result.total,
        returnedCount: tasks.length,
        hasMore,
        sources: context.sources.list(),
      },
      tasks,
      (kept) => ({ tasks: kept }),
    );
  }

  async function getSourcePerformance(
    input: z.infer<(typeof toolInputSchemas)['getSourcePerformance']>,
  ) {
    await reauthorize();
    // A day window is a rolling one, exactly as the report runs it; the scope
    // states the instants it covers so the card can too.
    const window =
      input.days === undefined
        ? resolvePeriod('all_time', context.now)
        : resolvePeriod(
            input.days === 7 ? 'last_7_days' : input.days === 30 ? 'last_30_days' : 'last_90_days',
            context.now,
          );
    const scope = scopeOf(context, {
      leadType: input.leadType,
      window,
      filters: { days: input.days === undefined ? 'all_time' : String(input.days) },
    });
    if (!validLeadType(input.leadType)) {
      return JSON.stringify(
        invalidFilter<SourcePerformanceData>(
          scope,
          asOf(),
          `"${input.leadType ?? ''}" is not a lead type in this CRM. This site's types are: ${context.site.leadTypes.join(', ')}.`,
        ),
      );
    }

    let report;
    try {
      report = await context.reports.sourceReport({
        workspaceId: context.scope.workspaceId,
        actorId: context.scope.actorId,
        leadType: input.leadType,
        ...(input.days === undefined ? {} : { days: input.days }),
      });
    } catch {
      return JSON.stringify(
        unavailable<SourcePerformanceData>(
          scope,
          asOf(),
          'The source report could not be read just now.',
        ),
      );
    }

    const rows = report.rows.map((row) => ({
      source: row.source,
      kind: row.kind,
      received: row.received,
      submitted: row.submitted,
      madeIt: row.madeIt,
      other: row.kind === 'other',
    }));
    context.sources.sourceReport(
      'Reports → Sources',
      `${context.site.name} · ${input.leadType} · ${input.days === undefined ? 'all time' : `last ${input.days} days`}`,
    );
    const data: SourcePerformanceData = {
      totals: report.totals,
      rows,
      withSourceData: report.withSourceData,
      sourcesShown: rows.filter((row) => !row.other).length,
      aggregatedOther: rows.some((row) => row.other),
    };
    return finish(
      {
        status: 'ok',
        asOf: asOf(),
        scope,
        total: report.totals.received,
        returnedCount: rows.length,
        sources: context.sources.list(),
      },
      rows,
      (kept) => {
        // The report's Other row is an aggregate of sources that are not shown
        // individually; dropping it would leave rows that cannot reconcile with
        // `totals`, so it always survives truncation.
        const keptIds = new Set(kept.map((row) => row.source));
        const other = rows.filter((row) => row.other && !keptIds.has(row.source));
        const combined = [...kept, ...other];
        return {
          ...data,
          rows: combined,
          sourcesShown: combined.filter((row) => !row.other).length,
        };
      },
    );
  }

  const handlers: Record<ToolName, (input: unknown) => Promise<string>> = {
    getSiteOverview: (input) => getSiteOverview(toolInputSchemas.getSiteOverview.parse(input)),
    findLeads: (input) => findLeads(toolInputSchemas.findLeads.parse(input)),
    getLeadSummary: (input) => getLeadSummary(toolInputSchemas.getLeadSummary.parse(input)),
    listOpenTasks: (input) => listOpenTasks(toolInputSchemas.listOpenTasks.parse(input)),
    getSourcePerformance: (input) =>
      getSourcePerformance(toolInputSchemas.getSourcePerformance.parse(input)),
  };

  /**
   * Every entry point passes through here: a tool call is reserved before any
   * work, so a model asking for ten tools in one message still stops at the
   * turn's six, and the refusal is a bounded explanation rather than a throw.
   *
   * An identical read already made in this same turn (same tool, same
   * arguments) is served from memory and reserves nothing: the model repeating
   * itself must not cost a second query or a second slice of the budget.
   */
  const identicalReads = new Map<string, Promise<string>>();

  async function run(name: ToolName, input: unknown): Promise<string> {
    const key = `${name}:${JSON.stringify(input)}`;
    const repeated = identicalReads.get(key);
    if (repeated !== undefined) {
      // The answer is already in this turn, but permission is not cached: a
      // membership revoked a second ago must still end the turn.
      await reauthorize();
      return repeated;
    }
    if (!context.budget.reserveToolCall()) {
      const scope = scopeOf(context, { window: null });
      return JSON.stringify(
        unavailable(
          scope,
          asOf(),
          'This turn has already used its tool budget. Answer from what was read, and say the rest could not be checked.',
        ),
      );
    }
    const pending = handlers[name](input);
    identicalReads.set(key, pending);
    return pending;
  }

  /**
   * The model-facing definitions. `execute` is the same validated handler; a
   * schema failure is thrown to the SDK, which reports it to the model as a
   * tool error rather than reaching the database.
   */
  const definitions: ToolSet = {
    getSiteOverview: tool({
      description:
        'Count leads received in a period and their current stage distribution. Use for "how many leads/orders" and "how are they distributed by stage" questions. Counts include drafts unless the question asks for submitted only; archived and customer-restricted leads are excluded. Default period: last 30 days.',
      inputSchema: toolInputSchemas.getSiteOverview,
      execute: async (input) => run('getSiteOverview', input),
    }),
    findLeads: tool({
      description:
        'Search this site’s leads by name or reference number, optionally filtered by type, stage, assignee or the archive. Returns at most 10 minimal records per page with an exact total. Never returns contact details.',
      inputSchema: toolInputSchemas.findLeads,
      execute: async (input) => run('findLeads', input),
    }),
    getLeadSummary: tool({
      description:
        'Read one lead by its id: type, stage, reference, assignee, dates, up to 10 open tasks and 10 recent activity entries. Add "notes" to the sections only when the person asked for notes or a summary that includes them.',
      inputSchema: toolInputSchemas.getLeadSummary,
      execute: async (input) => run('getLeadSummary', input),
    }),
    listOpenTasks: tool({
      description:
        'List open follow-ups (tasks) on active leads, with their due days, filtered by assignee and by due date. "Due today or earlier" includes overdue and due today; overdue alone means before today.',
      inputSchema: toolInputSchemas.listOpenTasks,
      execute: async (input) => run('listOpenTasks', input),
    }),
    getSourcePerformance: tool({
      description:
        'The existing source report for one lead type: received, submitted and made-it counts per source, with the report’s own Other row preserved. Windows are 7, 30 or 90 days, or all time.',
      inputSchema: toolInputSchemas.getSourcePerformance,
      execute: async (input) => run('getSourcePerformance', input),
    }),
  };

  return {
    definitions,
    async execute(name, input) {
      return run(name, input);
    },
  };
}

function invalidFilter<T>(scope: ToolScope, asOf: string, message: string): ToolResult<T> {
  return { status: 'invalid_filter', asOf, scope, sources: [], message };
}

/** Whether this access snapshot may see monetary values (none are exposed in v1). */
export function canSeeMoney(access: StaffAccessSnapshot | undefined): boolean {
  return decideAccess(access, 'financial.read').allowed;
}
