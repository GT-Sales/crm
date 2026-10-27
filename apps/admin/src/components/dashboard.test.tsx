import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { todayDay } from '../lib/dates';
import { Dashboard } from './dashboard';

const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const DAY = 86_400_000;

const mocks = vi.hoisted(() => ({ listStaffTasks: vi.fn() }));

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
