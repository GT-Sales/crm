import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { FlowRun } from '@gt-sales/contracts';

import { AutomationRuns } from './automation-runs';

const NOW = Date.now();

function run(overrides: Partial<FlowRun> & Pick<FlowRun, 'id' | 'leadId'>): FlowRun {
  return {
    leadName: null,
    status: 'completed',
    reason: null,
    detail: null,
    triggerKind: 'stage_entered',
    version: 1,
    startedAt: new Date(NOW - 5 * 60 * 1000).toISOString(),
    finishedAt: new Date(NOW - 5 * 60 * 1000).toISOString(),
    resumeAt: null,
    legacy: false,
    steps: [],
    ...overrides,
  };
}

const runs: FlowRun[] = [
  run({
    id: '40000000-0000-4000-8000-000000000001',
    leadId: '30000000-0000-4000-8000-000000000001',
    leadName: 'Ada Lovelace',
    status: 'waiting',
    resumeAt: '2026-11-03T19:00:00.000Z',
    finishedAt: null,
    version: 2,
  }),
  run({
    id: '40000000-0000-4000-8000-000000000002',
    leadId: '3abcdef0-0000-4000-8000-000000000002',
    status: 'skipped',
    reason: 'stage_unavailable',
    detail: 'paid',
    startedAt: new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString(),
  }),
  run({
    id: '40000000-0000-4000-8000-000000000003',
    leadId: '30000000-0000-4000-8000-000000000003',
    leadName: 'Grace Hopper',
    legacy: true,
    version: null,
    triggerKind: null,
  }),
];

describe('AutomationRuns', () => {
  it('lists each run with its lead, status in words, version and time', () => {
    render(<AutomationRuns workspaceSlug="canadawide" runs={runs} />);
    const items = within(screen.getByRole('list', { name: 'Recent runs' })).getAllByRole(
      'listitem',
    );
    expect(items).toHaveLength(3);

    const [first, second, third] = items.map((item) => within(item));
    expect(first?.getByRole('link', { name: 'Ada Lovelace' }).getAttribute('href')).toBe(
      '/w/canadawide/leads/30000000-0000-4000-8000-000000000001',
    );
    expect(first?.getByText('Waiting until 3 Nov 14:00')).toBeTruthy();
    expect(first?.getByText('Version 2')).toBeTruthy();
    expect(first?.getByText('5m ago')).toBeTruthy();

    expect(second?.getByText('Skipped: names a stage that no longer exists (paid)')).toBeTruthy();
    expect(second?.getByText('2d ago')).toBeTruthy();
    // A phase 4 run reads as completed, with no version.
    expect(third?.getByText('Completed')).toBeTruthy();
    expect(third?.queryByText(/Version/)).toBeNull();
  });

  it('names a lead the viewer may not see by the start of its id', () => {
    render(<AutomationRuns workspaceSlug="canadawide" runs={runs} />);
    expect(screen.getByRole('link', { name: 'Lead 3abcdef0' }).getAttribute('href')).toBe(
      '/w/canadawide/leads/3abcdef0-0000-4000-8000-000000000002',
    );
  });

  it('says when the flow has not run yet', () => {
    render(<AutomationRuns workspaceSlug="canadawide" runs={[]} />);
    expect(screen.getByText('No runs yet.')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });
});
