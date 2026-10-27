import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { todayDay } from '../lib/dates';
import { Dashboard } from './dashboard';
import { fillDays, niceCeiling } from './dashboard-charts';

const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const DAY = 86_400_000;

const mocks = vi.hoisted(() => ({
  listStaffTasks: vi.fn(),
  getLeadsSummary: vi.fn(),
  getLeadStats: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  ...mocks,
  BackendError: class extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
}));

vi.mock('./staff-session-provider', () => ({
  useStaffSession: () => ({
    accessToken: 'staff-token',
    workspaces: [{ id: WORKSPACE, slug: 'getcanadasim', roles: ['owner'] }],
  }),
}));

/** A calendar day `offset` days from the viewer's today, stored at noon UTC as tasks are. */
function dueAt(offset: number): string {
  return `${todayDay(new Date(Date.now() + offset * DAY))}T12:00:00.000Z`;
}

function task(id: string, title: string, offset: number, name: string, externalRef: string | null) {
  return {
    id,
    leadId: `9${id.slice(1)}`,
    title,
    dueAt: dueAt(offset),
    assignedActorId: null,
    status: 'open',
    completedAt: null,
    createdBy: '20000000-0000-4000-8000-000000000001',
    createdAt: '2026-10-20T09:00:00.000Z',
    updatedAt: '2026-10-20T09:00:00.000Z',
    lead: {
      id: `9${id.slice(1)}`,
      leadType: 'sim_order',
      stage: 'pending',
      contact: { fullName: name },
      externalRef,
    },
  };
}

describe('Dashboard follow-ups due', () => {
  beforeEach(() => {
    mocks.listStaffTasks.mockReset();
  });

  it('lists the team’s follow-ups due, most overdue first, each linking to its lead', async () => {
    mocks.listStaffTasks.mockResolvedValue({
      tasks: [
        task(
          '50000000-0000-4000-8000-000000000001',
          'Check visa status',
          -2,
          'Arjun Patel',
          'MS-101',
        ),
        task('50000000-0000-4000-8000-000000000002', 'Ship the SIM', 0, 'Kept Person', null),
      ],
      page: { page: 1, pageSize: 6, total: 8 },
      access: { contacts: true, manage: true },
    });
    render(<Dashboard workspaceSlug="getcanadasim" />);

    expect(mocks.listStaffTasks).toHaveBeenCalledWith('staff-token', WORKSPACE, {
      assignee: 'all',
      status: 'open',
      dueBy: todayDay(),
      pageSize: 6,
    });
    const first = await screen.findByRole('link', { name: /Arjun Patel/ });
    expect(first.getAttribute('href')).toBe(
      '/w/getcanadasim/leads/90000000-0000-4000-8000-000000000001',
    );
    expect(first.textContent).toContain('MS-101');
    expect(first.textContent).toContain('Check visa status');
    expect(first.textContent).toContain('Overdue by 2 days');
    // A lead without its own number shows its type.
    expect(screen.getByRole('link', { name: /Kept Person/ }).textContent).toContain('SIM order');
    expect(screen.getByText('Due today')).toBeTruthy();
    expect(screen.getByLabelText('8 due')).toBeTruthy();
    expect(screen.getByText(/2 of 8 shown/)).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Open the follow-ups in Leads' }).getAttribute('href'),
    ).toBe('/w/getcanadasim/leads?due=1');
  });

  it('says when nothing is due', async () => {
    mocks.listStaffTasks.mockResolvedValue({
      tasks: [],
      page: { page: 1, pageSize: 6, total: 0 },
      access: { contacts: true, manage: true },
    });
    render(<Dashboard workspaceSlug="getcanadasim" />);
    expect(await screen.findByText(/Nothing due/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Open the follow-ups in Leads' })).toBeNull();
  });

  it('tells a role without lead tasks why the card is empty', async () => {
    const { BackendError } = await import('../lib/api');
    mocks.listStaffTasks.mockRejectedValue(new BackendError('permission_denied', 403, 'x'));
    render(<Dashboard workspaceSlug="getcanadasim" />);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Your role does not include lead tasks.',
    );
  });
});

describe('Dashboard totals', () => {
  const stats = {
    leadType: 'sim_order',
    days: 7,
    total: 5,
    stages: [
      { stage: 'cancelled', total: 1 },
      { stage: 'completed', total: 1 },
      { stage: 'pending', total: 2 },
      { stage: 'verified', total: 1 },
    ],
    daily: [
      { day: '2026-10-25', total: 1 },
      { day: '2026-10-27', total: 3 },
    ],
    partners: [
      { code: 'PT-7', name: 'Maple Study Abroad', total: 2 },
      { code: 'MAPLE10', name: null, total: 1 },
    ],
    requestId: '00000000-0000-4000-8000-000000000001',
  };

  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.listStaffTasks.mockResolvedValue({
      tasks: [],
      page: { page: 1, pageSize: 6, total: 0 },
      access: { contacts: true, manage: true },
    });
    mocks.getLeadsSummary.mockResolvedValue({
      types: [
        { leadType: 'partner_application', total: 5, unopened: 0, followUpsDue: 0 },
        { leadType: 'sim_order', total: 138, unopened: 0, followUpsDue: 2 },
      ],
      trash: 44,
      access: { contacts: true, manage: true },
      requestId: '00000000-0000-4000-8000-000000000001',
    });
    mocks.getLeadStats.mockResolvedValue(stats);
  });

  it('opens on the site’s orders over the last 7 days, in Get Canada Sim’s tiles', async () => {
    render(<Dashboard workspaceSlug="getcanadasim" />);
    const pending = (await screen.findByRole('heading', { name: 'Pending action' })).parentElement;
    expect(mocks.getLeadStats).toHaveBeenCalledWith('staff-token', WORKSPACE, {
      leadType: 'sim_order',
      days: 7,
    });
    expect(pending?.textContent).toContain('3');
    expect(pending?.textContent).toContain('2 follow-ups due');
    const cancelled = screen.getByRole('heading', { name: 'Cancellations' }).parentElement;
    expect(cancelled?.textContent).toContain('20.0% cancellation rate');
    const completed = screen.getByRole('heading', { name: 'Completed' }).parentElement;
    expect(completed?.textContent).toContain('1');
    const partners = screen.getByRole('list', { name: 'Top partners' });
    expect(
      within(partners)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Maple Study AbroadPT-72', 'MAPLE101']);
  });

  it('reloads for another window and another type', async () => {
    render(<Dashboard workspaceSlug="getcanadasim" />);
    await screen.findByRole('heading', { name: 'Pending action' });
    fireEvent.click(screen.getByRole('button', { name: 'All time' }));
    await waitFor(() =>
      expect(mocks.getLeadStats).toHaveBeenLastCalledWith('staff-token', WORKSPACE, {
        leadType: 'sim_order',
      }),
    );
    expect(screen.getByRole('button', { name: 'All time' }).getAttribute('aria-pressed')).toBe(
      'true',
    );

    mocks.getLeadStats.mockResolvedValue({
      ...stats,
      leadType: 'partner_application',
      days: null,
      total: 5,
      stages: [{ stage: 'approved', total: 5 }],
      daily: [],
      partners: [],
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Lead type' }), {
      target: { value: 'partner_application' },
    });
    // A type without outcome groups lists its stages.
    expect(await screen.findByRole('heading', { name: 'By stage' })).toBeTruthy();
    expect(screen.getByText('Approved')).toBeTruthy();
    expect(screen.getByText('No partner sales in this period.')).toBeTruthy();
  });
});

describe('Dashboard volume', () => {
  it('fills every day of the window, the empty ones as zero', () => {
    expect(
      fillDays([{ day: '2026-10-25', total: 2 }], 3, '2026-10-27').map((entry) => entry.total),
    ).toEqual([2, 0, 0]);
    expect(fillDays([{ day: '2026-10-26', total: 1 }], null, '2026-10-27')).toEqual([
      { day: '2026-10-26', total: 1 },
      { day: '2026-10-27', total: 0 },
    ]);
  });

  it('tops the axis at a clean number', () => {
    expect([1, 5, 6, 12, 37, 101].map(niceCeiling)).toEqual([5, 5, 10, 20, 50, 200]);
  });
});
