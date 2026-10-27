import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { todayDay } from '../../lib/dates';
import { LeadsInbox } from './leads-inbox';

const WORKSPACE = '10000000-0000-4000-8000-000000000001';

// `replace` moves the mocked URL, as the real router does, so a re-render
// reads the filters it just wrote.
const navigation = vi.hoisted(() => {
  const state = {
    search: '',
    push: vi.fn(),
    replace: vi.fn((url: string) => {
      state.search = url.split('?')[1] ?? '';
    }),
  };
  return state;
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: navigation.replace, push: navigation.push }),
  usePathname: () => '/w/canadawide/leads',
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

const mocks = vi.hoisted(() => ({
  getLeadsSummary: vi.fn(),
  getStaffLeads: vi.fn(),
  getLeadBoard: vi.fn(),
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

const emptyPage = { leads: [], page: { page: 1, pageSize: 50, total: 0 } };

describe('LeadsInbox', () => {
  beforeEach(() => {
    navigation.replace.mockClear();
    navigation.search = '';
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.listWorkspaceMembers.mockResolvedValue({ members: [] });
    mocks.getLeadsSummary.mockResolvedValue({
      types: [
        { leadType: 'internet', total: 665 },
        { leadType: 'mobility', total: 39 },
      ],
      trash: 3,
      access: { contacts: true, manage: true },
    });
    mocks.getStaffLeads.mockResolvedValue({
      ...emptyPage,
      access: { contacts: true, manage: true },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('offers a tab per lead type the site has, with counts, and the trash', async () => {
    render(<LeadsInbox workspaceSlug="canadawide" />);
    expect(await screen.findByRole('tab', { name: /Internet\s*665/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Mobility\s*39/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /All leads\s*704/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Trash\s*3/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: /Mobility/ }));
    expect(navigation.replace).toHaveBeenLastCalledWith('/w/canadawide/leads?type=mobility', {
      scroll: false,
    });
  });

  it('loads the table from the URL filters', async () => {
    navigation.search = 'type=internet&stage=won&assignee=none&page=2';
    render(<LeadsInbox workspaceSlug="canadawide" />);
    await waitFor(() =>
      expect(mocks.getStaffLeads).toHaveBeenCalledWith('staff-token', WORKSPACE, {
        type: 'internet',
        stage: 'won',
        assignee: 'none',
        q: undefined,
        view: 'active',
        page: 2,
        pageSize: 50,
      }),
    );
    expect(await screen.findByText('No leads match these filters.')).toBeTruthy();
  });

  it('offers the follow-ups due with their count, and lists them most overdue first', async () => {
    mocks.getLeadsSummary.mockResolvedValue({
      types: [
        { leadType: 'internet', total: 665, followUpsDue: 2 },
        { leadType: 'mobility', total: 39, followUpsDue: 1 },
      ],
      trash: 3,
      access: { contacts: true, manage: true },
    });
    const view = render(<LeadsInbox workspaceSlug="canadawide" />);
    // Due by the viewer's own today.
    expect(mocks.getLeadsSummary).toHaveBeenCalledWith('staff-token', WORKSPACE, {
      dueBy: todayDay(),
    });
    const toggle = await screen.findByRole('button', { name: /Follow-ups due\s*3/ });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(navigation.replace).toHaveBeenLastCalledWith('/w/canadawide/leads?due=1', {
      scroll: false,
    });

    view.unmount();
    mocks.getStaffLeads.mockClear();
    navigation.search = 'type=mobility&due=1';
    render(<LeadsInbox workspaceSlug="canadawide" />);
    await waitFor(() =>
      expect(mocks.getStaffLeads).toHaveBeenCalledWith(
        'staff-token',
        WORKSPACE,
        expect.objectContaining({ type: 'mobility', dueBy: todayDay() }),
      ),
    );
    expect(await screen.findByText('No follow-ups due today or earlier.')).toBeTruthy();
    // The type's own count, and pressed while on.
    const on = await screen.findByRole('button', { name: /Follow-ups due\s*1/ });
    expect(on.getAttribute('aria-pressed')).toBe('true');
  });

  it('hides the follow-ups button while nothing is due', async () => {
    render(<LeadsInbox workspaceSlug="canadawide" />);
    await screen.findByRole('tab', { name: /Internet/ });
    expect(screen.queryByRole('button', { name: /Follow-ups due/ })).toBeNull();
  });

  it('shows a SIM order’s arrival and how many days are left', async () => {
    const inThreeDays = new Date();
    inThreeDays.setDate(inThreeDays.getDate() + 3);
    mocks.getStaffLeads.mockResolvedValue({
      leads: [
        {
          id: '90000000-0000-4000-8000-000000000001',
          workspaceId: WORKSPACE,
          leadType: 'sim_order',
          status: 'submitted',
          stage: 'pending',
          contact: { fullName: 'Arjun Patel' },
          contactId: null,
          assignedActorId: null,
          externalRef: 'MS-101',
          source: 'direct',
          attribution: {},
          consentVersion: null,
          openTaskCount: 0,
          nextTaskDueAt: null,
          countdownDate: todayDay(inThreeDays),
          deletedAt: null,
          createdAt: '2026-10-20T09:00:00.000Z',
          updatedAt: '2026-10-21T10:00:00.000Z',
        },
      ],
      page: { page: 1, pageSize: 50, total: 1 },
      access: { contacts: true, manage: true },
    });
    navigation.search = 'type=sim_order';
    render(<LeadsInbox workspaceSlug="canadawide" />);
    expect(await screen.findByRole('columnheader', { name: 'Arrival in Canada' })).toBeTruthy();
    expect(screen.getByText('3 days left')).toBeTruthy();
  });

  it('opens the board for the chosen type', async () => {
    navigation.search = 'type=internet';
    render(<LeadsInbox workspaceSlug="canadawide" />);
    await screen.findByRole('tab', { name: /Internet/ });
    fireEvent.click(screen.getByRole('button', { name: /Board/ }));
    expect(navigation.replace).toHaveBeenLastCalledWith(
      '/w/canadawide/leads?type=internet&view=board',
      { scroll: false },
    );
  });

  it('keeps a tab clicked while a search change is still waiting', async () => {
    navigation.search = 'q=blake';
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<LeadsInbox workspaceSlug="canadawide" />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search leads' }), {
      target: { value: '' },
    });
    fireEvent.click(await screen.findByRole('tab', { name: /Mobility/ }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    expect(navigation.replace).toHaveBeenLastCalledWith('/w/canadawide/leads?type=mobility', {
      scroll: false,
    });
  });

  it('searches once the typing stops, from the first page', async () => {
    navigation.search = 'type=internet&page=3';
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<LeadsInbox workspaceSlug="canadawide" />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search leads' }), {
      target: { value: 'avery' },
    });
    expect(navigation.replace).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    expect(navigation.replace).toHaveBeenLastCalledWith(
      '/w/canadawide/leads?type=internet&q=avery',
      {
        scroll: false,
      },
    );
  });
});
