import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FlowCatalogResponse,
  FlowDefinition,
  FlowDraft,
  FlowDetailResponse,
  FlowRun,
  FlowSummary,
} from '@gt-sales/contracts';

import { FlowPage, NEEDS_LEADS_FOR_ACTIVATION } from './flow-page';

const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const FLOW = 'flow_abcdefghij012345';
const STUDENT = '40000000-0000-4000-8000-000000000001';

const mocks = vi.hoisted(() => {
  class FakeBackendError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }
  const initialRoles: string[] = ['owner'];
  return {
    FakeBackendError,
    roles: initialRoles,
    getAutomation: vi.fn(),
    getAutomationCatalog: vi.fn(),
    getAutomationRun: vi.fn(),
    listAutomationRuns: vi.fn(),
    listAutomations: vi.fn(),
    updateAutomation: vi.fn(),
    saveAutomationDraft: vi.fn(),
    discardAutomationDraft: vi.fn(),
    activateAutomation: vi.fn(),
    resetAutomation: vi.fn(),
    getAutomationVersion: vi.fn(),
    archiveAutomation: vi.fn(),
    restoreAutomation: vi.fn(),
    testAutomation: vi.fn(),
  };
});

vi.mock('../../lib/api', () => ({ ...mocks, BackendError: mocks.FakeBackendError }));

vi.mock('../staff-session-provider', () => ({
  useStaffSession: () => ({
    accessToken: 'staff-token',
    email: 'owner@example.com',
    workspaces: [{ id: WORKSPACE, slug: 'canadawide', roles: mocks.roles }],
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
  versions: [
    { version: 1, status: 'active', activatedAt: '2026-10-31T00:00:00.000Z', activatedBy: null },
  ],
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
  properties: [
    {
      key: 'custom_size',
      label: 'Size',
      kind: 'text',
      leadTypes: ['sim_order'],
      condition: true,
      update: true,
      taskVariable: true,
      emailVariable: true,
    },
  ],
  taskVariables: ['first name', 'order number'],
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
  mocks.roles = ['owner'];
  for (const mock of [
    mocks.getAutomation,
    mocks.getAutomationCatalog,
    mocks.getAutomationRun,
    mocks.listAutomationRuns,
    mocks.listAutomations,
    mocks.updateAutomation,
    mocks.saveAutomationDraft,
    mocks.discardAutomationDraft,
    mocks.activateAutomation,
    mocks.resetAutomation,
    mocks.getAutomationVersion,
    mocks.archiveAutomation,
    mocks.restoreAutomation,
  ]) {
    mock.mockReset();
  }
  mocks.getAutomation.mockResolvedValue(detail());
  mocks.getAutomationCatalog.mockResolvedValue(catalog);
  mocks.listAutomations.mockResolvedValue({
    automations: [summary()],
    nextBefore: null,
    warnings: [],
    canManage: true,
    hasSender: true,
    limit: 50,
    requestId: 'req_test',
  });
  mocks.listAutomationRuns.mockResolvedValue({
    runs: [
      run({
        status: 'waiting',
        resumeAt: '2026-11-03T19:00:00.000Z',
        steps: [
          {
            stepId: 's_if',
            stepKind: 'if_else',
            outcome: 'done',
            branch: 'no',
            reason: null,
            detail: null,
            at: '2026-11-01T12:00:00.000Z',
          },
          {
            stepId: 's_wait',
            stepKind: 'wait',
            outcome: 'waiting',
            branch: null,
            reason: null,
            detail: null,
            at: '2026-11-01T12:00:00.000Z',
          },
        ],
      }),
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

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Promise not initialized');
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function openTaskTitle() {
  fireEvent.click(await screen.findByRole('button', { name: /Create task: Create the task/ }));
  return screen.findByRole('textbox', { name: 'Task title' });
}

describe('FlowPage', () => {
  it('renders the flow on the canvas and toggles to List view reading top to bottom', async () => {
    render(<FlowPage workspaceSlug="canadawide" flowKey={FLOW} />);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Verified follow-up' }),
    ).toBeTruthy();
    expect(await screen.findByRole('region', { name: 'Automation flow canvas' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Trigger: A SIM order moves to Verified' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'If/else: If the plan is Student' })).toBeTruthy();
    expect(screen.getByText('Active, version 1')).toBeTruthy();
    expect(screen.getByText('Draft changes')).toBeTruthy();
    expect(screen.getByText('Viewing draft')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'List view' }));
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
  });

  it('opens the side panel on card click, inserts variables into task titles, saves draft and activates', async () => {
    mocks.saveAutomationDraft.mockImplementation(
      async (_token: string, _ws: string, _key: string, body: { definition: FlowDefinition }) =>
        detail({ revision: 4, draft: { version: 2, definition: body.definition, issues: [] } }),
    );
    mocks.activateAutomation.mockResolvedValue(
      detail({
        automation: summary({ activeVersion: 2, hasDraft: false }),
        revision: 5,
        draft: null,
        active: { version: 2, definition },
      }),
    );

    render(<FlowPage workspaceSlug="canadawide" flowKey={FLOW} />);
    await screen.findByRole('heading', { level: 1, name: 'Verified follow-up' });

    fireEvent.click(
      await screen.findByRole('button', {
        name: /Create task: Create the task "Call \{first name\} about \{order number\}"/,
      }),
    );
    const panel = await screen.findByRole('complementary', { name: 'Create task' });
    const varSelect = within(panel).getByRole('combobox', { name: 'Insert variable' });
    fireEvent.change(varSelect, { target: { value: 'prop:custom_size' } });
    expect(within(panel).getByRole('textbox', { name: 'Task title' })).toHaveProperty(
      'value',
      'Call {first name} about {order number}{prop:custom_size}',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() =>
      expect(mocks.saveAutomationDraft).toHaveBeenCalledWith(
        'staff-token',
        WORKSPACE,
        FLOW,
        expect.objectContaining({ expectedRevision: 3 }),
      ),
    );
    expect(await screen.findByText('Saved')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Activate' }));
    const confirmDialog = await screen.findByRole('dialog', {
      name: 'Activate Verified follow-up?',
    });
    fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Activate' }));
    await waitFor(() =>
      expect(mocks.activateAutomation).toHaveBeenCalledWith('staff-token', WORKSPACE, FLOW, {
        expectedRevision: 4,
      }),
    );
    expect(await screen.findByText('Active, version 2')).toBeTruthy();
  });

  it('adds a step from the + menu by keyboard and closes the side panel on Escape', async () => {
    mocks.saveAutomationDraft.mockResolvedValue(detail({ revision: 4 }));
    render(<FlowPage workspaceSlug="canadawide" flowKey={FLOW} />);
    await screen.findByRole('heading', { level: 1, name: 'Verified follow-up' });

    const addFirst = await screen.findByRole('button', { name: 'Add first step' });
    fireEvent.keyDown(addFirst, { key: 'Enter', code: 'Enter' });
    const menu = await screen.findByRole('menu', { name: 'Add step' });
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Wait' }));

    const panel = await screen.findByRole('complementary', { name: 'Wait' });
    await waitFor(() =>
      expect(document.activeElement).toBe(within(panel).getByRole('heading', { name: /^Wait$/ })),
    );
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(screen.queryByRole('complementary', { name: 'Wait' })).toBeNull();
  });

  it('disables Activate with a reason when the flow changes leads and the viewer lacks the Leads role', async () => {
    mocks.roles = ['orders'];
    render(<FlowPage workspaceSlug="canadawide" flowKey={FLOW} />);
    await screen.findByRole('heading', { level: 1, name: 'Verified follow-up' });

    const activateBtn = screen.getByRole('button', { name: 'Activate' });
    expect(activateBtn.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(NEEDS_LEADS_FOR_ACTIVATION)).toBeTruthy();
  });

  it('opens a staff-notification sample test without asking for a customer email or running immediately', async () => {
    const notification: FlowDefinition = {
      ...definition,
      steps: [
        { id: 's_notify', kind: 'notify_staff', toAssignee: true, actorIds: [], note: 'Follow up' },
      ],
    };
    mocks.getAutomation.mockResolvedValue(
      detail({ draft: { version: 2, definition: notification, issues: [] } }),
    );
    mocks.testAutomation.mockResolvedValue({
      status: 'completed',
      reason: null,
      detail: null,
      steps: [],
      emailsQueued: 0,
      requestId: 'sample_test',
    });
    render(<FlowPage workspaceSlug="canadawide" flowKey={FLOW} />);
    await screen.findByRole('heading', { level: 1, name: 'Verified follow-up' });
    fireEvent.click(screen.getByRole('button', { name: 'Test run' }));
    const dialog = await screen.findByRole('dialog', { name: 'Test run Verified follow-up' });
    expect(within(dialog).queryByLabelText('Test email address')).toBeNull();
    expect(mocks.testAutomation).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run test' }));
    await waitFor(() =>
      expect(mocks.testAutomation).toHaveBeenCalledWith('staff-token', WORKSPACE, FLOW, {
        definition: notification,
      }),
    );
  });

  it('shows the latest runs in words on the Runs tab and expands step outcomes', async () => {
    render(<FlowPage workspaceSlug="canadawide" flowKey={FLOW} />);
    await screen.findByRole('heading', { level: 1, name: 'Verified follow-up' });
    expect(screen.queryByRole('list', { name: 'Recent runs' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('tab', { name: /^Flow$/ }), {
      key: 'ArrowRight',
    });
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /^Runs/ }));
    expect(screen.queryByRole('region', { name: 'What it does' })).toBeNull();

    const runs = await screen.findByRole('list', { name: 'Recent runs' });
    const items = within(runs).getAllByRole('listitem');
    expect(items[0]?.textContent).toContain('Waiting until 3 Nov 14:00');
    expect(items[1]?.textContent).toContain(
      'Skipped: names an email that no longer exists (tpl_gonegonegonegone1)',
    );
    expect(items[2]?.textContent).toContain('Completed');
    expect(mocks.listAutomationRuns).toHaveBeenCalledWith('staff-token', WORKSPACE, FLOW);

    fireEvent.click(within(runs).getByRole('button', { name: 'Steps for Nadia Khan' }));
    const stepOutcomes = within(runs).getByRole('list', { name: 'Step outcomes for Nadia Khan' });
    expect(within(stepOutcomes).getByText('Done (No branch)')).toBeTruthy();
    expect(within(stepOutcomes).getByText('Waiting')).toBeTruthy();
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

  it('a built-in has Reset to default and no Archive; a new flow says No trigger yet', async () => {
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
    expect(screen.getByRole('button', { name: 'Reset to default' })).toBeTruthy();
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
  it('preserves edits made during a save and queues the next write with the returned revision', async () => {
    const first = deferred<FlowDetailResponse>();
    let firstDefinition: FlowDraft = definition;
    mocks.saveAutomationDraft.mockImplementationOnce(
      (_token: string, _ws: string, _key: string, body: { definition: FlowDraft }) => {
        firstDefinition = body.definition;
        return first.promise;
      },
    );
    mocks.saveAutomationDraft.mockImplementationOnce(
      async (_token: string, _ws: string, _key: string, body: { definition: FlowDraft }) =>
        detail({ revision: 5, draft: { version: 2, definition: body.definition, issues: [] } }),
    );
    render(<FlowPage workspaceSlug="canadawide" flowKey={FLOW} />);
    const title = await openTaskTitle();
    fireEvent.change(title, { target: { value: 'First edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(mocks.saveAutomationDraft).toHaveBeenCalledTimes(1));
    fireEvent.change(title, { target: { value: 'Second edit' } });
    // Let the debounce expire while the first network request is still pending.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 650));
    });
    expect(mocks.saveAutomationDraft).toHaveBeenCalledTimes(1);
    await act(async () => {
      first.resolve(
        detail({ revision: 4, draft: { version: 2, definition: firstDefinition, issues: [] } }),
      );
    });
    await waitFor(() => expect(mocks.saveAutomationDraft).toHaveBeenCalledTimes(2));
    expect(mocks.saveAutomationDraft).toHaveBeenLastCalledWith(
      'staff-token',
      WORKSPACE,
      FLOW,
      expect.objectContaining({ expectedRevision: 4 }),
    );
    expect(screen.getByRole('textbox', { name: 'Task title' })).toHaveProperty(
      'value',
      'Second edit',
    );
    expect(await screen.findByText('Saved')).toBeTruthy();
  });

  it('waits for an in-flight save before discarding the draft', async () => {
    const saving = deferred<FlowDetailResponse>();
    mocks.saveAutomationDraft.mockReturnValue(saving.promise);
    mocks.discardAutomationDraft.mockResolvedValue(
      detail({ revision: 5, draft: null, automation: summary({ hasDraft: false }) }),
    );
    render(<FlowPage workspaceSlug="canadawide" flowKey={FLOW} />);
    const title = await openTaskTitle();
    fireEvent.change(title, { target: { value: 'Discard this edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(mocks.saveAutomationDraft).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
    expect(mocks.discardAutomationDraft).not.toHaveBeenCalled();
    await act(async () => {
      saving.resolve(detail({ revision: 4 }));
    });
    await waitFor(() => expect(mocks.discardAutomationDraft).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Viewing active')).toBeTruthy();
  });

  it('offers Reload for the backend revision_conflict and keeps unsaved edits', async () => {
    mocks.saveAutomationDraft.mockRejectedValue(new mocks.FakeBackendError('revision_conflict'));
    render(<FlowPage workspaceSlug="canadawide" flowKey={FLOW} />);
    const title = await openTaskTitle();
    fireEvent.change(title, { target: { value: 'My unsaved edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(title).toHaveProperty('value', 'My unsaved edit');
  });

  it('ignores an old version response after returning to the editor', async () => {
    const version = deferred<{ version: { definition: FlowDefinition } }>();
    mocks.getAutomationVersion.mockReturnValue(version.promise);
    render(<FlowPage workspaceSlug="canadawide" flowKey={FLOW} />);
    const selector = await screen.findByRole('combobox', { name: 'View version' });
    fireEvent.change(selector, { target: { value: '1' } });
    fireEvent.change(selector, { target: { value: 'editor' } });
    await act(async () => {
      version.resolve({ version: { definition } });
    });
    expect(screen.queryByText('Viewing version 1')).toBeNull();
    expect(screen.getByText('Viewing draft')).toBeTruthy();
  });
  it('keeps editing controls visible and disabled for readers', async () => {
    mocks.getAutomation.mockResolvedValue(detail({ canManage: false }));
    render(<FlowPage workspaceSlug="canadawide" flowKey={FLOW} />);
    expect(await screen.findByRole('button', { name: 'Activate' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: 'Save draft' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Discard draft' })).toHaveProperty('disabled', true);
    expect(mocks.saveAutomationDraft).not.toHaveBeenCalled();
  });

  it('saves an edit still waiting for autosave when the page is left, and guards a reload (UI-3)', async () => {
    mocks.saveAutomationDraft.mockImplementation(
      async (_token: string, _ws: string, _key: string, body: { definition: FlowDraft }) =>
        detail({ revision: 4, draft: { version: 2, definition: body.definition, issues: [] } }),
    );
    const { unmount } = render(<FlowPage workspaceSlug="canadawide" flowKey={FLOW} />);
    fireEvent.click(await screen.findByRole('button', { name: 'List view' }));
    fireEvent.click(screen.getByRole('button', { name: 'Wait 2 days' }));
    const panel = await screen.findByRole('complementary', { name: 'Wait' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Move down' }));

    // Inside the autosave delay a reload asks first.
    const reload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(reload);
    expect(reload.defaultPrevented).toBe(true);

    // Leaving the page before the delay ends still saves the edit, once.
    unmount();
    await waitFor(() => expect(mocks.saveAutomationDraft).toHaveBeenCalledTimes(1));
    expect(mocks.saveAutomationDraft).toHaveBeenCalledWith(
      'staff-token',
      WORKSPACE,
      FLOW,
      expect.objectContaining({
        definition: expect.objectContaining({
          steps: [
            expect.objectContaining({
              else: [
                expect.objectContaining({ id: 's_mail' }),
                expect.objectContaining({ id: 's_wait' }),
              ],
            }),
          ],
        }),
      }),
    );
    const after = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it('edits and moves steps from List view using the same side panel', async () => {
    mocks.saveAutomationDraft.mockImplementation(
      async (_token: string, _ws: string, _key: string, body: { definition: FlowDraft }) =>
        detail({ revision: 4, draft: { version: 2, definition: body.definition, issues: [] } }),
    );
    render(<FlowPage workspaceSlug="canadawide" flowKey={FLOW} />);
    fireEvent.click(await screen.findByRole('button', { name: 'List view' }));
    fireEvent.click(screen.getByRole('button', { name: 'Wait 2 days' }));
    const panel = await screen.findByRole('complementary', { name: 'Wait' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Move down' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() =>
      expect(mocks.saveAutomationDraft).toHaveBeenCalledWith(
        'staff-token',
        WORKSPACE,
        FLOW,
        expect.objectContaining({
          definition: expect.objectContaining({
            steps: [
              expect.objectContaining({
                else: [
                  expect.objectContaining({ id: 's_mail' }),
                  expect.objectContaining({ id: 's_wait' }),
                ],
              }),
            ],
          }),
        }),
      ),
    );
    fireEvent.keyDown(panel, { key: 'Escape' });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Wait 2 days' })),
    );
  });
  it('can switch the active flow off even when the draft has a revision conflict', async () => {
    mocks.getAutomation.mockResolvedValue(detail({ automation: summary({ enabled: true }) }));
    mocks.saveAutomationDraft.mockRejectedValue(new mocks.FakeBackendError('revision_conflict'));
    mocks.updateAutomation.mockResolvedValue({ automation: summary({ enabled: false }) });
    render(<FlowPage workspaceSlug="canadawide" flowKey={FLOW} />);
    const title = await openTaskTitle();
    fireEvent.change(title, { target: { value: 'My unsaved edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByRole('button', { name: 'Reload' });
    fireEvent.click(screen.getByRole('switch', { name: 'Verified follow-up' }));
    await waitFor(() =>
      expect(mocks.updateAutomation).toHaveBeenCalledWith('staff-token', WORKSPACE, FLOW, {
        enabled: false,
      }),
    );
    expect(screen.getByRole('textbox', { name: 'Task title' })).toHaveProperty(
      'value',
      'My unsaved edit',
    );
  });

  it('saves pending edits before archiving and refuses archive when that save fails', async () => {
    mocks.saveAutomationDraft.mockRejectedValue(new mocks.FakeBackendError('revision_conflict'));
    render(<FlowPage workspaceSlug="canadawide" flowKey={FLOW} />);
    const title = await openTaskTitle();
    fireEvent.change(title, { target: { value: 'Keep this edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('dialog', { name: 'Archive Verified follow-up?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));
    expect(await within(dialog).findByRole('alert')).toHaveProperty(
      'textContent',
      'The draft was not saved. Save or reload it before archiving.',
    );
    expect(mocks.saveAutomationDraft).toHaveBeenCalledTimes(1);
    expect(mocks.archiveAutomation).not.toHaveBeenCalled();
  });

  it('sends test email only to the signed-in member and never asks for an address', async () => {
    mocks.testAutomation.mockResolvedValue({
      status: 'completed',
      reason: null,
      detail: null,
      emailsQueued: 1,
      steps: [
        {
          stepId: 's_if',
          stepKind: 'if_else',
          outcome: 'done',
          branch: 'no',
          reason: null,
          detail: null,
          at: '2026-11-01T12:00:00.000Z',
        },
        {
          stepId: 's_mail',
          stepKind: 'send_email',
          outcome: 'done',
          branch: null,
          reason: null,
          detail: 'activated',
          at: '2026-11-01T12:00:01.000Z',
        },
      ],
      requestId: 'req_test_run',
    });

    render(<FlowPage workspaceSlug="canadawide" flowKey={FLOW} />);
    await screen.findByRole('heading', { level: 1, name: 'Verified follow-up' });

    fireEvent.click(screen.getByRole('button', { name: 'Test run' }));
    const dialog = await screen.findByRole('dialog', { name: 'Test run Verified follow-up' });
    expect(within(dialog).queryByLabelText('Test email address')).toBeNull();
    expect(within(dialog).getByText('owner@example.com')).toBeTruthy();
    const runBtn = within(dialog).getByRole('button', { name: 'Run test' });
    expect(runBtn.hasAttribute('disabled')).toBe(false);
    fireEvent.click(runBtn);

    await waitFor(() =>
      expect(mocks.testAutomation).toHaveBeenCalledWith(
        'staff-token',
        WORKSPACE,
        FLOW,
        expect.objectContaining({ sendEmail: true }),
      ),
    );
    expect(await within(dialog).findByText('Test run completed')).toBeTruthy();
    expect(within(dialog).getByText('1 test email queued to owner@example.com')).toBeTruthy();
    expect(mocks.testAutomation.mock.calls.at(-1)?.[3]).not.toHaveProperty('email');
    expect(within(dialog).getByText('Sample took No branch')).toBeTruthy();
  });
});
