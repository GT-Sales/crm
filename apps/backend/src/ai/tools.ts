import {
  AI_ASSISTANT_LIMITS,
  aiPeriodSchema,
  areValidLeadPropertyFilters,
  isLeadStage,
  leadPropertyFilterListSchema,
  leadStageLabel,
  leadTypeCatalog,
  leadTypeLabel,
  type AiPeriod,
} from '@gt-sales/contracts';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

import type { ReportStore } from '../reports/store.js';
import type { Scope } from '../tenant-scope.js';
import { decideAiAccess } from '../routes/ai-assistant.js';
import { type StaffAccessSnapshot } from '../staff/authorization.js';
import { moneyVisibilityOf } from '../staff/lead-visibility.js';
import {
  projectChangeRequest,
  projectDocuments,
  projectLeadValues,
  projectTimelineEntry,
} from './lead-record.js';
import { TurnBudget } from './limits.js';
import { RECORD_DATA_NOTICE, inertRecordText, neutralizeSerialized } from './record-text.js';
import {
  activityKindWords,
  noteExcerpt,
  projectLead,
  projectTask,
  toolResultSchema,
  type ActivityProjection,
  type FindLeadsData,
  type InboxCountsData,
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
  businessDayLabel,
  resolvePeriod,
  resolveTaskDueWindow,
  type ResolvedWindow,
  type TaskDueFilter,
  type TaskDueWindow,
} from './windows.js';

/**
 * A source card's created-at bounds: the instants of a dated window, nothing
 * for all time, whose start (the epoch) would only read as noise.
 */
function createdBounds(window: { period: string; start: Date; end: Date }): string {
  return window.period === 'all_time'
    ? ''
    : ` · ${window.start.toISOString()} ≤ created < ${window.end.toISOString()}`;
}

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
  'getInboxCounts',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/** The model's whole tool input vocabulary; no field can widen the scope. */
export const toolInputSchemas = {
  getSiteOverview: z
    .object({
      leadType: z.string().min(1).max(64).optional(),
      period: aiPeriodSchema.optional(),
      status: z.literal('submitted').optional(),
    })
    .strict(),
  findLeads: z
    .object({
      search: z.string().trim().min(1).max(120).optional(),
      leadType: z.string().min(1).max(64).optional(),
      stage: z.string().min(1).max(64).optional(),
      assignee: z.union([z.enum(['me', 'none']), z.uuid()]).optional(),
      archived: z.boolean().optional(),
      /** `incomplete` (a draft checkout) or `submitted`. */
      status: z.enum(['incomplete', 'submitted']).optional(),
      /** The inbox's views: active (default), new (nobody opened it yet), mine, archived. */
      view: z.enum(['active', 'new', 'mine', 'archived']).optional(),
      /** Only leads with an open follow-up due on or before this day (YYYY-MM-DD). */
      dueBy: z.iso.date().optional(),
      /** Property filters, checked with the inbox's own validator against this site's catalogue. */
      where: leadPropertyFilterListSchema.max(5).optional(),
      page: z.int().min(1).max(5).optional(),
    })
    .strict(),
  getLeadSummary: z
    .object({
      leadId: z.uuid(),
      includeArchived: z.boolean().optional(),
      sections: z
        .array(z.enum(['tasks', 'activity', 'notes', 'documents', 'details']))
        .max(5)
        .optional(),
    })
    .strict(),
  listOpenTasks: z
    .object({
      assignee: z.union([z.enum(['me', 'all', 'none']), z.uuid()]).optional(),
      due: z.enum(['any', 'overdue', 'due_today', 'due_today_or_earlier']).optional(),
      /** `active` (To do and In progress, the default) or one stage. */
      status: z.enum(['active', 'open', 'in_progress', 'done', 'cancelled']).optional(),
      /** A few words of the task's title, to find one task (case-insensitive). */
      titleContains: z.string().trim().min(1).max(100).optional(),
      /** Only tasks completed on or after this day (YYYY-MM-DD), for done tasks. */
      completedSince: z.iso.date().optional(),
      /** A due-date range by calendar day, both ends included; replaces `due`. */
      dueFrom: z.iso.date().optional(),
      dueTo: z.iso.date().optional(),
      page: z.int().min(1).max(5).optional(),
    })
    .strict(),
  getSourcePerformance: z
    .object({
      leadType: z.string().min(1).max(64),
      days: z.union([z.literal(7), z.literal(30), z.literal(90)]).optional(),
    })
    .strict(),
  getInboxCounts: z.object({}).strict(),
} as const;

const FIND_LEADS_PAGE_SIZE = 10;
const TASKS_PAGE_SIZE = 20;
/** The newest timeline entries (notes aside) one lead summary carries. */
const SUMMARY_TIMELINE_ENTRIES = 10;
/** A source report row's label, cut to this many code points. */
const SOURCE_LABEL_MAX = 200;
/** The longest due-date range a task read takes, in days. */
const TASK_DUE_RANGE_MAX_DAYS = 366;

export interface ToolContext {
  readonly scope: Scope;
  readonly site: AiSiteContext;
  readonly now: Date;
  readonly signal?: AbortSignal;
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
  return value === undefined || Object.hasOwn(leadTypeCatalog, value);
}

export function createAssistantTools(context: ToolContext): AssistantToolset {
  const asOf = () => context.now.toISOString();

  async function reauthorize(): Promise<StaffAccessSnapshot> {
    context.signal?.throwIfAborted();
    const access = await context.loadAccess();
    context.signal?.throwIfAborted();
    const decision = decideAiAccess(access);
    if (!decision.allowed) {
      context.onAccessRevoked?.();
      throw new AssistantAccessRevokedError();
    }
    return decision.access;
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
    let candidate: ToolResult<T>;
    for (;;) {
      candidate = {
        ...result,
        data: build(kept),
        returnedCount: countRecords(kept),
        ...(kept.length < rows.length ? { truncated: true, hasMore: true } : {}),
        notice: RECORD_DATA_NOTICE,
      };
      // The exact text the model receives: every raw format character gone (C12).
      const text = neutralizeSerialized(JSON.stringify(candidate));
      const bytes = Buffer.byteLength(text, 'utf8');
      if (
        bytes <= context.budget.remainingBytes &&
        countRecords(kept) <= context.budget.remainingRecords
      ) {
        context.budget.acceptResult({ bytes, records: countRecords(kept) });
        return text;
      }
      if (kept.length === 0)
        return JSON.stringify(
          unavailable<T>(
            result.scope,
            result.asOf,
            'The answer would exceed this turn’s data budget. Ask a narrower question.',
          ),
        );
      kept = kept.slice(0, -1);
    }
  }

  async function getSiteOverview(input: z.infer<(typeof toolInputSchemas)['getSiteOverview']>) {
    await reauthorize();
    const period: AiPeriod = input.period ?? AI_DEFAULT_PERIOD;
    const window = resolvePeriod(period, context.now);
    const scope = scopeOf(context, {
      leadType: input.leadType ?? null,
      window,
      filters: { period, ...(input.status === undefined ? {} : { status: input.status }) },
    });

    if (input.leadType === undefined) {
      // A site-wide count is allowed, but only over the types this site holds.
      const totals = await overviewForAllTypes(context, window, input.status);
      if (!totals) {
        return JSON.stringify(
          temporaryFailure<OverviewData>(scope, asOf(), 'Lead counts could not be read.'),
        );
      }
      const data: OverviewData = {
        received: totals.received,
        submitted: totals.submitted,
        byStage: totals.byStage,
      };
      context.sources.leadsInbox(
        `${context.site.name} · all lead types · ${window.label} · ${input.status === 'submitted' ? 'submitted only' : 'drafts included'}, archived and restricted excluded${createdBounds(window)}`,
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
      totals = await context.reads.overview(context.scope, {
        leadType,
        window,
        ...(input.status === undefined ? {} : { status: input.status }),
      });
    } catch {
      return JSON.stringify(
        temporaryFailure<OverviewData>(scope, asOf(), 'Lead counts could not be read just now.'),
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
      `${context.site.name} · ${leadType} · ${window.label} · ${input.status === 'submitted' ? 'submitted only' : 'drafts included'}, archived and restricted excluded${createdBounds(window)}`,
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
    status?: 'submitted',
  ): Promise<{ received: number; submitted: number; byStage: OverviewStageCount[] } | undefined> {
    // Sum the site's own types one by one: the catalogue stays the source of
    // truth for which types exist, and each read stays a bounded query.
    const byStage: OverviewStageCount[] = [];
    let received = 0;
    let submitted = 0;
    for (const leadType of context.site.leadTypes) {
      try {
        const totals = await context.reads.overview(context.scope, {
          leadType,
          window,
          ...(status === undefined ? {} : { status }),
        });
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
    const archived = input.archived === true || input.view === 'archived';
    const assignee = input.view === 'mine' ? 'me' : input.assignee;
    const scope = scopeOf(context, {
      leadType: input.leadType ?? null,
      window: null,
      archivePolicy: archived ? 'archived_only' : 'active_only',
      // The filters by name and by the catalogue's own words; a search's or a
      // property filter's values are never echoed back.
      filters: {
        ...(input.search === undefined ? {} : { search: 'provided' }),
        ...(input.stage === undefined ? {} : { stage: input.stage }),
        ...(assignee === undefined ? {} : { assignee }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.view === undefined ? {} : { view: input.view }),
        ...(input.dueBy === undefined ? {} : { dueBy: input.dueBy }),
        ...(input.where === undefined
          ? {}
          : { propertyFilters: input.where.map((filter) => `${filter.key} ${filter.op}`) }),
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
    if (
      (input.view === 'mine' && input.assignee !== undefined && input.assignee !== 'me') ||
      (input.view !== undefined && input.view !== 'archived' && input.archived === true) ||
      (input.view === 'archived' && input.archived === false)
    ) {
      return JSON.stringify(
        invalidFilter<FindLeadsData>(
          scope,
          asOf(),
          'The view and the other filters ask for different leads. Use one of them.',
        ),
      );
    }

    // Property filters name the site's properties as it defines them now, and
    // pass the inbox's own validator, exactly as the staff route checks them.
    let catalog;
    if (input.where !== undefined) {
      if (context.reads.siteCatalog === undefined)
        return JSON.stringify(
          unavailable<FindLeadsData>(scope, asOf(), 'Property filters are not available here.'),
        );
      try {
        catalog = await context.reads.siteCatalog(context.scope);
      } catch {
        return JSON.stringify(
          temporaryFailure<FindLeadsData>(scope, asOf(), 'Leads could not be searched just now.'),
        );
      }
      if (!areValidLeadPropertyFilters(input.where, input.leadType, catalog)) {
        return JSON.stringify(
          invalidFilter<FindLeadsData>(
            scope,
            asOf(),
            'A property filter does not fit this site’s properties (an unknown or hidden property, an operator its kind does not take, or a value of the wrong kind). Read getPropertyCatalog for the keys, kinds and choices.',
          ),
        );
      }
    }

    let result;
    try {
      result = await context.reads.findLeads(context.scope, {
        ...(input.search === undefined ? {} : { search: input.search }),
        ...(input.leadType === undefined ? {} : { leadType: input.leadType }),
        ...(input.stage === undefined ? {} : { stage: input.stage }),
        ...(assignee === undefined ? {} : { assignee }),
        ...(archived ? { archived: true } : input.archived === false ? { archived: false } : {}),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.view === 'new' ? { unopenedOnly: true } : {}),
        ...(input.dueBy === undefined ? {} : { dueBy: input.dueBy }),
        ...(input.where === undefined ? {} : { where: input.where }),
        ...(catalog === undefined ? {} : { catalog }),
        limit: FIND_LEADS_PAGE_SIZE,
        offset: (page - 1) * FIND_LEADS_PAGE_SIZE,
      });
    } catch {
      return JSON.stringify(
        temporaryFailure<FindLeadsData>(scope, asOf(), 'Leads could not be searched just now.'),
      );
    }

    const leads = result.rows.map(projectLead);
    for (const lead of leads) {
      context.sources.lead(
        lead.leadId,
        lead.reference ?? lead.name ?? 'Lead',
        `${context.site.name} · ${lead.leadTypeLabel} · ${lead.stageLabel}${lead.archived ? ' · archived' : ''}`,
      );
    }
    if (
      input.status !== undefined ||
      input.view !== undefined ||
      input.dueBy !== undefined ||
      input.where !== undefined
    ) {
      // A filtered list gets the inbox link the server builds from the checked
      // filters; what the inbox URL cannot carry is said in the scope text.
      const today = businessDayLabel(context.now);
      const dueToday = input.dueBy === today;
      const notInLink = [
        ...(input.search === undefined ? [] : ['the search']),
        ...(input.status === undefined ? [] : ['the status']),
        ...(input.view === 'new' ? ['the New view'] : []),
        ...(input.dueBy !== undefined && !dueToday ? ['the due date'] : []),
        ...(input.stage !== undefined && input.leadType === undefined ? ['the stage'] : []),
      ];
      context.sources.leadsInboxFiltered(
        {
          archived,
          ...(input.leadType === undefined ? {} : { leadType: input.leadType }),
          ...(input.stage === undefined ? {} : { stage: input.stage }),
          ...(assignee === undefined ? {} : { assignee }),
          dueToday,
          ...(input.where === undefined ? {} : { where: input.where }),
        },
        `${context.site.name} · ${result.total} leads${notInLink.length === 0 ? '' : ` · the inbox opens without ${notInLink.join(', ')}`}`,
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
        truncated: result.total > leads.length,
        hasMore,
        sources: context.sources.list(),
      },
      leads,
      (kept) => ({ leads: kept }),
    );
  }

  async function getLeadSummary(input: z.infer<(typeof toolInputSchemas)['getLeadSummary']>) {
    const access = await reauthorize();
    const sections = new Set(input.sections ?? ['tasks', 'activity', 'documents']);
    // The lead page's own read carries the timeline's meaning, the documents,
    // the change request and the values; a tasks- or notes-only read skips it.
    const includeRecord =
      sections.has('activity') || sections.has('documents') || sections.has('details');
    const money = moneyVisibilityOf(access);
    const scope = scopeOf(context, {
      window: null,
      archivePolicy: input.includeArchived ? 'including_archived' : 'active_only',
      filters: { leadId: input.leadId },
    });
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
        includeArchived: input.includeArchived ?? false,
        ...(sections.has('notes') ? { includeNotes: true } : {}),
        includeFinancial: money.orderMoney,
        includeCommission: money.orderMoney && money.revenue,
        ...(includeRecord ? { includeRecord: true } : {}),
      });
    } catch {
      return JSON.stringify(
        temporaryFailure<LeadSummaryData>(scope, asOf(), 'That lead could not be read just now.'),
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
    const record = summary.record;
    if (sections.has('activity') && record !== undefined) {
      const timeline = {
        leadType: summary.lead.lead_type,
        catalog: record.catalog,
        names: record.names,
        legacyKinds: record.legacyKinds,
      };
      for (const entry of record.work.activities) {
        if (recentActivity.length >= SUMMARY_TIMELINE_ENTRIES) break;
        const projected = projectTimelineEntry(entry, timeline);
        if (projected !== undefined) recentActivity.push(projected);
      }
    } else if (sections.has('activity')) {
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
      `${context.site.name} · ${lead.leadTypeLabel} · ${lead.stageLabel}${lead.archived ? ' · archived' : ''}`,
    );
    const documents =
      sections.has('documents') && record !== undefined
        ? projectDocuments(record.work.documents)
        : [];
    const details =
      sections.has('details') && record !== undefined
        ? projectLeadValues(record.work.lead, record.catalog)
        : undefined;
    const data: LeadSummaryData = {
      lead,
      ...(summary.order === undefined ? {} : { order: summary.order }),
      openTasks,
      recentActivity,
      ...(record === undefined
        ? {}
        : { changeRequest: projectChangeRequest(record.work.changeRequest) }),
    };
    // Whole records, trimmed from the end under the turn's budget: the values
    // go first, then documents, then the oldest timeline entries.
    const items = [
      ...openTasks.map((task) => ({ kind: 'task' as const, task })),
      ...recentActivity.map((activity) => ({ kind: 'activity' as const, activity })),
      ...documents.map((document) => ({ kind: 'document' as const, document })),
      ...(details?.values ?? []).map((value) => ({ kind: 'value' as const, value })),
    ];
    return finish(
      {
        status: 'ok',
        asOf: asOf(),
        scope,
        total: 1,
        returnedCount: 1 + items.length,
        truncated: summary.truncated ?? false,
        sources: context.sources.list(),
      },
      items,
      (kept) => ({
        ...data,
        openTasks: kept.flatMap((item) => (item.kind === 'task' ? [item.task] : [])),
        recentActivity: kept.flatMap((item) => (item.kind === 'activity' ? [item.activity] : [])),
        ...(sections.has('documents') && record !== undefined
          ? { documents: kept.flatMap((item) => (item.kind === 'document' ? [item.document] : [])) }
          : {}),
        ...(details === undefined
          ? {}
          : {
              details: {
                values: kept.flatMap((item) => (item.kind === 'value' ? [item.value] : [])),
                withheld: details.withheld,
              },
            }),
      }),
      (kept) => 1 + kept.length,
    );
  }

  async function listOpenTasks(input: z.infer<(typeof toolInputSchemas)['listOpenTasks']>) {
    await reauthorize();
    const page = input.page ?? 1;
    const ranged = input.dueFrom !== undefined || input.dueTo !== undefined;
    // A calendar range replaces the fixed windows; a done task read with
    // `completedSince` looks at every due date unless one was asked for.
    const dueFilter: TaskDueFilter =
      input.due ?? (ranged || input.completedSince !== undefined ? 'any' : 'due_today_or_earlier');
    const due = ranged
      ? dueRange(input.dueFrom, input.dueTo)
      : resolveTaskDueWindow(dueFilter, context.now);
    const assignee = input.assignee ?? 'all';
    const status = input.status ?? 'active';
    const scope = scopeOf(context, {
      window: null,
      filters: {
        due: ranged ? 'range' : dueFilter,
        dueLabel: due?.label ?? 'invalid range',
        assignee,
        status,
        // Whether a title was given, never the words themselves (as findLeads' search).
        ...(input.titleContains === undefined ? {} : { titleContains: 'provided' }),
        ...(input.completedSince === undefined ? {} : { completedSince: input.completedSince }),
      },
    });
    if (due === undefined || (ranged && input.due !== undefined && input.due !== 'any')) {
      return JSON.stringify(
        invalidFilter<OpenTasksData>(
          scope,
          asOf(),
          `A due range needs dueFrom on or before dueTo, at most ${TASK_DUE_RANGE_MAX_DAYS} days, and replaces due.`,
        ),
      );
    }

    let result;
    try {
      result = await context.reads.openTasks(context.scope, {
        assignee,
        due,
        status,
        ...(input.titleContains === undefined ? {} : { titleContains: input.titleContains }),
        ...(input.completedSince === undefined
          ? {}
          : { completedSince: new Date(`${input.completedSince}T00:00:00.000Z`) }),
        limit: TASKS_PAGE_SIZE,
        offset: (page - 1) * TASKS_PAGE_SIZE,
      });
    } catch {
      return JSON.stringify(
        temporaryFailure<OpenTasksData>(scope, asOf(), 'Follow-ups could not be read just now.'),
      );
    }

    const tasks = result.rows.map(projectTask);
    context.sources.tasks(
      `${context.site.name} · ${status === 'active' ? 'open follow-ups' : `${status.replace('_', ' ')} tasks`} · ${due.label}`,
    );
    const hasMore = page < 5 && result.total > page * TASKS_PAGE_SIZE;
    return finish(
      {
        status: 'ok',
        asOf: asOf(),
        scope,
        total: result.total,
        returnedCount: tasks.length,
        truncated: result.total > tasks.length,
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
        asOf: context.now,
        queryTimeoutMs: AI_ASSISTANT_LIMITS.toolQueryTimeoutMs,
      });
    } catch {
      return JSON.stringify(
        temporaryFailure<SourcePerformanceData>(
          scope,
          asOf(),
          'The source report could not be read just now.',
        ),
      );
    }

    const rows = report.rows
      .map((row) => ({
        // A UTM or referrer label is text a visitor's link carried (C12).
        source: inertRecordText(row.source, SOURCE_LABEL_MAX) ?? 'unknown',
        kind: row.kind,
        received: row.received,
        submitted: row.submitted,
        madeIt: row.madeIt,
        other: row.kind === 'other',
      }))
      .sort((a, b) => Number(b.other) - Number(a.other));
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
      (kept) => ({
        ...data,
        rows: [...kept].sort((a, b) => Number(a.other) - Number(b.other)),
        sourcesShown: kept.filter((row) => !row.other).length,
      }),
    );
  }

  /** The inbox's counters (L2), from the staff summary's own query: counts only. */
  async function getInboxCounts() {
    await reauthorize();
    const today = businessDayLabel(context.now);
    const scope = scopeOf(context, { window: null, filters: { dueBy: today } });
    if (context.reads.inboxCounts === undefined)
      return JSON.stringify(
        unavailable<InboxCountsData>(scope, asOf(), 'The inbox counters are not available here.'),
      );
    let counts;
    try {
      counts = await context.reads.inboxCounts(context.scope, today);
    } catch {
      return JSON.stringify(
        temporaryFailure<InboxCountsData>(
          scope,
          asOf(),
          'The inbox counters could not be read just now.',
        ),
      );
    }
    const types = counts.types.map((entry) => ({
      leadType: entry.leadType,
      leadTypeLabel: leadTypeLabel(entry.leadType),
      active: entry.total,
      unopened: entry.unopened,
      followUpsDue: entry.followUpsDue ?? 0,
    }));
    context.sources.leadsInbox(
      `${context.site.name} · active, new and due-today counts per lead type, and the archive; restricted leads excluded · due by ${today}`,
    );
    return finish(
      {
        status: 'ok',
        asOf: asOf(),
        scope,
        total: types.reduce((sum, entry) => sum + entry.active, 0),
        sources: context.sources.list(),
      },
      types,
      (kept) => ({ inbox: { types: kept, archived: counts.archived } }),
    );
  }

  const handlers: Record<ToolName, (input: unknown) => Promise<string>> = {
    getSiteOverview: (input) => getSiteOverview(toolInputSchemas.getSiteOverview.parse(input)),
    findLeads: (input) => findLeads(toolInputSchemas.findLeads.parse(input)),
    getLeadSummary: (input) => getLeadSummary(toolInputSchemas.getLeadSummary.parse(input)),
    listOpenTasks: (input) => listOpenTasks(toolInputSchemas.listOpenTasks.parse(input)),
    getSourcePerformance: (input) =>
      getSourcePerformance(toolInputSchemas.getSourcePerformance.parse(input)),
    getInboxCounts: (input) => {
      toolInputSchemas.getInboxCounts.parse(input);
      return getInboxCounts();
    },
  };

  /**
   * Every entry point passes through here: a tool call is reserved before any
   * work, so a model asking for ten tools in one message still stops at the
   * turn's six, and the refusal is a bounded explanation rather than a throw.
   *
   * An identical read already made in this same turn (same tool, same
   * arguments) is served from memory without another database query. Replayed
   * output still consumes call, byte and record allowances.
   */
  const identicalReads = new Map<string, Promise<string>>();

  async function run(name: ToolName, input: unknown): Promise<string> {
    const key = `${name}:${JSON.stringify(input)}`;
    const repeated = identicalReads.get(key);
    if (repeated !== undefined) {
      // The answer is already in this turn, but permission is not cached: a
      // membership revoked a second ago must still end the turn.
      await reauthorize();
      if (!context.budget.reserveToolCall())
        return JSON.stringify(
          unavailable(
            scopeOf(context, { window: null }),
            asOf(),
            'This turn has already used its tool budget.',
          ),
        );
      const cached = await repeated;
      if (
        context.budget.acceptResult({
          bytes: Buffer.byteLength(cached, 'utf8'),
          records: toolResultSchema.parse(JSON.parse(cached)).returnedCount ?? 0,
        }).rejected
      )
        return JSON.stringify(
          unavailable(
            scopeOf(context, { window: null }),
            asOf(),
            'This turn has already used its data budget.',
          ),
        );
      return cached;
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
    await reauthorize();
    const checked = toolInputSchemas[name].parse(input);
    if ('assignee' in checked && checked.assignee && z.uuid().safeParse(checked.assignee).success) {
      if (!(await context.reads.isActiveMember(context.scope, checked.assignee))) {
        return JSON.stringify(
          invalidFilter(
            scopeOf(context, { window: null }),
            asOf(),
            'That assignee is not available in this site.',
          ),
        );
      }
    }
    const pending = handlers[name](checked).then((result) =>
      JSON.stringify(toolResultSchema.parse(JSON.parse(result))),
    );
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
        'Search this site’s leads by name, reference number, email or phone, optionally filtered by type, stage, assignee, status (incomplete or submitted), view (active, new = never opened, mine, archived), dueBy (an open follow-up due on or before that day) and where (property filters: key, op and value, as getPropertyCatalog lists them). Returns at most 10 minimal records per page with an exact total, and for a filtered list a link to the same leads in the inbox. Never returns contact details.',
      inputSchema: toolInputSchemas.findLeads,
      execute: async (input) => run('findLeads', input),
    }),
    getLeadSummary: tool({
      description:
        'Read one lead by its id: type, stage, reference, assignee, dates, order (plan, quantity, dates, courier; price and payment and commission state for members who see them), whether a change request is waiting, up to 10 open tasks, the 10 newest timeline entries with their meaning (stage from → to, who it was assigned to, which fields were edited, which email template was sent and how it went, document reviews) and its documents (type and review status). Sections default to tasks, activity and documents. Add "notes" only when the person asked for notes or a summary that includes them, and "details" only when they ask for the lead’s form answers or custom property values.',
      inputSchema: toolInputSchemas.getLeadSummary,
      execute: async (input) => run('getLeadSummary', input),
    }),
    listOpenTasks: tool({
      description:
        'List tasks with their ids, stages and due days: follow-ups on active leads and plain tasks (no lead; leadId null). Filter by status (active, the default, is To do and In progress together; or open, in_progress, done, cancelled), assignee, due date (default due today or earlier; use due any to find a task to move; or dueFrom and dueTo, calendar days, for a range), completedSince (done tasks completed on or after a day) and titleContains (a few words of the title, such as "supplier", to find the one task the person means; use it whenever they name the task). Done tasks come most recently completed first, cancelled ones most recently changed first, active ones undated first then soonest due. "Due today or earlier" includes overdue and due today; overdue alone means before today.',
      inputSchema: toolInputSchemas.listOpenTasks,
      execute: async (input) => run('listOpenTasks', input),
    }),
    getSourcePerformance: tool({
      description:
        'The existing source report for one lead type: received, submitted and made-it counts per source, with the report’s own Other row preserved. Windows are 7, 30 or 90 days, or all time.',
      inputSchema: toolInputSchemas.getSourcePerformance,
      execute: async (input) => run('getSourcePerformance', input),
    }),
    getInboxCounts: tool({
      description:
        'The leads inbox counters, as the inbox shows them: per lead type the active leads, the new (never opened) ones and those with a follow-up due today or earlier, and the archived total.',
      inputSchema: toolInputSchemas.getInboxCounts,
      execute: async (input) => run('getInboxCounts', input),
    }),
  };

  return {
    definitions,
    async execute(name, input) {
      return run(name, input);
    },
  };
}

/**
 * A due-date range by calendar day, both ends included, compared as the fixed
 * windows are: a due date is a day stored at noon UTC, so the range runs from
 * the first day's UTC midnight to the UTC midnight after the last. Undefined
 * for an inverted or too long range.
 */
function dueRange(from: string | undefined, to: string | undefined): TaskDueWindow | undefined {
  const start = from === undefined ? undefined : new Date(`${from}T00:00:00.000Z`);
  const last = to === undefined ? undefined : new Date(`${to}T00:00:00.000Z`);
  const before = last === undefined ? undefined : new Date(last.getTime() + DAY_MS);
  if (start !== undefined && before !== undefined) {
    const days = (before.getTime() - start.getTime()) / DAY_MS;
    if (days < 1 || days > TASK_DUE_RANGE_MAX_DAYS) return undefined;
  }
  return {
    ...(start === undefined ? {} : { from: start }),
    ...(before === undefined ? {} : { before }),
    label: `due ${from === undefined ? 'any day' : `from ${from}`} ${to === undefined ? 'onwards' : `to ${to}`} (calendar days)`,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function invalidFilter<T>(scope: ToolScope, asOf: string, message: string): ToolResult<T> {
  return { status: 'invalid_filter', asOf, scope, sources: [], message };
}

/**
 * Whether this live access snapshot may see an order's price, currency,
 * payment status and commission state: the lead page's own rule
 * (`moneyVisibilityOf`), so Ask AI shows exactly the money the admin shows.
 */
export function canSeeMoney(access: StaffAccessSnapshot | undefined): boolean {
  return moneyVisibilityOf(access).orderMoney;
}

function temporaryFailure<T>(scope: ToolScope, asOf: string, message: string): ToolResult<T> {
  return { status: 'temporary_failure', asOf, scope, sources: [], message };
}
