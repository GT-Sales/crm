import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AutomationRun } from '@gt-sales/contracts';

import { AutomationRuns } from './automation-runs';

const NOW = Date.now();

function run(
  overrides: Partial<AutomationRun> & Pick<AutomationRun, 'id' | 'leadId'>,
): AutomationRun {
  return {
    leadName: null,
    outcome: 'queued',
    reason: null,
    createdAt: new Date(NOW - 5 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

const runs: AutomationRun[] = [
  run({
    id: '40000000-0000-4000-8000-000000000001',
    leadId: '30000000-0000-4000-8000-000000000001',
    leadName: 'Ada Lovelace',
  }),
  run({
    id: '40000000-0000-4000-8000-000000000002',
    leadId: '30000000-0000-4000-8000-000000000002',
    outcome: 'skipped',
    reason: 'no_sender',
    createdAt: new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString(),
  }),
  run({
    id: '40000000-0000-4000-8000-000000000003',
    leadId: '30000000-0000-4000-8000-000000000003',
    leadName: 'Grace Hopper',
    outcome: 'skipped',
    reason: 'missing_fill_in',
  }),
];

describe('AutomationRuns', () => {
  it('lists each run, newest first, with its lead, outcome and time', () => {
    render(<AutomationRuns workspaceSlug="canadawide" runs={runs} />);
    const items = within(screen.getByRole('list', { name: 'Recent runs' })).getAllByRole(
      'listitem',
    );
    expect(items).toHaveLength(3);

    const [first, second, third] = items.map((item) => within(item));
    expect(first?.getByRole('link', { name: 'Ada Lovelace' }).getAttribute('href')).toBe(
      '/w/canadawide/leads/30000000-0000-4000-8000-000000000001',
    );
    expect(first?.getByText('Queued')).toBeTruthy();
    expect(first?.getByText('5m ago')).toBeTruthy();

    expect(second?.getByText('Skipped: no sender')).toBeTruthy();
    expect(second?.getByText('2d ago')).toBeTruthy();
    expect(third?.getByText('Skipped: missing fill-ins')).toBeTruthy();
  });

  it('links a run whose lead the viewer may not name as Open lead', () => {
    render(<AutomationRuns workspaceSlug="canadawide" runs={runs} />);

    expect(screen.getByRole('link', { name: 'Open lead' }).getAttribute('href')).toBe(
      '/w/canadawide/leads/30000000-0000-4000-8000-000000000002',
    );
  });

  it('says when the rule has not run yet', () => {
    render(<AutomationRuns workspaceSlug="canadawide" runs={[]} />);

    expect(screen.getByText('No runs yet.')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });
});
