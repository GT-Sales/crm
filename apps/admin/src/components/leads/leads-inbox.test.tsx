import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { todayDay } from '../../lib/dates';
import { filterQueryForLeadType, inboxSearch, parseInboxQuery } from './inbox-query';
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

describe('parseInboxQuery and inboxSearch', () => {
  it('round-trips where, sort and cols in the URL and drops invalid values', () => {
    const query = parseInboxQuery(
      new URLSearchParams({
        type: 'sim_order',
        where: JSON.stringify([
          { key: 'permitType', op: 'eq', value: 'student' },
          { key: 'dateOfBirth', op: 'eq', value: '1999-01-01' },
          { key: 'permitType', op: 'eq', value: 'not-an-option' },
          { key: 'city', op: 'eq', value: 'Calgary' },
        ]),
        sort: 'prop.arrivalDate:asc',
        cols: 'arrivalDate,permitType,dateOfBirth,city,arrivalDate',
        page: '2',
      }),
    );

    expect(query.where).toEqual([{ key: 'permitType', op: 'eq', value: 'student' }]);
    expect(query.sort).toBe('prop.arrivalDate:asc');
    expect(query.columns).toEqual(['arrivalDate', 'permitType']);

    const encoded = inboxSearch(query);
    const roundTripped = parseInboxQuery(new URLSearchParams(encoded.slice(1)));
    expect(roundTripped).toEqual(query);

    const invalidSortAndJson = parseInboxQuery(
      new URLSearchParams({
        type: 'internet',
        where: '{bad-json',
        sort: 'prop.dateOfBirth:asc',
        cols: 'dateOfBirth,permitType',
      }),
    );
    expect(invalidSortAndJson.where).toBeUndefined();
    expect(invalidSortAndJson.sort).toBeUndefined();
    expect(invalidSortAndJson.columns).toBeUndefined();

    const switched = filterQueryForLeadType(query, 'internet');
    expect(switched).toEqual({
      where: undefined,
      sort: undefined,
      columns: undefined,
    });
  });
});

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

  it('offers operators and value controls by kind, renders removable filter chips, and clears filters', async () => {
    navigation.search = 'type=sim_order&page=3';
    const view = render(<LeadsInbox workspaceSlug="canadawide" />);
    await screen.findByRole('button', { name: 'Add filter' });

    fireEvent.click(screen.getByRole('button', { name: 'Add filter' }));
    const propertySelect = screen.getByLabelText('Property');

    // Choice property: permitType offers eq, in, empty, notEmpty and a select of options.
    fireEvent.change(propertySelect, { target: { value: 'permitType' } });
    const operatorSelect = screen.getByLabelText('Operator');
    expect(
      Array.from(operatorSelect.querySelectorAll('option')).map((opt) => opt.textContent),
    ).toEqual(['is', 'is any of', 'is empty', 'is not empty']);
    const valueControl = screen.getByLabelText('Value');
    expect(valueControl.tagName).toBe('SELECT');
    fireEvent.change(valueControl, { target: { value: 'student' } });

    // Date property: arrivalDate offers date input and date operators.
    fireEvent.change(propertySelect, { target: { value: 'arrivalDate' } });
    expect(
      Array.from(screen.getByLabelText('Operator').querySelectorAll('option')).map(
        (opt) => opt.textContent,
      ),
    ).toEqual(['is', 'on or before', 'on or after', 'is empty', 'is not empty']);
    expect(screen.getByLabelText('Value').getAttribute('type')).toBe('date');

    // Yes/No property: gotVisa offers Yes/No select and hides value when "is empty".
    fireEvent.change(propertySelect, { target: { value: 'gotVisa' } });
    expect(
      Array.from(screen.getByLabelText('Value').querySelectorAll('option')).map(
        (opt) => opt.textContent,
      ),
    ).toEqual(['Yes', 'No']);
    fireEvent.change(screen.getByLabelText('Operator'), { target: { value: 'empty' } });
    expect(screen.queryByLabelText('Value')).toBeNull();

    // Apply `Visa / permit type is Study permit`.
    fireEvent.change(propertySelect, { target: { value: 'permitType' } });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'student' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filter' }));

    expect(navigation.replace).toHaveBeenLastCalledWith(
      '/w/canadawide/leads?type=sim_order&where=%5B%7B%22key%22%3A%22permitType%22%2C%22op%22%3A%22eq%22%2C%22value%22%3A%22student%22%7D%5D',
      { scroll: false },
    );

    view.unmount();
    render(<LeadsInbox workspaceSlug="canadawide" />);
    const chip = await screen.findByRole('button', {
      name: /Visa \/ permit type is Study permit/,
    });
    expect(chip).toBeTruthy();

    fireEvent.click(chip);
    expect(navigation.replace).toHaveBeenLastCalledWith('/w/canadawide/leads?type=sim_order', {
      scroll: false,
    });
  });

  it('cycles column header sorting ascending → descending → default with aria-sort', async () => {
    navigation.search = 'type=internet&cols=city';
    const view = render(<LeadsInbox workspaceSlug="canadawide" />);

    const cityHeader = await screen.findByRole('columnheader', { name: /City/ });
    expect(cityHeader.getAttribute('aria-sort')).toBe('none');

    fireEvent.click(screen.getByRole('button', { name: /City/ }));
    expect(navigation.replace).toHaveBeenLastCalledWith(
      '/w/canadawide/leads?type=internet&sort=prop.city%3Aasc&cols=city',
      { scroll: false },
    );

    view.unmount();
    const viewAsc = render(<LeadsInbox workspaceSlug="canadawide" />);
    const ascHeader = await screen.findByRole('columnheader', { name: /City/ });
    expect(ascHeader.getAttribute('aria-sort')).toBe('ascending');

    fireEvent.click(screen.getByRole('button', { name: /City/ }));
    expect(navigation.replace).toHaveBeenLastCalledWith(
      '/w/canadawide/leads?type=internet&sort=prop.city%3Adesc&cols=city',
      { scroll: false },
    );

    viewAsc.unmount();
    render(<LeadsInbox workspaceSlug="canadawide" />);
    const descHeader = await screen.findByRole('columnheader', { name: /City/ });
    expect(descHeader.getAttribute('aria-sort')).toBe('descending');

    fireEvent.click(screen.getByRole('button', { name: /City/ }));
    expect(navigation.replace).toHaveBeenLastCalledWith(
      '/w/canadawide/leads?type=internet&cols=city',
      { scroll: false },
    );
  });

  it('hides filter, column and sort controls when access.contacts is false', async () => {
    mocks.getLeadsSummary.mockResolvedValue({
      types: [{ leadType: 'internet', total: 10 }],
      trash: 0,
      access: { contacts: false, manage: false },
    });
    mocks.getStaffLeads.mockResolvedValue({
      ...emptyPage,
      access: { contacts: false, manage: false },
    });
    navigation.search = 'type=internet';
    render(<LeadsInbox workspaceSlug="canadawide" />);

    await screen.findByRole('tab', { name: /Internet/ });
    expect(screen.queryByRole('button', { name: 'Add filter' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Columns' })).toBeNull();
    const leadHeader = screen.getByRole('columnheader', { name: 'Lead' });
    expect(leadHeader.getAttribute('aria-sort')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Lead' })).toBeNull();
  });
});
