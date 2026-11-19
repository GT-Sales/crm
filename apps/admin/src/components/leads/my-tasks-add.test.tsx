import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceTask } from '@gt-sales/contracts';

import { addDays, todayDay } from '../../lib/dates';
import { MyTasks, TASKS_GROUP_KEY, TASKS_VIEW_KEY } from './my-tasks';

const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const SELF = '20000000-0000-4000-8000-000000000001';
const REQUEST = '00000000-0000-4000-8000-000000000001';
const LEAD = '90000000-0000-4000-8000-000000000102';
const TODAY = todayDay();

const mocks = vi.hoisted(() => ({
  listStaffTasks: vi.fn(),
  updateLeadTask: vi.fn(),
  createPlainTask: vi.fn(),
  createLeadTask: vi.fn(),
  getStaffLeads: vi.fn(),
  listWorkspaceMembers: vi.fn(),
}));

vi.mock('../../lib/api', () => ({
  ...mocks,
  BackendError: class extends Error {},
}));
vi.mock('../staff-session-provider', () => ({
  useStaffSession: () => ({
    accessToken: 'staff-token',
    workspaces: [{ id: WORKSPACE, slug: 'canadawide', roles: ['owner'] }],
  }),
}));

function saved(title: string, dueAt: string | null, leadId: string | null = null): WorkspaceTask {
  return {
    id: '50000000-0000-4000-8000-0000000001ff',
    leadId,
    title,
    dueAt,
    assignedActorId: SELF,
    status: 'open',
    completedAt: null,
    createdBy: SELF,
    createdAt: '2026-11-19T09:00:00.000Z',
    updatedAt: '2026-11-19T09:00:00.000Z',
    lead: null,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.listWorkspaceMembers.mockResolvedValue({
    members: [{ actorId: SELF, displayName: 'Takib', roles: ['owner'], isSelf: true }],
    requestId: REQUEST,
  });
  mocks.listStaffTasks.mockImplementation(async () => ({
    tasks: [],
    page: { page: 1, pageSize: 200, total: 0 },
    access: { contacts: true, manage: true },
    requestId: REQUEST,
  }));
  mocks.getStaffLeads.mockResolvedValue({
    leads: [
      {
        id: LEAD,
        leadType: 'internet',
        stage: 'new',
        contact: { fullName: 'Blake Sample' },
        externalRef: 'MS-101',
      },
    ],
    page: { page: 1, pageSize: 8, total: 1 },
    access: { contacts: true, manage: true },
    requestId: REQUEST,
  });
});

async function ready() {
  render(<MyTasks workspaceSlug="canadawide" />);
  await screen.findByText(/Nothing due/);
}

describe('adding tasks on the Tasks page', () => {
  it('opens the composer with the C key, but never while typing in a field', async () => {
    await ready();
    fireEvent.keyDown(document.body, { key: 'c' });
    const title = await screen.findByRole('textbox', { name: 'Task name' });
    await waitFor(() => expect(document.activeElement).toBe(title));
    // Typing a "c" in the name is typing, not a shortcut.
    fireEvent.keyDown(title, { key: 'c' });
    expect(screen.getAllByRole('form', { name: 'New task' })).toHaveLength(1);
    fireEvent.keyDown(title, { key: 'Escape' });
    expect(screen.queryByRole('form', { name: 'New task' })).toBeNull();
    // Focus returns to the control that opens it.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add task' })),
    );
    // Not inside any other field, and not with a modifier key.
    const other = document.createElement('input');
    document.body.append(other);
    fireEvent.keyDown(other, { key: 'c' });
    fireEvent.keyDown(document.body, { key: 'c', ctrlKey: true });
    expect(screen.queryByRole('form', { name: 'New task' })).toBeNull();
    other.remove();
  });

  it('has the C shortcut live in the very commit that shows the Add task button', async () => {
    // A key pressed the instant the button can be seen must not be lost: a
    // listener attached only after paint would miss it (seen on a loaded CI runner).
    let formWhenButtonAppeared: boolean | undefined;
    const watcher = new MutationObserver(() => {
      if (formWhenButtonAppeared !== undefined) return;
      const button = [...document.querySelectorAll('button')].find((item) =>
        item.textContent?.startsWith('Add task'),
      );
      if (!button) return;
      // A microtask after the commit, before React's deferred (passive) effects.
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
      formWhenButtonAppeared = false;
      queueMicrotask(() => {
        formWhenButtonAppeared = document.querySelector('form[aria-label="New task"]') !== null;
      });
    });
    watcher.observe(document.body, { childList: true, subtree: true });
    try {
      await ready();
      await screen.findByRole('form', { name: 'New task' }, { timeout: 1000 });
      await waitFor(() => expect(formWhenButtonAppeared).toBe(true));
    } finally {
      watcher.disconnect();
    }
  });

  it('adds a task to a lead through the lead’s own route when the Lead chip picks one', async () => {
    mocks.createLeadTask.mockResolvedValue({
      task: saved('Send the contract', null, LEAD),
      requestId: REQUEST,
    });
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));
    const form = screen.getByRole('form', { name: 'New task' });
    fireEvent.click(within(form).getByRole('button', { name: 'Lead: No lead' }));
    fireEvent.click(await screen.findByRole('option', { name: /Blake Sample/ }));
    fireEvent.change(within(form).getByRole('textbox', { name: 'Task name' }), {
      target: { value: 'Send the contract' },
    });
    fireEvent.submit(form);
    await waitFor(() =>
      expect(mocks.createLeadTask).toHaveBeenCalledWith('staff-token', WORKSPACE, LEAD, {
        title: 'Send the contract',
        dueAt: null,
        assignedActorId: SELF,
      }),
    );
    expect(mocks.createPlainTask).not.toHaveBeenCalled();
    // The saved task carries its lead, so the list links to it.
    expect(await screen.findByRole('link', { name: 'Blake Sample · Internet' })).toBeTruthy();
  });

  it('presets each board column’s composer to its date and adds the task there', async () => {
    window.localStorage.setItem(TASKS_VIEW_KEY, 'board');
    window.localStorage.setItem(TASKS_GROUP_KEY, 'date');
    mocks.createPlainTask.mockImplementation(async (_t: string, _w: string, body) => ({
      task: saved(body.title, body.dueAt),
      requestId: REQUEST,
    }));
    render(<MyTasks workspaceSlug="canadawide" />);
    const board = await screen.findByRole('region', { name: 'Tasks board by date' });
    const column = (name: string) =>
      within(board).getByRole('region', { name: new RegExp(`^${name},`) });
    const cases: [string, string | null, string][] = [
      ['Today', `${TODAY}T12:00:00.000Z`, 'Due date: Today'],
      ['Upcoming', `${addDays(TODAY, 1)}T12:00:00.000Z`, 'Due date: Tomorrow'],
      ['No due date', null, 'Due date: none'],
    ];
    expect(within(column('Overdue')).queryByRole('button', { name: /^Add task/ })).toBeNull();
    for (const [name, dueAt, chip] of cases) {
      fireEvent.click(within(column(name)).getByRole('button', { name: `Add task to ${name}` }));
      const form = within(column(name)).getByRole('form', { name: 'New task' });
      expect(within(form).getByRole('button', { name: chip })).toBeTruthy();
      fireEvent.change(within(form).getByRole('textbox', { name: 'Task name' }), {
        target: { value: `In ${name}` },
      });
      fireEvent.submit(form);
      await waitFor(() =>
        expect(mocks.createPlainTask).toHaveBeenLastCalledWith(
          'staff-token',
          WORKSPACE,
          expect.objectContaining({ title: `In ${name}`, dueAt }),
        ),
      );
      await waitFor(() => expect(within(column(name)).getByText(`In ${name}`)).toBeTruthy());
      fireEvent.keyDown(within(form).getByRole('textbox', { name: 'Task name' }), {
        key: 'Escape',
      });
      await waitFor(() =>
        expect(document.activeElement).toBe(
          within(column(name)).getByRole('button', { name: `Add task to ${name}` }),
        ),
      );
    }
  });

  it('shows the quiet drag cue only when the board has cards', async () => {
    window.localStorage.setItem(TASKS_VIEW_KEY, 'board');
    render(<MyTasks workspaceSlug="canadawide" />);
    await screen.findByRole('region', { name: 'Tasks board by status' });
    expect(screen.queryByText(/Drag cards to move them/)).toBeNull();
    mocks.createPlainTask.mockResolvedValue({ task: saved('Card', null), requestId: REQUEST });
    fireEvent.click(screen.getByRole('button', { name: 'Add task to To do' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Task name' }), {
      target: { value: 'Card' },
    });
    fireEvent.submit(screen.getByRole('form', { name: 'New task' }));
    expect(await screen.findByText(/Drag cards to move them/)).toBeTruthy();
  });
});
