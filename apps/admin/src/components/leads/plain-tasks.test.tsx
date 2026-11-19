import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListWorkspaceTasksQuery, WorkspaceTask } from '@gt-sales/contracts';

import { todayDay } from '../../lib/dates';
import { MyTasks, TASKS_GROUP_KEY, TASKS_VIEW_KEY } from './my-tasks';
import { addDays } from './tasks-board';

const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const SELF = '20000000-0000-4000-8000-000000000001';
const SAM = '20000000-0000-4000-8000-000000000002';
const TODAY = todayDay();
const REQUEST = '00000000-0000-4000-8000-000000000001';

const mocks = vi.hoisted(() => ({
  listStaffTasks: vi.fn(),
  updateLeadTask: vi.fn(),
  createPlainTask: vi.fn(),
  listWorkspaceMembers: vi.fn(),
}));

const backend = vi.hoisted(() => ({
  BackendError: class extends Error {
    constructor(
      readonly code: string,
      readonly status = 400,
    ) {
      super(code);
    }
  },
}));

vi.mock('../../lib/api', () => ({ ...mocks, ...backend }));

vi.mock('../staff-session-provider', () => ({
  useStaffSession: () => ({
    accessToken: 'staff-token',
    workspaces: [{ id: WORKSPACE, slug: 'canadawide', roles: ['owner'] }],
  }),
}));

function plain(title: string, overrides: Partial<WorkspaceTask> = {}): WorkspaceTask {
  return {
    id: '50000000-0000-4000-8000-000000000101',
    leadId: null,
    title,
    dueAt: `${TODAY}T12:00:00.000Z`,
    assignedActorId: SELF,
    status: 'open',
    completedAt: null,
    createdBy: SELF,
    createdAt: '2026-11-18T09:00:00.000Z',
    updatedAt: '2026-11-18T09:00:00.000Z',
    lead: null,
    ...overrides,
  };
}

const supplier = plain('Call the supplier');
const onLead: WorkspaceTask = {
  ...plain('Send the contract'),
  id: '50000000-0000-4000-8000-000000000102',
  leadId: '90000000-0000-4000-8000-000000000102',
  lead: {
    id: '90000000-0000-4000-8000-000000000102',
    leadType: 'internet',
    stage: 'contacted',
    contact: { fullName: 'Blake Sample' },
    externalRef: null,
  },
};

function serve(active: WorkspaceTask[], manage = true) {
  mocks.listStaffTasks.mockImplementation(
    async (_token: string, _workspace: string, query: ListWorkspaceTasksQuery) => ({
      tasks: query.status === 'done' ? [] : active,
      page: { page: 1, pageSize: 200, total: active.length },
      access: { contacts: true, manage },
      requestId: REQUEST,
    }),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  mocks.listStaffTasks.mockReset();
  mocks.updateLeadTask.mockReset();
  mocks.createPlainTask.mockReset();
  mocks.listWorkspaceMembers.mockResolvedValue({
    members: [
      { actorId: SELF, displayName: 'Takib', roles: ['owner'], isSelf: true },
      { actorId: SAM, displayName: 'Sam Rivers', roles: ['leads'], isSelf: false },
    ],
    requestId: REQUEST,
  });
  serve([supplier, onLead]);
});

describe('plain tasks on the Tasks page', () => {
  it('asks the backend for plain tasks beside the lead tasks', async () => {
    render(<MyTasks workspaceSlug="canadawide" />);
    await screen.findByText('Call the supplier');
    expect(mocks.listStaffTasks).toHaveBeenCalledWith('staff-token', WORKSPACE, {
      assignee: 'me',
      status: 'active',
      plain: 'include',
      pageSize: 200,
    });
  });

  it('shows a plain task with “No lead” in place of a lead, never a link', async () => {
    render(<MyTasks workspaceSlug="canadawide" />);
    const row = (await screen.findByText('Call the supplier')).closest('li');
    if (!row) throw new Error('no row');
    expect(within(row).getByText('No lead')).toBeTruthy();
    expect(within(row).queryByRole('link')).toBeNull();
    const leadRow = screen.getByText('Send the contract').closest('li');
    if (!leadRow) throw new Error('no row');
    expect(within(leadRow).getByRole('link', { name: 'Blake Sample · Internet' })).toBeTruthy();
  });

  it('creates a plain task from the composer with a due day, assigned to the viewer, and shows it at once', async () => {
    const created = plain('Order more SIM cards', {
      id: '50000000-0000-4000-8000-000000000103',
      dueAt: `${addDays(TODAY, 1)}T12:00:00.000Z`,
      assignedActorId: SELF,
    });
    let finish: (value: unknown) => void = () => {};
    mocks.createPlainTask.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    render(<MyTasks workspaceSlug="canadawide" />);
    await screen.findByText('Call the supplier');
    expect(screen.queryByRole('form', { name: 'New task' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));
    const form = screen.getByRole('form', { name: 'New task' });
    const title = within(form).getByRole('textbox', { name: 'Task name' });
    expect(document.activeElement).toBe(title);
    fireEvent.change(title, { target: { value: '  Order more SIM cards ' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Due date: none' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Tomorrow/ }));
    fireEvent.click(within(form).getByRole('button', { name: 'Add task' }));
    // Shown before the backend answers, as a pending card.
    expect(await screen.findByText('Order more SIM cards')).toBeTruthy();
    expect(within(form).getByRole('textbox', { name: 'Task name' })).toHaveProperty('value', '');
    expect(mocks.createPlainTask).toHaveBeenCalledWith('staff-token', WORKSPACE, {
      title: 'Order more SIM cards',
      dueAt: `${addDays(TODAY, 1)}T12:00:00.000Z`,
      assignedActorId: SELF,
    });
    finish({ task: created, requestId: REQUEST });
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('Order more SIM cards'),
    );
  });

  it('takes a refused task back off the list and says why in plain words', async () => {
    mocks.createPlainTask.mockRejectedValue(
      new backend.BackendError('plain_tasks_unavailable', 503),
    );
    render(<MyTasks workspaceSlug="canadawide" />);
    await screen.findByText('Call the supplier');
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));
    const form = screen.getByRole('form', { name: 'New task' });
    fireEvent.change(within(form).getByRole('textbox', { name: 'Task name' }), {
      target: { value: 'Too early' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Add task' }));
    await waitFor(() =>
      expect(mocks.createPlainTask).toHaveBeenCalledWith('staff-token', WORKSPACE, {
        title: 'Too early',
        dueAt: null,
        assignedActorId: SELF,
      }),
    );
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Tasks without a lead are not switched on for this site yet.',
    );
    // Rolled back: no card, and the name is back in the composer.
    expect(screen.queryByText('Too early', { selector: 'p' })).toBeNull();
    expect(within(form).getByRole('textbox', { name: 'Task name' })).toHaveProperty(
      'value',
      'Too early',
    );
  });

  it('offers no New task form to a role that cannot change tasks', async () => {
    serve([supplier], false);
    render(<MyTasks workspaceSlug="canadawide" />);
    await screen.findByText('Call the supplier');
    expect(screen.queryByRole('form', { name: 'New task' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add task' })).toBeNull();
  });

  it('shows a plain task’s board card with “No lead” and moves it to In progress', async () => {
    mocks.updateLeadTask.mockResolvedValue({
      task: { ...supplier, status: 'in_progress' },
      requestId: REQUEST,
    });
    window.localStorage.setItem(TASKS_VIEW_KEY, 'board');
    window.localStorage.setItem(TASKS_GROUP_KEY, 'status');
    render(<MyTasks workspaceSlug="canadawide" />);
    await screen.findByRole('region', { name: 'Tasks board by status' });
    const card = (await screen.findByText('Call the supplier')).closest('li');
    if (!card) throw new Error('no card');
    expect(within(card).getByText('No lead')).toBeTruthy();
    expect(within(card).queryByRole('link')).toBeNull();
    fireEvent.pointerDown(within(card).getByRole('button', { name: 'Move “Call the supplier”' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'In progress' }));
    await waitFor(() =>
      expect(
        within(screen.getByRole('region', { name: /^In progress, 1 task$/ })).getByText(
          'Call the supplier',
        ),
      ).toBeTruthy(),
    );
    expect(mocks.updateLeadTask).toHaveBeenCalledWith('staff-token', WORKSPACE, supplier.id, {
      status: 'in_progress',
    });
  });

  it('completes a plain task from the list like any other', async () => {
    mocks.updateLeadTask.mockResolvedValue({
      task: { ...supplier, status: 'done', completedAt: new Date().toISOString() },
      requestId: REQUEST,
    });
    render(<MyTasks workspaceSlug="canadawide" />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Complete “Call the supplier”' }));
    await waitFor(() =>
      expect(mocks.updateLeadTask).toHaveBeenCalledWith('staff-token', WORKSPACE, supplier.id, {
        status: 'done',
      }),
    );
  });
});
