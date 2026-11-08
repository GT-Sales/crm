import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyticsResponse } from '@gt-sales/contracts';

import { todayDay } from '../lib/dates';
import { utcToday, addDays } from './analytics/analytics-query';
import { Dashboard } from './dashboard';

const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const TEAMMATE = '20000000-0000-4000-8000-000000000002';
const DAY = 86_400_000;

const navigation = vi.hoisted(() => {
  const state = {
    search: '',
    replace: vi.fn((url: string) => {
      state.search = url.split('?')[1] ?? '';
    }),
  };
  return state;
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: navigation.replace, push: vi.fn() }),
  usePathname: () => '/w/getcanadasim/dashboard',
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

const mocks = vi.hoisted(() => ({
  listStaffTasks: vi.fn(),
  getLeadsSummary: vi.fn(),
  getAnalytics: vi.fn(),
  listPlans: vi.fn(),
  listWorkspaceMembers: vi.fn(),
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

const TODAY = utcToday();
const FROM = addDays(TODAY, -29);

const counts: AnalyticsResponse = {
  range: { from: FROM, to: TODAY, days: 30 },
  comparison: { from: addDays(FROM, -30), to: addDays(FROM, -1) },
  group: 'day',
  leadType: 'sim_order',
  kpis: {
    newLeads: { current: 12, previous: 8 },
    won: { current: 3, previous: 4 },
    paid: { current: 5, previous: 5 },
    followUps: { due: 4, overdue: 2 },
    documentsToReview: 6,
  },
  trend: [
    { bucket: FROM, current: 5, previous: 3 },
    { bucket: addDays(FROM, 1), current: 7, previous: 5 },
  ],
  stages: [
    { leadType: 'sim_order', stage: 'pending', total: 6 },
    { leadType: 'sim_order', stage: 'verified', total: 3 },
    { leadType: 'sim_order', stage: 'completed', total: 3 },
    { leadType: 'sim_order', stage: 'cancelled', total: 1 },
  ],
  sources: [
    { key: 'google', total: 7 },
    { key: '(none)', total: 5 },
  ],
  partners: [{ code: 'PT-7', name: 'Maple Study Abroad', total: 2 }],
  mix: {
    plans: [
      { planId: '70000000-0000-4000-8000-000000000001', name: 'Unlimited 50', total: 9 },
      { planId: null, name: 'No plan matched', total: 3 },
    ],
    delivery: [
      { key: 'esim', total: 8 },
      { key: 'pickup', total: 4 },
    ],
    leadTypes: [{ leadType: 'sim_order', total: 12 }],
  },
  statuses: {
    payment: [
      { key: 'paid', total: 5 },
      { key: 'pending', total: 7 },
    ],
    commission: [
      { key: 'received', total: 2 },
      { key: 'not_yet', total: 9 },
      { key: 'invoiced', total: 1 },
    ],
  },
  team: [
    { actorId: TEAMMATE, assigned: 7, won: 2, overdue: 2 },
    { actorId: null, assigned: 5, won: 1, overdue: 0 },
  ],
  requestId: '00000000-0000-4000-8000-000000000001',
};

const owner: AnalyticsResponse = {
  ...counts,
  commission: {
    earnedMinor: { current: 150_000, previous: 100_000 },
    expectedMinor: 42_050,
    wonWithoutCommission: 1,
    anyPlanHasCommission: true,
    wonDateBasis: 'status_change_else_created',
  },
  commissionTrend: [
    { bucket: FROM, earnedMinor: 50_000 },
    { bucket: addDays(FROM, 1), earnedMinor: 100_000 },
  ],
};

function resetMocks(analytics: AnalyticsResponse = owner) {
  for (const mock of Object.values(mocks)) mock.mockReset();
  navigation.search = '';
  navigation.replace.mockClear();
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
    archived: 44,
    trash: 44,
    access: { contacts: true, manage: true },
    requestId: '00000000-0000-4000-8000-000000000001',
  });
  mocks.listWorkspaceMembers.mockResolvedValue({
    members: [{ actorId: TEAMMATE, displayName: 'Priya', roles: ['orders'], isSelf: false }],
    requestId: '00000000-0000-4000-8000-000000000001',
  });
  mocks.listPlans.mockResolvedValue({
    plans: [],
    requestId: '00000000-0000-4000-8000-000000000001',
  });
  mocks.getAnalytics.mockResolvedValue(analytics);
}

const kpi = (name: string | RegExp) =>
  screen.getByRole('heading', { name }).closest('.crm-stat') ?? undefined;

describe('Dashboard analytics', () => {
  beforeEach(() => resetMocks());

  it('opens on the busiest type over the last 30 days against the previous period', async () => {
    render(<Dashboard workspaceSlug="getcanadasim" />);
    await screen.findByRole('heading', { name: 'New orders' });
    expect(mocks.getAnalytics).toHaveBeenCalledWith('staff-token', WORKSPACE, {
      from: FROM,
      to: TODAY,
      compare: 'previous',
      group: 'day',
      leadType: 'sim_order',
    });
    const created = kpi('New orders');
    expect(created?.textContent).toContain('12');
    // 12 against 8: up 50 %.
    expect(created?.textContent).toContain('Up 50%');
    expect(kpi('Won')?.textContent).toContain('Down 25%');
    expect(kpi('Conversion rate')?.textContent).toContain('25%');
    expect(kpi('Paid')?.textContent).toContain('0%');
    expect(kpi('Open follow-ups')?.textContent).toContain('2 overdue');
    expect(kpi('Carrier commission')?.textContent).toContain('2 received');
    expect(kpi('Carrier commission')?.textContent).toContain('10 outstanding');
    expect(kpi('Documents to review')?.textContent).toContain('6');
    // The KPI links to the Leads list filtered to the type.
    expect(screen.getByRole('link', { name: /New orders/ }).getAttribute('href')).toBe(
      '/w/getcanadasim/leads?type=sim_order',
    );
  });

  it('shows the owner the commission cards and chart', async () => {
    render(<Dashboard workspaceSlug="getcanadasim" />);
    const earned = (await screen.findByRole('heading', { name: 'Commission earned' })).closest(
      '.crm-stat',
    );
    expect(earned?.textContent).toContain('$1,500.00');
    expect(earned?.textContent).toContain('Up 50%');
    expect(kpi('Expected commission')?.textContent).toContain('$420.50');
    expect(kpi('Won without a commission')?.textContent).toContain('1');
    expect(screen.getByRole('heading', { name: 'Commission earned over time' })).toBeTruthy();
  });

  it('hides every money card from a non-owner, whose response carries no money', async () => {
    resetMocks(counts);
    const view = render(<Dashboard workspaceSlug="getcanadasim" />);
    await screen.findByRole('heading', { name: 'New orders' });
    expect(screen.queryByRole('heading', { name: 'Commission earned' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Expected commission' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Commission earned over time' })).toBeNull();
    expect(view.container.textContent).not.toMatch(/\$\d/);
    // Counts stay for everyone.
    expect(kpi('Carrier commission')?.textContent).toContain('2 received');
  });

  it('points the owner to Settings → Plans when no plan has a commission', async () => {
    resetMocks({
      ...owner,
      commission: { ...owner.commission!, anyPlanHasCommission: false },
    });
    render(<Dashboard workspaceSlug="getcanadasim" />);
    const link = await screen.findByRole('link', {
      name: 'Set commission on plans in Settings → Plans',
    });
    expect(link.getAttribute('href')).toBe('/w/getcanadasim/settings/plans');
    expect(screen.queryByRole('heading', { name: 'Commission earned' })).toBeNull();
  });

  it('draws the funnel, sources, mix, statuses and team, each with a data table', async () => {
    render(<Dashboard workspaceSlug="getcanadasim" />);
    const funnel = await screen.findByRole('list', { name: 'Funnel by stage' });
    const pending = within(funnel).getByRole('link', { name: /Pending/ });
    expect(pending.getAttribute('href')).toBe('/w/getcanadasim/leads?type=sim_order&stage=pending');
    // Reached Pending or later: 6 + 3 + 3 = 12, of 13 at the first step.
    expect(pending.textContent).toContain('12');
    expect(pending.textContent).toContain('92.3%');
    expect(
      within(screen.getByRole('list', { name: 'Top sources' }))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['google7', 'No UTM source5']);
    expect(screen.getByRole('list', { name: 'Top partners' }).textContent).toContain(
      'Maple Study Abroad',
    );
    // The donut's legend (the Delivery filter offers it too).
    expect(screen.getAllByText('Physical SIM', { selector: 'span' })).toHaveLength(1);
    expect(screen.getByRole('table', { name: 'Payment and commission status' })).toBeTruthy();
    const team = screen.getByRole('table', { name: 'Team' });
    const priya = within(team).getByRole('link', { name: 'Priya' });
    expect(priya.getAttribute('href')).toBe(
      `/w/getcanadasim/leads?type=sim_order&assignee=${TEAMMATE}`,
    );
    expect(within(team).getByRole('link', { name: 'Unassigned' })).toBeTruthy();
    const trend = screen.getByRole('table', { name: 'New leads over time' });
    expect(within(trend).getAllByRole('row')).toHaveLength(3);
  });

  it('writes the period, comparison, grouping and filters to the URL', async () => {
    const view = render(<Dashboard workspaceSlug="getcanadasim" />);
    await screen.findByRole('heading', { name: 'New orders' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Period' }), {
      target: { value: '7d' },
    });
    expect(navigation.replace).toHaveBeenLastCalledWith('/w/getcanadasim/dashboard?period=7d', {
      scroll: false,
    });
    view.rerender(<Dashboard workspaceSlug="getcanadasim" />);
    fireEvent.click(screen.getByRole('button', { name: 'Week' }));
    expect(navigation.replace).toHaveBeenLastCalledWith(
      '/w/getcanadasim/dashboard?period=7d&group=week',
      { scroll: false },
    );
    view.rerender(<Dashboard workspaceSlug="getcanadasim" />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Compare with' }), {
      target: { value: 'none' },
    });
    view.rerender(<Dashboard workspaceSlug="getcanadasim" />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Delivery' }), {
      target: { value: 'pickup' },
    });
    expect(navigation.search).toBe('period=7d&compare=none&group=week&delivery=pickup');
    view.rerender(<Dashboard workspaceSlug="getcanadasim" />);
    await waitFor(() =>
      expect(mocks.getAnalytics).toHaveBeenLastCalledWith('staff-token', WORKSPACE, {
        from: addDays(TODAY, -6),
        to: TODAY,
        compare: 'none',
        group: 'week',
        leadType: 'sim_order',
        delivery: 'pickup',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Clear filters/ }));
    expect(navigation.search).toBe('period=7d&compare=none&group=week');
  });

  it('takes a custom range from the calendar', async () => {
    render(<Dashboard workspaceSlug="getcanadasim" />);
    await screen.findByRole('heading', { name: 'New orders' });
    fireEvent.click(screen.getByRole('button', { name: /choose a custom range/ }));
    fireEvent.change(await screen.findByLabelText('From'), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-08-01' } });
    expect(screen.getByRole('button', { name: 'Apply range' })).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-09-30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply range' }));
    expect(navigation.search).toBe('period=custom&from=2026-09-01&to=2026-09-30');
  });

  it('reads a shared URL: all types, no comparison', async () => {
    navigation.search = 'period=custom&from=2026-09-01&to=2026-09-30&type=all&compare=none';
    resetMocks({ ...owner, comparison: null, leadType: null });
    navigation.search = 'period=custom&from=2026-09-01&to=2026-09-30&type=all&compare=none';
    render(<Dashboard workspaceSlug="getcanadasim" />);
    await screen.findByRole('heading', { name: 'New leads' });
    expect(mocks.getAnalytics).toHaveBeenCalledWith('staff-token', WORKSPACE, {
      from: '2026-09-01',
      to: '2026-09-30',
      compare: 'none',
      group: 'day',
    });
    expect(screen.getByText('Choose a lead type to see its funnel.')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Lead type' })).toHaveProperty('value', 'all');
  });

  it('says when the analytics could not load', async () => {
    mocks.getAnalytics.mockRejectedValue(new Error('boom'));
    render(<Dashboard workspaceSlug="getcanadasim" />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not load the dashboard/);
  });
});

describe('Dashboard follow-ups due', () => {
  beforeEach(() => resetMocks());

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

    const first = await screen.findByRole('link', { name: /Arjun Patel/ });
    expect(mocks.listStaffTasks).toHaveBeenCalledWith('staff-token', WORKSPACE, {
      assignee: 'all',
      status: 'open',
      dueBy: todayDay(),
      pageSize: 6,
    });
    expect(first.getAttribute('href')).toBe(
      '/w/getcanadasim/leads/90000000-0000-4000-8000-000000000001',
    );
    expect(first.textContent).toContain('Overdue by 2 days');
    expect(screen.getByRole('link', { name: /Kept Person/ }).textContent).toContain('SIM order');
    expect(screen.getByLabelText('8 due')).toBeTruthy();
    expect(screen.getByText(/2 of 8 shown/)).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Open the follow-ups in Leads' }).getAttribute('href'),
    ).toBe('/w/getcanadasim/leads?due=1');
  });

  it('tells a role without lead tasks why the card is empty', async () => {
    const { BackendError } = await import('../lib/api');
    mocks.listStaffTasks.mockRejectedValue(new BackendError('permission_denied', 403, 'x'));
    render(<Dashboard workspaceSlug="getcanadasim" />);
    expect(await screen.findByText('Your role does not include lead tasks.')).toBeTruthy();
  });
});
