import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FlowCatalogResponse,
  FlowDefinition,
  FlowDetailResponse,
  FlowRun,
  FlowSummary,
} from '@gt-sales/contracts';

import { FlowPage } from './flow-page';

const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const FLOW = 'flow_abcdefghij012345';
const STUDENT = '40000000-0000-4000-8000-000000000001';

const mocks = vi.hoisted(() => {
  class FakeBackendError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }
  return {
    FakeBackendError,
    getAutomation: vi.fn(),
    getAutomationCatalog: vi.fn(),
    listAutomationRuns: vi.fn(),
    updateAutomation: vi.fn(),
    archiveAutomation: vi.fn(),
    restoreAutomation: vi.fn(),
  };
});

vi.mock('../../lib/api', () => ({ ...mocks, BackendError: mocks.FakeBackendError }));

vi.mock('../staff-session-provider', () => ({
  useStaffSession: () => ({
    accessToken: 'staff-token',
    workspaces: [{ id: WORKSPACE, slug: 'canadawide', roles: ['owner'] }],
  }),
}));

const definition: FlowDefinition = {
  schemaVersion: 1,
  trigger: {
    kind: 'stage_entered',
    leadType: 'sim_order',
    stage: 'verified',
    when: { match: 'all', items: [{ kind: 'plan', op: 'in', planIds: [STUDENT] }] },
  },
  steps: [
    {
      id: 's_if',
      kind: 'if_else',
      condition: { match: 'all', items: [{ kind: 'plan', op: 'in', planIds: [STUDENT] }] },
      then: [
        {
          id: 's_task',
          kind: 'create_task',
          title: 'Call {first name} about {order number}',
          dueInDays: 1,
          assignee: { kind: 'lead_assignee' },
        },
      ],
      else: [
        { id: 's_wait', kind: 'wait', for: { amount: 2, unit: 'days' } },
        { id: 's_mail', kind: 'send_email', template: 'activated' },
      ],
    },
  ],
};

const summary = (overrides: Partial<FlowSummary> = {}): FlowSummary => ({
  key: FLOW,
  origin: 'custom',
  name: 'Verified follow-up',
  description: null,
  enabled: false,
  archived: false,
  trigger: definition.trigger,
  activeVersion: 1,
  hasDraft: true,
  lastRunAt: null,
  runCount: 2,
  needsAttention: null,
  ...overrides,
});

const detail = (overrides: Partial<FlowDetailResponse> = {}): FlowDetailResponse => ({
  automation: summary(),
  revision: 3,
  draft: { version: 2, definition, issues: [] },
  active: { version: 1, definition },
  versions: [],
  canManage: true,
  requestId: 'req_test',
  ...overrides,
});

const catalog: FlowCatalogResponse = {
  leadTypes: [
    {
      key: 'sim_order',
      label: 'SIM order',
      stages: [
        { key: 'pending', label: 'Pending' },
        { key: 'verified', label: 'Verified' },
      ],
    },
  ],
  templates: [{ key: 'activated', name: 'Activated', builtIn: true, archived: false, fillIns: [] }],
  members: [],
  plans: [{ id: STUDENT, name: 'Student', leadType: 'sim_order', active: true }],
  properties: [],
  taskVariables: [],
  requestId: 'req_test',
};

const run = (overrides: Partial<FlowRun>): FlowRun => ({
  id: '50000000-0000-4000-8000-000000000001',
  leadId: '30000000-0000-4000-8000-000000000001',
  leadName: 'Nadia Khan',
  status: 'completed',
  reason: null,
  detail: null,
  triggerKind: 'stage_entered',
  version: 1,
  startedAt: '2026-11-01T12:00:00.000Z',
  finishedAt: null,
  resumeAt: null,
  legacy: false,
  steps: [],
  ...overrides,
});

beforeEach(() => {
  for (const mock of [
    mocks.getAutomation,
    mocks.getAutomationCatalog,
    mocks.listAutomationRuns,
    mocks.updateAutomation,
    mocks.archiveAutomation,
    mocks.restoreAutomation,
  ]) {
    mock.mockReset();
  }
  mocks.getAutomation.mockResolvedValue(detail());
  mocks.getAutomationCatalog.mockResolvedValue(catalog);
  mocks.listAutomationRuns.mockResolvedValue({
    runs: [
      run({ status: 'waiting', resumeAt: '2026-11-03T19:00:00.000Z' }),
      run({
        id: '50000000-0000-4000-8000-000000000002',
        status: 'skipped',
        reason: 'template_unavailable',
        detail: 'tpl_gonegonegonegone1',
      }),
      run({ id: '50000000-0000-4000-8000-000000000003', legacy: true, version: null }),
    ],
    nextBefore: null,
    requestId: 'req_test',
  });
});

describe('FlowPage', () => {
  it('reads the active definition top to bottom, branches labelled Yes and No', async () => {
    render(<FlowPage workspaceSlug="canadawide" flowKey={FLOW} />);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Verified follow-up' }),
    ).toBeTruthy();
    const region = screen.getByRole('region', { name: 'What it does' });
    const text = region.textContent ?? '';
    const order = [
      'When a SIM order moves to Verified',
      'Only when the plan is Student',
      'If the plan is Student',
      'Yes',
      'Create the task "Call {first name} about {order number}" due in 1 day for the lead\'s owner',
      'No',
      'Wait 2 days',
      'Send the Activated email',
    ];
    let at = 0;
    for (const words of order) {
      const found = text.indexOf(words, at);
      expect(found, words).toBeGreaterThanOrEqual(0);
      at = found + words.length;
    }
    expect(within(region).getByRole('list', { name: 'Yes' })).toBeTruthy();
    expect(within(region).getByRole('list', { name: 'No' })).toBeTruthy();
    expect(screen.getByText('Active, version 1')).toBeTruthy();
    expect(screen.getByText('Draft changes')).toBeTruthy();
    expect(
      screen.getByText('There are draft changes; the editor arrives in a later release.'),
    ).toBeTruthy();
  });

  it('shows the latest runs in words', async () => {
    render(<FlowPage workspaceSlug="canadawide" flowKey={FLOW} />);
    const runs = await screen.findByRole('list', { name: 'Recent runs' });
    const items = within(runs).getAllByRole('listitem');
    expect(items[0]?.textContent).toContain('Waiting until 3 Nov 14:00');
    expect(items[1]?.textContent).toContain(
      'Skipped: names an email that no longer exists (tpl_gonegonegonegone1)',
    );
    expect(items[2]?.textContent).toContain('Completed');
    expect(mocks.listAutomationRuns).toHaveBeenCalledWith('staff-token', WORKSPACE, FLOW);
  });

  it('asks before archiving, then shows the flow archived', async () => {
    mocks.archiveAutomation.mockResolvedValue(
      detail({ automation: summary({ archived: true, enabled: false }) }),
    );
    render(<FlowPage workspaceSlug="canadawide" flowKey={FLOW} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('dialog', { name: 'Archive Verified follow-up?' });
    expect(mocks.archiveAutomation).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));
    await waitFor(() =>
      expect(mocks.archiveAutomation).toHaveBeenCalledWith('staff-token', WORKSPACE, FLOW),
    );
    expect(await screen.findByRole('button', { name: 'Restore' })).toBeTruthy();
    expect(screen.getByText('Archived')).toBeTruthy();
  });

  it('a built-in has no Archive; a new flow says No trigger yet', async () => {
    mocks.getAutomation.mockResolvedValue(
      detail({
        automation: summary({ origin: 'builtin', activeVersion: null, trigger: null }),
        active: null,
        draft: {
          version: 1,
          definition: { schemaVersion: 1, trigger: null, steps: [] },
          issues: [],
        },
      }),
    );
    render(<FlowPage workspaceSlug="canadawide" flowKey="order_received" />);
    expect(await screen.findByText('No trigger yet.')).toBeTruthy();
    expect(screen.getByText('Built in')).toBeTruthy();
    expect(screen.getByText('Not activated')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
  });

  it('opens a flow whose active version can no longer be read', async () => {
    mocks.getAutomation.mockResolvedValue(
      detail({
        automation: summary({
          trigger: null,
          needsAttention: { path: 'definition', code: 'definition_invalid', ref: 'definition' },
        }),
        active: { version: 1, definition: null },
        draft: null,
      }),
    );
    render(<FlowPage workspaceSlug="canadawide" flowKey={FLOW} />);
    expect(await screen.findByText('Needs attention: the flow can no longer be read')).toBeTruthy();
    expect(
      screen.getByText('This version can no longer be read. Check the flow for what changed.'),
    ).toBeTruthy();
  });

  it('says why the flow could not be loaded, with Try again', async () => {
    mocks.getAutomation.mockRejectedValueOnce(new mocks.FakeBackendError('automation_not_found'));
    render(<FlowPage workspaceSlug="canadawide" flowKey={FLOW} />);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The automation could not be loaded. Reason: automation_not_found.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Verified follow-up' }),
    ).toBeTruthy();
  });
});
