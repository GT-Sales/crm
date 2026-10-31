import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUILT_IN_AUTOMATION_KEYS,
  builtInFlowDefinition,
  builtInFlowName,
  type FlowListResponse,
  type FlowSummary,
} from '@gt-sales/contracts';

import { SiteAutomations } from './automations-list';

const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const CUSTOM = 'flow_abcdefghij012345';
const ARCHIVED = 'flow_archivedflow0001';
const ORDER_RECEIVED = builtInFlowName('order_received');
const DISPATCHED = builtInFlowName('sim_order_dispatched');

const mocks = vi.hoisted(() => {
  class FakeBackendError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }
  return {
    FakeBackendError,
    listAutomations: vi.fn(),
    updateAutomation: vi.fn(),
    createAutomation: vi.fn(),
    restoreAutomation: vi.fn(),
    push: vi.fn(),
  };
});

vi.mock('../../lib/api', () => ({
  listAutomations: mocks.listAutomations,
  updateAutomation: mocks.updateAutomation,
  createAutomation: mocks.createAutomation,
  restoreAutomation: mocks.restoreAutomation,
  BackendError: mocks.FakeBackendError,
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));

vi.mock('../staff-session-provider', () => ({
  useStaffSession: () => ({
    accessToken: 'staff-token',
    workspaces: [{ id: WORKSPACE, slug: 'canadawide', roles: ['owner'] }],
  }),
}));

function builtIn(
  key: (typeof BUILT_IN_AUTOMATION_KEYS)[number],
  overrides: Partial<FlowSummary> = {},
): FlowSummary {
  return {
    key,
    origin: 'builtin',
    name: builtInFlowName(key),
    description: null,
    enabled: false,
    archived: false,
    trigger: builtInFlowDefinition(key).trigger,
    activeVersion: 1,
    hasDraft: false,
    lastRunAt: null,
    runCount: 0,
    needsAttention: null,
    ...overrides,
  };
}

const custom = (overrides: Partial<FlowSummary> = {}): FlowSummary => ({
  key: CUSTOM,
  origin: 'custom',
  name: 'Verified follow-up',
  description: null,
  enabled: false,
  archived: false,
  trigger: null,
  activeVersion: null,
  hasDraft: true,
  lastRunAt: null,
  runCount: 0,
  needsAttention: null,
  ...overrides,
});

function answer(overrides: Partial<FlowListResponse> = {}): FlowListResponse {
  return {
    automations: [
      ...BUILT_IN_AUTOMATION_KEYS.map((key) =>
        builtIn(key, {
          ...(key === 'sim_order_dispatched'
            ? { needsAttention: { path: 'trigger.stage', code: 'stage_unavailable', ref: 'paid' } }
            : {}),
          ...(key === 'sim_order_activated' ? { hasDraft: true } : {}),
        }),
      ),
      custom(),
    ],
    nextBefore: null,
    warnings: [
      {
        event: { kind: 'stage_entered', leadType: 'sim_order', stage: 'delivered' },
        flows: [
          { key: 'sim_order_dispatched', name: DISPATCHED },
          { key: CUSTOM, name: 'Verified follow-up' },
        ],
        message: `Customers get 2 emails when a SIM order moves to Delivered: ${DISPATCHED}, Verified follow-up.`,
      },
    ],
    canManage: true,
    hasSender: true,
    limit: 50,
    requestId: 'req_test',
    ...overrides,
  };
}

const table = () => screen.findByRole('table', { name: 'Automation flows' });
const row = (name: string) => {
  const item = screen.getByRole('link', { name }).closest('tr');
  if (!item) throw new Error(`no row for ${name}`);
  return item;
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    if (typeof mock === 'function' && 'mockReset' in mock) mock.mockReset();
  }
  mocks.listAutomations.mockResolvedValue(answer());
});

describe('SiteAutomations', () => {
  it('lists every flow in a table, the six built in, with When in words, chips and warnings', async () => {
    render(<SiteAutomations workspaceSlug="canadawide" />);
    const flows = await table();
    expect(mocks.listAutomations).toHaveBeenCalledWith('staff-token', WORKSPACE);
    const headers = within(flows)
      .getAllByRole('columnheader')
      .map((cell) => cell.textContent);
    expect(headers).toEqual(['Name', 'When', 'On', 'Last run', 'Runs', 'Status']);
    const rows = within(flows).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(7);
    expect(within(flows).getAllByText('Built in')).toHaveLength(6);
    expect(row(ORDER_RECEIVED).textContent).toContain(
      'A SIM order, an internet lead or a mobility order is submitted',
    );
    expect(within(row(DISPATCHED)).getByText('A SIM order moves to Delivered')).toBeTruthy();
    expect(within(row('Verified follow-up')).getByText('No trigger yet')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Verified follow-up' }).getAttribute('href')).toBe(
      `/w/canadawide/automations/${CUSTOM}`,
    );

    expect(
      within(row(DISPATCHED)).getByText(
        'Needs attention: names a stage that no longer exists (paid)',
      ),
    ).toBeTruthy();
    expect(within(row('Verified follow-up')).getByText('Not activated')).toBeTruthy();
    expect(
      within(row(builtInFlowName('sim_order_activated'))).getByText('Draft changes'),
    ).toBeTruthy();
    expect(
      screen.getByText(
        `Customers get 2 emails when a SIM order moves to Delivered: ${DISPATCHED}, Verified follow-up.`,
      ),
    ).toBeTruthy();
    expect(within(row(ORDER_RECEIVED)).getByText('Never')).toBeTruthy();
  });

  it('disables the switch of a flow with no active version, saying why', async () => {
    render(<SiteAutomations workspaceSlug="canadawide" />);
    await table();
    const control = within(row('Verified follow-up')).getByRole('switch', {
      name: 'Verified follow-up',
    });
    expect(control.hasAttribute('disabled')).toBe(true);
    const note = within(row('Verified follow-up')).getByText('Activate the flow first.');
    expect(control.getAttribute('aria-describedby')).toBe(note.id);
    fireEvent.click(control);
    expect(mocks.updateAutomation).not.toHaveBeenCalled();
  });

  it('is read-only for a member who cannot manage the flows', async () => {
    mocks.listAutomations.mockResolvedValue(
      answer({
        canManage: false,
        automations: [builtIn('order_received', { enabled: true }), custom()],
      }),
    );
    render(<SiteAutomations workspaceSlug="canadawide" />);
    const note = await screen.findByText(
      'This needs the Integrations permission (the owner has it).',
    );
    for (const control of screen.getAllByRole('switch')) {
      expect(control.hasAttribute('disabled')).toBe(true);
      expect(control.getAttribute('aria-describedby')).toBe(note.id);
    }
    expect(screen.getByRole('switch', { name: ORDER_RECEIVED }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(screen.queryByRole('button', { name: 'New flow' })).toBeNull();
  });

  it('switches a flow on, and keeps the confirmed state when a later change fails', async () => {
    mocks.updateAutomation.mockResolvedValueOnce({
      automation: builtIn('order_received', { enabled: true, runCount: 4 }),
      requestId: 'req_test',
    });
    mocks.updateAutomation.mockRejectedValueOnce(new mocks.FakeBackendError('internal_error'));
    render(<SiteAutomations workspaceSlug="canadawide" />);
    await table();
    const control = screen.getByRole('switch', { name: ORDER_RECEIVED });

    // The list is read again after a switch (the overlap warnings follow what is on).
    mocks.listAutomations.mockResolvedValue(
      answer({
        automations: [builtIn('order_received', { enabled: true, runCount: 4 }), custom()],
      }),
    );
    fireEvent.click(control);
    await waitFor(() =>
      expect(mocks.updateAutomation).toHaveBeenCalledWith(
        'staff-token',
        WORKSPACE,
        'order_received',
        { enabled: true },
      ),
    );
    await waitFor(() => expect(mocks.listAutomations).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.getByRole('switch', { name: ORDER_RECEIVED }).getAttribute('aria-checked'),
      ).toBe('true'),
    );
    expect(within(row(ORDER_RECEIVED)).getByText('4')).toBeTruthy();

    fireEvent.click(screen.getByRole('switch', { name: ORDER_RECEIVED }));
    expect((await within(row(ORDER_RECEIVED)).findByRole('alert')).textContent).toBe(
      'The change was not saved. Reason: internal_error.',
    );
    expect(screen.getByRole('switch', { name: ORDER_RECEIVED }).getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('makes a new flow by keyboard and opens its page', async () => {
    mocks.createAutomation.mockResolvedValue({
      automation: custom({ key: 'flow_newflow000000001' }),
    });
    render(<SiteAutomations workspaceSlug="canadawide" />);
    await table();
    const open = screen.getByRole('button', { name: 'New flow' });
    open.focus();
    fireEvent.click(open);
    const dialog = await screen.findByRole('dialog', { name: 'New flow' });
    const name = within(dialog).getByLabelText('Name');
    fireEvent.change(name, { target: { value: '  Verified follow-up ' } });
    fireEvent.submit(name.closest('form') ?? name);
    await waitFor(() =>
      expect(mocks.createAutomation).toHaveBeenCalledWith('staff-token', WORKSPACE, {
        name: 'Verified follow-up',
      }),
    );
    await waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith('/w/canadawide/automations/flow_newflow000000001'),
    );
  });

  it('says why a new flow was refused at the limit', async () => {
    mocks.createAutomation.mockRejectedValue(
      new mocks.FakeBackendError('automation_limit_reached'),
    );
    render(<SiteAutomations workspaceSlug="canadawide" />);
    await table();
    fireEvent.click(screen.getByRole('button', { name: 'New flow' }));
    const dialog = await screen.findByRole('dialog', { name: 'New flow' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'One more' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'This site already has 50 flows. Archive one first.',
    );
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('opens the archived flows and restores one', async () => {
    mocks.listAutomations.mockImplementation(
      async (_token: string, _workspace: string, query?: { archived?: string }) =>
        query?.archived === '1'
          ? answer({
              automations: [custom({ key: ARCHIVED, name: 'Old flow', archived: true })],
              warnings: [],
            })
          : answer(),
    );
    mocks.restoreAutomation.mockResolvedValue({});
    render(<SiteAutomations workspaceSlug="canadawide" />);
    await table();
    const disclosure = screen.getByRole('button', { name: 'Archived flows' });
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(disclosure);
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    const archived = await screen.findByRole('list', { name: 'Archived flows' });
    expect(within(archived).getByText('Old flow')).toBeTruthy();
    expect(mocks.listAutomations).toHaveBeenCalledWith('staff-token', WORKSPACE, { archived: '1' });

    fireEvent.click(within(archived).getByRole('button', { name: 'Restore Old flow' }));
    await waitFor(() =>
      expect(mocks.restoreAutomation).toHaveBeenCalledWith('staff-token', WORKSPACE, ARCHIVED),
    );
  });

  it('shows the no-sender notice and a load error with Try again', async () => {
    mocks.listAutomations.mockResolvedValueOnce(answer({ hasSender: false, warnings: [] }));
    const { unmount } = render(<SiteAutomations workspaceSlug="canadawide" />);
    expect(
      await screen.findByText(
        'Switch an email on once Settings → Email is saved; until then every run is skipped.',
      ),
    ).toBeTruthy();
    unmount();

    mocks.listAutomations.mockRejectedValueOnce(new mocks.FakeBackendError('internal_error'));
    render(<SiteAutomations workspaceSlug="canadawide" />);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The automations could not be loaded. Reason: internal_error.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await table()).toBeTruthy();
  });
});
