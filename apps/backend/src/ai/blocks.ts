import { tool } from 'ai';
import { z } from 'zod';
import { AI_BLOCKS_PER_ANSWER, aiBlockSchema, type AiBlock } from '@gt-sales/contracts';

import { inertRecordText } from './record-text.js';

/**
 * Answer blocks (docs/design/ai-blocks.md): a short list of leads, a few
 * figures, or a ranked list under an answer. The model only chooses one, by
 * the read it made in this turn; the server builds it from that read's own
 * result, so every name, number and link comes from the CRM and the access
 * projection the read already applied. Nothing is queried again and nothing
 * is stored with the answer.
 */

/** The reads a block can be built from. */
export const BLOCK_READS = [
  'findLeads',
  'listOpenTasks',
  'getSiteOverview',
  'getInboxCounts',
  'getSourcePerformance',
  'getAnalytics',
] as const;
type BlockRead = (typeof BLOCK_READS)[number];
const isBlockRead = (name: string): name is BlockRead => BLOCK_READS.some((read) => read === name);

const ANALYTICS_LISTS = ['sources', 'plans', 'stages', 'partners'] as const;

export const showBlockInputSchema = z
  .object({
    kind: z.enum(['leads', 'stats', 'ranking']),
    from: z.enum(BLOCK_READS),
    /** getAnalytics only: which of its ranked lists a ranking shows. */
    list: z.enum(ANALYTICS_LISTS).optional(),
  })
  .strict();
export type ShowBlockInput = z.infer<typeof showBlockInputSchema>;

const LEAD_ROWS = 8;
const RANK_ROWS = 8;

const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' ? inertRecordText(value, max) : null;
const count = z.int().nonnegative();

// The parts of each read's `data` a block uses; anything else is ignored.
const okEnvelope = <T extends z.ZodType>(data: T) =>
  z.object({
    status: z.literal('ok'),
    data,
    total: z.int().nonnegative().optional(),
  });
const findLeadsResult = okEnvelope(
  z.object({
    leads: z.array(
      z.object({
        leadId: z.uuid(),
        reference: z.string().nullable(),
        name: z.string().nullable(),
        stageLabel: z.string(),
        assignee: z.string().nullable(),
      }),
    ),
  }),
);
const openTasksResult = okEnvelope(
  z.object({
    tasks: z.array(
      z.object({
        leadId: z.uuid().nullable(),
        leadReference: z.string().nullable(),
        leadName: z.string().nullable(),
        title: z.string(),
        dueDay: z.string().nullable(),
      }),
    ),
  }),
);
const overviewResult = okEnvelope(
  z.object({
    received: count,
    submitted: count,
    byStage: z.array(z.object({ stageLabel: z.string(), count })),
  }),
);
const inboxResult = okEnvelope(
  z.object({
    inbox: z.object({
      types: z.array(z.object({ active: count, unopened: count, followUpsDue: count })),
      archived: count,
    }),
  }),
);
const sourcesResult = okEnvelope(
  z.object({ rows: z.array(z.object({ source: z.string(), received: count })) }),
);
const compared = z.object({ current: z.int(), previous: z.int().nullable() });
const labelled = z.array(z.object({ label: z.string(), total: count }));
const analyticsResult = okEnvelope(
  z.object({
    range: z.object({ days: z.int().positive() }),
    kpis: z.object({
      newLeads: compared,
      won: compared,
      paid: compared,
      followUpsDue: count,
      followUpsOverdue: count,
      documentsToReview: count,
    }),
    stages: z.array(z.object({ stageLabel: z.string(), total: count })),
    sources: labelled,
    plans: labelled,
    partners: labelled,
  }),
);

type Built = { block: AiBlock } | { refused: string };

function parse<T>(schema: z.ZodType<T>, raw: string): T | undefined {
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function ranking(title: string, rows: readonly { label: unknown; value: number }[]): Built {
  const kept = rows
    .map((row) => ({ label: text(row.label, 120), value: row.value }))
    .filter((row): row is { label: string; value: number } => row.label !== null)
    .slice(0, RANK_ROWS);
  return kept.length === 0
    ? { refused: 'That read has nothing to rank.' }
    : { block: { kind: 'ranking', title, rows: kept } };
}

export class BlockRegistry {
  private readonly reads = new Map<BlockRead, string>();
  private readonly shown: AiBlock[] = [];
  private readonly keys = new Set<string>();

  constructor(private readonly workspaceSlug: string) {}

  /** Keeps a read's latest result of this turn, for a block built from it. */
  record(name: string, result: string): void {
    if (isBlockRead(name)) this.reads.set(name, result);
  }

  /** The blocks of this turn, in the order asked for. */
  list(): readonly AiBlock[] {
    return this.shown;
  }

  /** Builds and keeps one block; what the model is told back. */
  show(raw: unknown): string {
    const input = showBlockInputSchema.safeParse(raw);
    if (!input.success) return refusal('That is not a block this CRM can show.');
    const key = `${input.data.kind}:${input.data.from}:${input.data.list ?? ''}`;
    if (this.keys.has(key)) return JSON.stringify({ status: 'ok', shown: 'already' });
    if (this.shown.length >= AI_BLOCKS_PER_ANSWER)
      return refusal(`At most ${AI_BLOCKS_PER_ANSWER} blocks go under one answer.`);
    const result = this.reads.get(input.data.from);
    if (result === undefined)
      return refusal(`Read ${input.data.from} in this turn first; a block shows what it returned.`);
    const built = this.build(input.data, result);
    if ('refused' in built) return refusal(built.refused);
    const block = aiBlockSchema.safeParse(built.block);
    if (!block.success) return refusal('That read cannot be shown as a block.');
    this.shown.push(block.data);
    this.keys.add(key);
    return JSON.stringify({
      status: 'ok',
      shown: block.data.kind,
      note: 'The block is under your answer. Do not repeat its rows or figures; one or two sentences of what they mean.',
    });
  }

  private leadHref(leadId: string): string {
    return `/w/${encodeURIComponent(this.workspaceSlug)}/leads/${leadId}`;
  }

  private build(input: ShowBlockInput, raw: string): Built {
    const { kind, from } = input;
    if (kind === 'leads' && from === 'findLeads') {
      const read = parse(findLeadsResult, raw);
      if (!read) return { refused: 'That read found no leads to show.' };
      const rows = read.data.leads.slice(0, LEAD_ROWS).map((lead) => ({
        label: text(lead.name, 120) ?? text(lead.reference, 120) ?? 'Lead',
        stage: text(lead.stageLabel, 80),
        fact: lead.assignee === null ? 'Unassigned' : text(`Assigned to ${lead.assignee}`, 160),
        href: this.leadHref(lead.leadId),
      }));
      if (rows.length === 0) return { refused: 'That read found no leads to show.' };
      const total = read.total ?? read.data.leads.length;
      return {
        block: { kind, title: 'Leads', rows, more: Math.max(0, total - rows.length) },
      };
    }
    if (kind === 'leads' && from === 'listOpenTasks') {
      const read = parse(openTasksResult, raw);
      if (!read) return { refused: 'That read found no follow-ups to show.' };
      const rows = read.data.tasks.slice(0, LEAD_ROWS).map((task) => ({
        label:
          text(task.leadName, 120) ??
          text(task.leadReference, 120) ??
          text(task.title, 120) ??
          'Task',
        stage: null,
        fact: text(task.dueDay === null ? task.title : `${task.title} · due ${task.dueDay}`, 160),
        href: task.leadId === null ? null : this.leadHref(task.leadId),
      }));
      if (rows.length === 0) return { refused: 'That read found no follow-ups to show.' };
      const total = read.total ?? read.data.tasks.length;
      return {
        block: { kind, title: 'Open follow-ups', rows, more: Math.max(0, total - rows.length) },
      };
    }
    if (kind === 'stats' && from === 'getSiteOverview') {
      const read = parse(overviewResult, raw);
      if (!read) return { refused: 'That read has no figures to show.' };
      return {
        block: {
          kind,
          title: 'Leads',
          tiles: [
            { label: 'Received', value: read.data.received, previous: null },
            { label: 'Submitted', value: read.data.submitted, previous: null },
          ],
        },
      };
    }
    if (kind === 'stats' && from === 'getInboxCounts') {
      const read = parse(inboxResult, raw);
      if (!read) return { refused: 'That read has no figures to show.' };
      const sum = (key: 'active' | 'unopened' | 'followUpsDue') =>
        read.data.inbox.types.reduce((total, type) => total + type[key], 0);
      return {
        block: {
          kind,
          title: 'Inbox',
          tiles: [
            { label: 'Active', value: sum('active'), previous: null },
            { label: 'Not opened', value: sum('unopened'), previous: null },
            { label: 'Follow-ups due', value: sum('followUpsDue'), previous: null },
            { label: 'Archived', value: read.data.inbox.archived, previous: null },
          ],
        },
      };
    }
    if (kind === 'stats' && from === 'getAnalytics') {
      const read = parse(analyticsResult, raw);
      if (!read) return { refused: 'That read has no figures to show.' };
      const { kpis } = read.data;
      return {
        block: {
          kind,
          title: `Last ${read.data.range.days} days`,
          tiles: [
            { label: 'New leads', value: kpis.newLeads.current, previous: kpis.newLeads.previous },
            { label: 'Won', value: kpis.won.current, previous: kpis.won.previous },
            { label: 'Paid', value: kpis.paid.current, previous: kpis.paid.previous },
            { label: 'Follow-ups due', value: kpis.followUpsDue, previous: null },
            { label: 'Overdue', value: kpis.followUpsOverdue, previous: null },
            { label: 'Documents to review', value: kpis.documentsToReview, previous: null },
          ],
        },
      };
    }
    if (kind === 'ranking' && from === 'getSiteOverview') {
      const read = parse(overviewResult, raw);
      if (!read) return { refused: 'That read has nothing to rank.' };
      return ranking(
        'Leads by stage',
        read.data.byStage.map((row) => ({ label: row.stageLabel, value: row.count })),
      );
    }
    if (kind === 'ranking' && from === 'getSourcePerformance') {
      const read = parse(sourcesResult, raw);
      if (!read) return { refused: 'That read has nothing to rank.' };
      return ranking(
        'Leads by source',
        read.data.rows.map((row) => ({ label: row.source, value: row.received })),
      );
    }
    if (kind === 'ranking' && from === 'getAnalytics') {
      const read = parse(analyticsResult, raw);
      if (!read) return { refused: 'That read has nothing to rank.' };
      const list = input.list ?? 'sources';
      const rows =
        list === 'stages'
          ? read.data.stages.map((row) => ({ label: row.stageLabel, value: row.total }))
          : read.data[list].map((row) => ({ label: row.label, value: row.total }));
      const titles = {
        sources: 'Top sources',
        plans: 'Top plans',
        stages: 'By stage',
        partners: 'Top partners',
      };
      return ranking(`${titles[list]} · last ${read.data.range.days} days`, rows);
    }
    return { refused: `A ${kind} block cannot be built from ${from}.` };
  }
}

function refusal(message: string): string {
  return JSON.stringify({ status: 'not_shown', message });
}

/** The model's tool: it names a block and a read of this turn, nothing else. */
export function createShowBlockTool(blocks: BlockRegistry) {
  return tool({
    description:
      'Show a small block under your answer, built by the CRM from a read you already made in this turn: kind leads (from findLeads or listOpenTasks, up to 8 rows with links), stats (from getAnalytics, getSiteOverview or getInboxCounts, a few figures with the change against the period before) or ranking (from getSourcePerformance, getSiteOverview, or getAnalytics with list sources, plans, stages or partners). Use it only when it helps: three or more leads, or figures worth comparing. At most two per answer. Never repeat the block in your text; say in one or two sentences what it shows.',
    inputSchema: showBlockInputSchema,
    execute: (input) => Promise.resolve(blocks.show(input)),
  });
}
