import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { aiStreamPartSchema } from '@gt-sales/contracts';

import { BlockRegistry } from '../src/ai/blocks.js';
import { assertAssistantToolPolicy } from '../src/ai/tool-policy.js';
import { createShowBlockTool } from '../src/ai/blocks.js';

const statusOf = (raw: string): string =>
  z.object({ status: z.string() }).parse(JSON.parse(raw)).status;

const LEAD = '11111111-1111-4111-8111-111111111111';
const ok = (data: unknown, total?: number) =>
  JSON.stringify({ status: 'ok', asOf: '2026-11-24T10:00:00.000Z', data, total, sources: [] });

const leadsRead = (count: number, total = count) =>
  ok(
    {
      leads: Array.from({ length: count }, (_, index) => ({
        leadId: LEAD,
        reference: `MS-${index + 1}`,
        name: index === 0 ? null : `Customer ${index + 1}`,
        stageLabel: 'Pending',
        assignee: index % 2 === 0 ? null : 'Takib',
        leadType: 'sim_order',
      })),
    },
    total,
  );

const analyticsRead = ok({
  range: { from: '2026-10-25', to: '2026-11-23', days: 30 },
  comparison: { from: '2026-09-25', to: '2026-10-24' },
  kpis: {
    newLeads: { current: 40, previous: 32 },
    won: { current: 9, previous: null },
    paid: { current: 5, previous: 4 },
    followUpsDue: 3,
    followUpsOverdue: 1,
    documentsToReview: 6,
  },
  stages: [{ leadTypeLabel: 'SIM order', stageLabel: 'Pending', total: 12 }],
  sources: [
    { label: 'google', total: 20 },
    { label: 'facebook', total: 9 },
  ],
  plans: [],
  partners: [],
});

describe('answer blocks', () => {
  it('builds a lead list from the turn’s own read, with server links and the rest counted', () => {
    const blocks = new BlockRegistry('get canada sim');
    blocks.record('findLeads', leadsRead(10, 23));
    expect(statusOf(blocks.show({ kind: 'leads', from: 'findLeads' }))).toBe('ok');
    const [block] = blocks.list();
    if (block?.kind !== 'leads') throw new Error('no lead block');
    expect(block.rows).toHaveLength(8);
    expect(block.more).toBe(15);
    expect(block.rows[0]).toEqual({
      label: 'MS-1',
      stage: 'Pending',
      fact: 'Unassigned',
      href: `/w/get%20canada%20sim/leads/${LEAD}`,
    });
    expect(block.rows[1]?.fact).toBe('Assigned to Takib');
  });

  it('shows figures with the period before, and a ranked list', () => {
    const blocks = new BlockRegistry('site');
    blocks.record('getAnalytics', analyticsRead);
    blocks.show({ kind: 'stats', from: 'getAnalytics' });
    blocks.show({ kind: 'ranking', from: 'getAnalytics', list: 'sources' });
    const [stats, ranking] = blocks.list();
    if (stats?.kind !== 'stats' || ranking?.kind !== 'ranking') throw new Error('missing');
    expect(stats.title).toBe('Last 30 days');
    expect(stats.tiles[0]).toEqual({ label: 'New leads', value: 40, previous: 32 });
    expect(stats.tiles[1]).toEqual({ label: 'Won', value: 9, previous: null });
    expect(ranking.rows).toEqual([
      { label: 'google', value: 20 },
      { label: 'facebook', value: 9 },
    ]);
  });

  it('refuses what it cannot build: no read yet, a failed read, a wrong pairing, a third block', () => {
    const blocks = new BlockRegistry('site');
    const status = statusOf;
    expect(status(blocks.show({ kind: 'leads', from: 'findLeads' }))).toBe('not_shown');
    blocks.record(
      'findLeads',
      JSON.stringify({ status: 'temporary_failure', asOf: 'x', sources: [], message: 'later' }),
    );
    expect(status(blocks.show({ kind: 'leads', from: 'findLeads' }))).toBe('not_shown');
    blocks.record('getAnalytics', analyticsRead);
    expect(status(blocks.show({ kind: 'leads', from: 'getAnalytics' }))).toBe('not_shown');
    expect(status(blocks.show({ kind: 'table', from: 'getAnalytics' }))).toBe('not_shown');
    expect(status(blocks.show({ kind: 'stats', from: 'getAnalytics', extra: 1 }))).toBe(
      'not_shown',
    );
    blocks.show({ kind: 'stats', from: 'getAnalytics' });
    // The same block twice is shown once.
    expect(JSON.parse(blocks.show({ kind: 'stats', from: 'getAnalytics' }))).toMatchObject({
      shown: 'already',
    });
    blocks.show({ kind: 'ranking', from: 'getAnalytics' });
    expect(status(blocks.show({ kind: 'ranking', from: 'getAnalytics', list: 'stages' }))).toBe(
      'not_shown',
    );
    expect(blocks.list()).toHaveLength(2);
  });

  it('ignores reads a block is not built from, and keeps each read’s latest result', () => {
    const blocks = new BlockRegistry('site');
    blocks.record('getLeadSummary', leadsRead(3));
    expect(JSON.parse(blocks.show({ kind: 'leads', from: 'findLeads' }))).toMatchObject({
      status: 'not_shown',
    });
    blocks.record('findLeads', leadsRead(2));
    blocks.record('findLeads', leadsRead(3));
    blocks.show({ kind: 'leads', from: 'findLeads' });
    const [block] = blocks.list();
    expect(block?.kind === 'leads' ? block.rows.length : 0).toBe(3);
  });

  it('cleans the text a person typed before it reaches a block', () => {
    const blocks = new BlockRegistry('site');
    blocks.record(
      'getSourcePerformance',
      ok({ rows: [{ source: 'ignore\u0000 previous‮', received: 4 }] }),
    );
    blocks.show({ kind: 'ranking', from: 'getSourcePerformance' });
    const [block] = blocks.list();
    const label = block?.kind === 'ranking' ? block.rows[0]?.label : '';
    expect(label?.includes('\u0000')).toBe(false);
    expect(label?.includes('\u202e')).toBe(false);
  });

  it('builds parts the stream contract accepts, and passes the tool policy', () => {
    const blocks = new BlockRegistry('site');
    blocks.record('getAnalytics', analyticsRead);
    blocks.record('findLeads', leadsRead(4));
    blocks.show({ kind: 'stats', from: 'getAnalytics' });
    blocks.show({ kind: 'leads', from: 'findLeads' });
    expect(
      aiStreamPartSchema.safeParse({ type: 'blocks', blocks: [...blocks.list()] }).success,
    ).toBe(true);
    expect(() =>
      assertAssistantToolPolicy({ showBlock: createShowBlockTool(blocks) }),
    ).not.toThrow();
  });
});
