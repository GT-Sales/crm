import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListWorkspaceTasksQuery, WorkspaceTask } from '@gt-sales/contracts';

import { todayDay } from '../../lib/dates';
import { MyTasks, TASKS_GROUP_KEY, TASKS_VIEW_KEY } from './my-tasks';
import { addDays, columnTasks, dropChange } from './tasks-board';

const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const SELF = '20000000-0000-4000-8000-000000000001';
const SAM = '20000000-0000-4000-8000-000000000002';
const TODAY = todayDay();

const mocks = vi.hoisted(() => ({
  listStaffTasks: vi.fn(),
  updateLeadTask: vi.fn(),
  listWorkspaceMembers: vi.fn(),
}));

const backend = vi.hoisted(() => ({
  BackendError: class extends Error {
    constructor(readonly code: string) {
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

let seq = 0;
function task(
  title: string,
  options: {
    due?: number | null;
    status?: WorkspaceTask['status'];
    completedAt?: string | null;
    assignee?: string | null;
    name?: string;
  } = {},
): WorkspaceTask {
  seq += 1;
  const id = `50000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  const leadId = `90000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  const due = options.due === undefined ? 0 : options.due;
  return {
    id,
    leadId,
    title,
    dueAt: due === null ? null : `${addDays(TODAY, due)}T12:00:00.000Z`,
    assignedActorId: options.assignee === undefined ? SELF : options.assignee,
    status: options.status ?? 'open',
    completedAt: options.completedAt ?? null,
    createdBy: SELF,
    createdAt: `2026-10-0${(seq % 9) + 1}T09:00:00.000Z`,
    updatedAt: '2026-10-20T09:00:00.000Z',
    lead: {
      id: leadId,
      leadType: 'internet',
      stage: 'contacted',
      contact: { fullName: options.name ?? `Lead ${seq}` },
      externalRef: null,
    },
  };
}

const recently = new Date(Date.now() - 2 * 3_600_000).toISOString();
const overdue = task('Call back about the install', { due: -2, name: 'Avery Example' });
const today = task('Send the contract', { due: 0, name: 'Blake Sample' });
const upcoming = task('Confirm the window', { due: 3, status: 'in_progress', assignee: SAM });
const undated = task('Ask for a photo ID', { due: null });
const doneTask = task('Book the installer', {
  status: 'done',
  completedAt: recently,
  name: 'Casey Done',
});

function response(tasks: WorkspaceTask[], manage = true) {
  return {
    tasks,
    page: { page: 1, pageSize: 200, total: tasks.length },
    access: { contacts: true, manage },
    requestId: '00000000-0000-4000-8000-000000000001',
  };
}

function serve(active: WorkspaceTask[], done: WorkspaceTask[] = [doneTask], manage = true) {
  mocks.listStaffTasks.mockImplementation(
    async (_token: string, _workspace: string, query: ListWorkspaceTasksQuery) =>
      response(query.status === 'done' ? done : active, manage),
  );
}

function column(name: RegExp) {
  return screen.getByRole('region', { name });
}

function openMenu(title: string) {
  fireEvent.pointerDown(screen.getByRole('button', { name: `Move “${title}”` }), {
    button: 0,
    ctrlKey: false,
  });
}

/** A DataTransfer good enough for the board's native drag and drop. */
function dataTransfer() {
  const data = new Map<string, string>();
  const types: string[] = [];
  return {
    types,
    dropEffect: 'none',
    effectAllowed: 'all',
    setData(type: string, value: string) {
      data.set(type, value);
      this.types.push(type);
    },
    getData: (type: string) => data.get(type) ?? '',
  };
}

function drag(title: string, to: HTMLElement) {
  const transfer = dataTransfer();
  const card = screen.getByText(title).closest('li');
  if (!card) throw new Error(`no card for ${title}`);
  fireEvent.dragStart(card, { dataTransfer: transfer });
  fireEvent.dragOver(to, { dataTransfer: transfer });
  fireEvent.drop(to, { dataTransfer: transfer });
  fireEvent.dragEnd(card, { dataTransfer: transfer });
}

async function showBoard(groupBy: 'status' | 'date' = 'status') {
  window.localStorage.setItem(TASKS_VIEW_KEY, 'board');
  window.localStorage.setItem(TASKS_GROUP_KEY, groupBy);
  render(<MyTasks workspaceSlug="canadawide" />);
  await screen.findByRole('region', {
    name: groupBy === 'status' ? 'Tasks board by status' : 'Tasks board by date',
  });
  await screen.findByText('Book the installer');
}

beforeEach(() => {
  window.localStorage.clear();
  mocks.listStaffTasks.mockReset();
  mocks.updateLeadTask.mockReset();
  mocks.listWorkspaceMembers.mockResolvedValue({
    members: [
      { actorId: SELF, displayName: 'Takib', roles: ['owner'], isSelf: true },
      { actorId: SAM, displayName: 'Sam Rivers', roles: ['leads'], isSelf: false },
    ],
    requestId: '00000000-0000-4000-8000-000000000001',
  });
  serve([overdue, today, upcoming, undated]);
});

describe('the Tasks page', () => {
  it('shows the list by default, active tasks only, and the Everyone scope asks for the team', async () => {
    render(<MyTasks workspaceSlug="canadawide" />);
    expect(await screen.findByText('Call back about the install')).toBeTruthy();
    expect(screen.getByText('4 open tasks')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Overdue/ })).toBeTruthy();
    // The in-progress task carries its badge in the list.
    expect(screen.getByText('In progress')).toBeTruthy();
    expect(mocks.listStaffTasks).toHaveBeenCalledWith('staff-token', WORKSPACE, {
      assignee: 'me',
      status: 'active',
      plain: 'include',
      pageSize: 200,
    });
    // The list never loads the Done column.
    expect(mocks.listStaffTasks.mock.calls.some(([, , query]) => query?.status === 'done')).toBe(
      false,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Everyone' }));
    await waitFor(() =>
      expect(mocks.listStaffTasks).toHaveBeenLastCalledWith('staff-token', WORKSPACE, {
        assignee: 'all',
        status: 'active',
        plain: 'include',
        pageSize: 200,
      }),
    );
  });

  it('remembers List or Board and the board’s grouping in this browser', async () => {
    const first = render(<MyTasks workspaceSlug="canadawide" />);
    await screen.findByText('Call back about the install');
    expect(screen.queryByRole('group', { name: 'Group by' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Board' }));
    expect(window.localStorage.getItem(TASKS_VIEW_KEY)).toBe('board');
    expect(await screen.findByRole('region', { name: 'Tasks board by status' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Date' }));
    expect(window.localStorage.getItem(TASKS_GROUP_KEY)).toBe('date');
    expect(await screen.findByRole('region', { name: 'Tasks board by date' })).toBeTruthy();
    first.unmount();

    render(<MyTasks workspaceSlug="canadawide" />);
    expect(await screen.findByRole('region', { name: 'Tasks board by date' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Board' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('falls back to the list when storage throws', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      render(<MyTasks workspaceSlug="canadawide" />);
      await screen.findByText('Call back about the install');
      fireEvent.click(screen.getByRole('button', { name: 'Board' }));
      // Not persisted, but the page still switches.
      expect(await screen.findByRole('region', { name: 'Tasks board by status' })).toBeTruthy();
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});

describe('more than one page of active tasks (#91)', () => {
  const many = Array.from({ length: 201 }, (_, index) =>
    task(`Follow-up ${index + 1}`, { due: null }),
  );

  function servePages() {
    mocks.listStaffTasks.mockImplementation(
      async (_token: string, _workspace: string, query: ListWorkspaceTasksQuery) => {
        if (query.status === 'done') return response([doneTask]);
        const page = query.page ?? 1;
        return {
          ...response(many.slice((page - 1) * 200, page * 200)),
          page: { page, pageSize: 200, total: many.length },
        };
      },
    );
  }

  it('says how many of the total are shown and loads the rest into the list', async () => {
    servePages();
    render(<MyTasks workspaceSlug="canadawide" />);
    expect(await screen.findByText('Follow-up 200')).toBeTruthy();
    expect(screen.getByText('200 of 201 open tasks shown')).toBeTruthy();
    expect(screen.queryByText('Follow-up 201')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Load more tasks' }));
    expect(await screen.findByText('Follow-up 201')).toBeTruthy();
    expect(mocks.listStaffTasks).toHaveBeenLastCalledWith('staff-token', WORKSPACE, {
      assignee: 'me',
      status: 'active',
      plain: 'include',
      pageSize: 200,
      page: 2,
    });
    expect(screen.getByText('201 open tasks')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more tasks' })).toBeNull();
  });

  it('keeps the loaded pages when the list is read again after a save', async () => {
    servePages();
    render(<MyTasks workspaceSlug="canadawide" />);
    await screen.findByText('Follow-up 200');
    fireEvent.click(screen.getByRole('button', { name: 'Load more tasks' }));
    await screen.findByText('Follow-up 201');

    mocks.listStaffTasks.mockClear();
    window.dispatchEvent(
      new CustomEvent('crm:lead-work-saved', { detail: { workspaceId: WORKSPACE } }),
    );
    await waitFor(() => expect(mocks.listStaffTasks).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Follow-up 201')).toBeTruthy();
    expect(screen.getByText('201 open tasks')).toBeTruthy();
  });

  it('offers the same on the board, whose columns take the loaded tasks', async () => {
    servePages();
    await showBoard();
    expect(screen.getByText('200 of 201 open tasks shown')).toBeTruthy();
    expect(screen.queryByText('Follow-up 201')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Load more tasks' }));
    expect(await within(column(/^To do/)).findByText('Follow-up 201')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more tasks' })).toBeNull();
  });

  it('says so and keeps the button when the next page fails to load', async () => {
    servePages();
    render(<MyTasks workspaceSlug="canadawide" />);
    await screen.findByText('Follow-up 200');
    mocks.listStaffTasks.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    fireEvent.click(screen.getByRole('button', { name: 'Load more tasks' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Load more tasks' })).toBeTruthy();
    expect(screen.getByText('200 of 201 open tasks shown')).toBeTruthy();
  });
});

describe('the board by status', () => {
  it('has To do, In progress and Done, with To do grouped by due date and overdue flagged', async () => {
    await showBoard('status');
    expect(mocks.listStaffTasks).toHaveBeenCalledWith('staff-token', WORKSPACE, {
      assignee: 'me',
      status: 'done',
      completedSince: addDays(TODAY, -14),
      plain: 'include',
      pageSize: 50,
    });
    const todo = column(/^To do, 3 tasks$/);
    expect(
      within(todo)
        .getAllByRole('heading', { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(['Overdue1', 'Today1', 'No due date1']);
    expect(within(column(/^In progress, 1 task$/)).getByText('Confirm the window')).toBeTruthy();
    expect(within(column(/^Done, 1 task$/)).getByText('Book the installer')).toBeTruthy();

    const card = within(todo).getByText('Call back about the install').closest('li');
    if (!card) throw new Error('no card');
    expect(card.className).toContain('border-l-rose-500');
    expect(within(card).getByText(/Overdue ·/)).toBeTruthy();
    const link = within(card).getByRole('link', {
      name: 'Avery Example · Internet',
    });
    expect(link.getAttribute('href')).toBe(`/w/canadawide/leads/${overdue.lead?.id}`);
    // Assignee initials: Sam's avatar on his card.
    expect(within(column(/^In progress/)).getByText('SR')).toBeTruthy();
  });

  it('moves a card with its menu, the keyboard path', async () => {
    mocks.updateLeadTask.mockResolvedValue({
      task: { ...today, status: 'in_progress' },
      requestId: '00000000-0000-4000-8000-000000000001',
    });
    await showBoard('status');
    openMenu('Send the contract');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'In progress' }));

    await waitFor(() =>
      expect(within(column(/^In progress, 2 tasks$/)).getByText('Send the contract')).toBeTruthy(),
    );
    expect(mocks.updateLeadTask).toHaveBeenCalledWith('staff-token', WORKSPACE, today.id, {
      status: 'in_progress',
    });
    expect(screen.getByRole('status').textContent).toContain('In progress');
  });

  it('drags a card to Done', async () => {
    mocks.updateLeadTask.mockResolvedValue({
      task: { ...overdue, status: 'done', completedAt: new Date().toISOString() },
      requestId: '00000000-0000-4000-8000-000000000001',
    });
    await showBoard('status');
    drag('Call back about the install', column(/^Done/));
    await waitFor(() =>
      expect(
        within(column(/^Done, 2 tasks$/)).getByText('Call back about the install'),
      ).toBeTruthy(),
    );
    expect(mocks.updateLeadTask).toHaveBeenCalledWith('staff-token', WORKSPACE, overdue.id, {
      status: 'done',
    });
  });

  it('puts a refused move back and says why', async () => {
    let refuse: (error: Error) => void = () => undefined;
    mocks.updateLeadTask.mockReturnValue(
      new Promise((_resolve, reject) => {
        refuse = reject;
      }),
    );
    await showBoard('status');
    openMenu('Send the contract');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Done' }));
    // Shown at once…
    await waitFor(() =>
      expect(within(column(/^Done, 2 tasks$/)).getByText('Send the contract')).toBeTruthy(),
    );
    refuse(new backend.BackendError('task_not_found'));
    // …and put back.
    await waitFor(() =>
      expect(within(column(/^To do, 3 tasks$/)).getByText('Send the contract')).toBeTruthy(),
    );
    expect(screen.getByRole('alert').textContent).toBe(
      'This task no longer exists. Reload the page to see the latest, then try again.',
    );
  });

  it('shows ten done tasks at a time', async () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      task(`Finished ${index + 1}`, {
        status: 'done',
        completedAt: new Date(Date.now() - (index + 1) * 60_000).toISOString(),
      }),
    );
    serve([overdue], many);
    window.localStorage.setItem(TASKS_VIEW_KEY, 'board');
    render(<MyTasks workspaceSlug="canadawide" />);
    await screen.findByText('Finished 1');
    expect(screen.queryByText('Finished 11')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show more (2)' }));
    expect(screen.getByText('Finished 12')).toBeTruthy();
  });

  it('offers no moves to a role that cannot change tasks', async () => {
    serve([overdue, today], [doneTask], false);
    await showBoard('status');
    expect(screen.queryByRole('button', { name: /^Move “/ })).toBeNull();
    expect(screen.getByText('Call back about the install').closest('li')?.draggable).toBe(false);
  });
});

describe('the board by date', () => {
  it('has Overdue, Today, Upcoming, No due date and Done, each card badged with its status', async () => {
    await showBoard('date');
    expect(
      screen
        .getAllByRole('region')
        .filter((region) => region.dataset['column'])
        .map((region) => region.getAttribute('aria-label')),
    ).toEqual([
      'Overdue, 1 task',
      'Today, 1 task',
      'Upcoming, 1 task',
      'No due date, 1 task',
      'Done, 1 task',
    ]);
    expect(within(column(/^Upcoming/)).getByText('In progress')).toBeTruthy();
    expect(within(column(/^Today/)).getByText('To do')).toBeTruthy();
  });

  it('dates a card today when it is dropped on Today, and Overdue takes no drop', async () => {
    mocks.updateLeadTask.mockResolvedValue({
      task: { ...upcoming, dueAt: `${TODAY}T12:00:00.000Z` },
      requestId: '00000000-0000-4000-8000-000000000001',
    });
    await showBoard('date');
    drag('Confirm the window', column(/^Today/));
    await waitFor(() =>
      expect(within(column(/^Today, 2 tasks$/)).getByText('Confirm the window')).toBeTruthy(),
    );
    expect(mocks.updateLeadTask).toHaveBeenCalledWith('staff-token', WORKSPACE, upcoming.id, {
      dueAt: `${TODAY}T12:00:00.000Z`,
    });

    drag('Send the contract', column(/^Overdue/));
    expect(mocks.updateLeadTask).toHaveBeenCalledTimes(1);
  });

  it('clears a due date, sets tomorrow and picks a day from the card’s menu', async () => {
    mocks.updateLeadTask.mockImplementation(
      async (_token: string, _workspace: string, id: string, body: object) => ({
        task: { ...[overdue, today, upcoming, undated].find((entry) => entry.id === id), ...body },
        requestId: '00000000-0000-4000-8000-000000000001',
      }),
    );
    await showBoard('date');
    openMenu('Send the contract');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'No due date' }));
    await waitFor(() =>
      expect(within(column(/^No due date, 2 tasks$/)).getByText('Send the contract')).toBeTruthy(),
    );
    expect(mocks.updateLeadTask).toHaveBeenLastCalledWith('staff-token', WORKSPACE, today.id, {
      dueAt: null,
    });

    openMenu('Call back about the install');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Tomorrow' }));
    await waitFor(() =>
      expect(
        within(column(/^Upcoming, 2 tasks$/)).getByText('Call back about the install'),
      ).toBeTruthy(),
    );
    expect(mocks.updateLeadTask).toHaveBeenLastCalledWith('staff-token', WORKSPACE, overdue.id, {
      dueAt: `${addDays(TODAY, 1)}T12:00:00.000Z`,
    });

    openMenu('Ask for a photo ID');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pick a date…' }));
    const field = await screen.findByLabelText('Due date for “Ask for a photo ID”');
    fireEvent.change(field, { target: { value: addDays(TODAY, 9) } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mocks.updateLeadTask).toHaveBeenLastCalledWith('staff-token', WORKSPACE, undated.id, {
        dueAt: `${addDays(TODAY, 9)}T12:00:00.000Z`,
      }),
    );
    expect(within(column(/^Upcoming, 3 tasks$/)).getByText('Ask for a photo ID')).toBeTruthy();
  });

  it('marks a card done from the date layout and reopens a done one onto Today', async () => {
    mocks.updateLeadTask.mockImplementation(
      async (_token: string, _workspace: string, id: string, body: object) => ({
        task: {
          ...[overdue, today, upcoming, undated, doneTask].find((entry) => entry.id === id),
          ...body,
          completedAt: 'status' in body && body.status === 'done' ? new Date().toISOString() : null,
        },
        requestId: '00000000-0000-4000-8000-000000000001',
      }),
    );
    await showBoard('date');
    drag('Book the installer', column(/^Today/));
    await waitFor(() =>
      expect(within(column(/^Today, 2 tasks$/)).getByText('Book the installer')).toBeTruthy(),
    );
    // Its due day is already today, so only the status changes.
    expect(mocks.updateLeadTask).toHaveBeenLastCalledWith('staff-token', WORKSPACE, doneTask.id, {
      status: 'open',
    });

    openMenu('Confirm the window');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Done' }));
    await waitFor(() =>
      expect(within(column(/^Done, 1 task$/)).getByText('Confirm the window')).toBeTruthy(),
    );
    expect(mocks.updateLeadTask).toHaveBeenLastCalledWith('staff-token', WORKSPACE, upcoming.id, {
      status: 'done',
    });
    // Still there once the saved task replaces the optimistic one.
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Done'));
    expect(within(column(/^Done, 1 task$/)).getByText('Confirm the window')).toBeTruthy();
  });
});

describe('board rules', () => {
  it('works out what a drop changes', () => {
    expect(dropChange(today, 'today', TODAY)).toBeUndefined();
    expect(dropChange(today, 'overdue', TODAY)).toBeUndefined();
    expect(dropChange(today, 'open', TODAY)).toBeUndefined();
    expect(dropChange(today, 'in_progress', TODAY)).toEqual({ status: 'in_progress' });
    expect(dropChange(upcoming, 'upcoming', TODAY)).toBeUndefined();
    expect(dropChange(overdue, 'upcoming', TODAY)).toEqual({
      dueAt: `${addDays(TODAY, 1)}T12:00:00.000Z`,
    });
    expect(dropChange(undated, 'undated', TODAY)).toBeUndefined();
    expect(dropChange(today, 'undated', TODAY)).toEqual({ dueAt: null });
    expect(dropChange(doneTask, 'done', TODAY)).toBeUndefined();
    expect(dropChange(today, 'done', TODAY)).toEqual({ status: 'done' });
  });

  it('keeps cancelled tasks and old done ones off the board', () => {
    const cancelled = task('Dropped', { status: 'cancelled' });
    const old = task('Long done', {
      status: 'done',
      completedAt: `${addDays(TODAY, -20)}T09:00:00.000Z`,
    });
    const all = [overdue, today, upcoming, undated, doneTask, cancelled, old];
    const shown = (['open', 'in_progress', 'done'] as const).flatMap((key) =>
      columnTasks(all, key, TODAY).map((entry) => entry.title),
    );
    expect(shown).not.toContain('Dropped');
    expect(shown).not.toContain('Long done');
    expect(shown).toContain('Book the installer');
  });
});

describe('the Tasks page with nothing to show', () => {
  it('says the viewer is all caught up, in words that fit the scope, with a way to add a task', async () => {
    serve([], []);
    render(<MyTasks workspaceSlug="canadawide" />);
    const empty = (await screen.findByText('You’re all caught up')).closest(
      '[data-slot="empty-state"]',
    );
    if (!(empty instanceof HTMLElement)) throw new Error('expected the empty state');
    expect(empty.textContent).toContain('Nothing due. Tasks you are given show up here.');
    fireEvent.click(within(empty).getByRole('button', { name: 'Add a task' }));
    expect(await screen.findByRole('form', { name: 'New task' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Unassigned' }));
    expect(await screen.findByText('No unassigned tasks to pick up.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Everyone' }));
    expect(await screen.findByText('No open tasks on this site.')).toBeTruthy();
  });

  it('offers no Add a task to a role that cannot change tasks', async () => {
    serve([], [], false);
    render(<MyTasks workspaceSlug="canadawide" />);
    await screen.findByText('You’re all caught up');
    expect(screen.queryByRole('button', { name: 'Add a task' })).toBeNull();
  });

  it('says so above an empty board, whose columns keep their own Add task', async () => {
    serve([], []);
    window.localStorage.setItem(TASKS_VIEW_KEY, 'board');
    render(<MyTasks workspaceSlug="canadawide" />);
    await screen.findByRole('region', { name: 'Tasks board by status' });
    expect(await screen.findByText('You’re all caught up')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add a task' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add task to To do' })).toBeTruthy();
  });

  it('shows skeleton cards, not a word, while the Done column loads', async () => {
    mocks.listStaffTasks.mockImplementation(
      (_token: string, _workspace: string, query: ListWorkspaceTasksQuery) =>
        query.status === 'done' ? new Promise(() => {}) : Promise.resolve(response([today])),
    );
    window.localStorage.setItem(TASKS_VIEW_KEY, 'board');
    render(<MyTasks workspaceSlug="canadawide" />);
    const loading = await screen.findByRole('status', { name: 'Loading the done tasks…' });
    expect(loading.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByText('Loading…')).toBeNull();
    expect(column(/^Done,/).contains(loading)).toBe(true);
  });
});

describe('a task row’s cross', () => {
  it('waits for hover or focus in the list, and always shows on a touch screen', async () => {
    render(<MyTasks workspaceSlug="canadawide" />);
    const cancel = await screen.findByRole('button', { name: 'Cancel “Send the contract”' });
    for (const name of [
      'opacity-0',
      'group-hover/task:opacity-100',
      'group-focus-within/task:opacity-100',
      'focus-visible:opacity-100',
      'pointer-coarse:opacity-100',
    ]) {
      expect(cancel.className).toContain(name);
    }
    expect(cancel.closest('li')?.className).toContain('group/task');
  });

  it('keeps each group header’s count, with only Overdue in red', async () => {
    render(<MyTasks workspaceSlug="canadawide" />);
    await screen.findByText('Call back about the install');
    const headers = screen
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.closest('summary'))
      .filter((summary): summary is HTMLElement => summary !== null);
    expect(headers.map((summary) => summary.textContent)).toEqual([
      'Overdue1',
      'Today1',
      'Upcoming1',
      'No due date1',
    ]);
    expect(headers.filter((summary) => /rose/.test(summary.className))).toHaveLength(1);
    expect(headers[0]?.className).toMatch(/rose/);
  });
});
