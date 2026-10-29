import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codePropertyCatalog, type SiteProperty } from '@gt-sales/contracts';

import { todayDay } from '../../lib/dates';
import { catalogFromModel } from '../properties/use-property-model';
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
  getPropertyModel: vi.fn(),
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

function customProperty(
  overrides: Partial<SiteProperty> & Pick<SiteProperty, 'key' | 'label' | 'kind'>,
): SiteProperty {
  return {
    origin: 'custom',
    storage: 'custom',
    sensitive: false,
    staffOnly: false,
    hidden: false,
    leadTypes: [],
    editable: true,
    version: 1,
    ...overrides,
  };
}

/** `GET /properties` as the backend answers it: the whole catalogue, built-ins first. */
function propertyModel(properties: readonly SiteProperty[] = codePropertyCatalog.all) {
  return {
    properties,
    layouts: {},
    capabilities: { canManage: true },
    requestId: 'req_test',
  };
}

/** A site that hid City, and added a referral code and a tier with a retired option. */
const siteModel = propertyModel([
  ...codePropertyCatalog.all.map((entry) =>
    entry.key === 'city' ? { ...entry, hidden: true, version: 2 } : entry,
  ),
  customProperty({ key: 'custom_referral_code', label: 'Referral code', kind: 'text' }),
  customProperty({
    key: 'custom_tier',
    label: 'Tier',
    kind: 'choice',
    options: [
      { value: 'bronze', label: 'Bronze', hidden: true },
      { value: 'gold', label: 'Gold', hidden: false },
    ],
  }),
]);

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

  it('keeps hidden table columns, the layout and the saved view in the URL', () => {
    const query = parseInboxQuery(
      new URLSearchParams({
        type: 'internet',
        layout: 'board',
        view: '40000000-0000-4000-8000-000000000001',
        hide: 'source,bogus,created,source',
      }),
    );
    expect(query).toMatchObject({
      layout: 'board',
      view: '40000000-0000-4000-8000-000000000001',
      hide: ['source', 'created'],
    });
    expect(inboxSearch(query)).toBe(
      '?type=internet&layout=board&view=40000000-0000-4000-8000-000000000001&hide=source%2Ccreated',
    );
    expect(parseInboxQuery(new URLSearchParams(inboxSearch(query).slice(1)))).toEqual(query);
    // A link from before saved views (`view=board`) still opens the board.
    const legacy = parseInboxQuery(new URLSearchParams('type=internet&view=board'));
    expect(legacy.layout).toBe('board');
    expect(legacy.view).toBeUndefined();
  });

  it('reads custom property filters and columns against the site catalogue', () => {
    const catalog = catalogFromModel(siteModel.properties);
    const params = new URLSearchParams({
      type: 'internet',
      where: JSON.stringify([
        { key: 'custom_referral_code', op: 'eq', value: 'FRIEND' },
        { key: 'city', op: 'eq', value: 'Calgary' },
      ]),
      cols: 'custom_tier,city',
    });
    expect(parseInboxQuery(params, catalog)).toMatchObject({
      where: [{ key: 'custom_referral_code', op: 'eq', value: 'FRIEND' }],
      columns: ['custom_tier'],
    });
    expect(parseInboxQuery(params).where).toEqual([{ key: 'city', op: 'eq', value: 'Calgary' }]);
  });
});

describe('LeadsInbox', () => {
  beforeEach(() => {
    navigation.replace.mockClear();
    navigation.search = '';
    window.localStorage.clear();
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.listWorkspaceMembers.mockResolvedValue({ members: [] });
    mocks.getPropertyModel.mockResolvedValue(propertyModel());
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
      '/w/canadawide/leads?type=internet&layout=board',
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
    fireEvent.click(await screen.findByRole('button', { name: 'Filter' }));
    const propertySelect = await screen.findByLabelText('Property');

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
    const remove = await screen.findByRole('button', {
      name: 'Remove filter Visa / permit type',
    });
    expect(remove.parentElement?.textContent).toBe('Visa / permit type:is Study permit');

    fireEvent.click(remove);
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
    expect(screen.queryByRole('button', { name: 'Filter' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sort' })).toBeNull();
    // The table's own columns can still be hidden; property columns need contact access.
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    expect(await screen.findByRole('checkbox', { name: 'Source' })).toBeTruthy();
    expect(screen.queryByText('Property columns (up to 6)')).toBeNull();
    const leadHeader = screen.getByRole('columnheader', { name: 'Lead' });
    expect(leadHeader.getAttribute('aria-sort')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Lead' })).toBeNull();
  });

  it('filters by the site’s own properties and leaves out a property the site hid', async () => {
    mocks.getPropertyModel.mockResolvedValue(siteModel);
    navigation.search = 'type=internet';
    render(<LeadsInbox workspaceSlug="canadawide" />);
    expect(mocks.getPropertyModel).toHaveBeenCalledWith('staff-token', WORKSPACE);

    fireEvent.click(await screen.findByRole('button', { name: 'Filter' }));
    const propertySelect = await screen.findByLabelText('Property');
    await waitFor(() =>
      expect(
        Array.from(propertySelect.querySelectorAll('option')).map((opt) => opt.textContent),
      ).toContain('Referral code'),
    );
    const labels = Array.from(propertySelect.querySelectorAll('option')).map(
      (opt) => opt.textContent,
    );
    expect(labels).not.toContain('City');
    expect(labels).toContain('Street address');

    // A retired option still reads, marked, so old leads can be found.
    fireEvent.change(propertySelect, { target: { value: 'custom_tier' } });
    const tierValue = screen.getByLabelText('Value');
    expect(Array.from(tierValue.querySelectorAll('option')).map((opt) => opt.textContent)).toEqual([
      'Bronze (retired)',
      'Gold',
    ]);
    // The draft starts on an option still offered, not the retired one.
    expect(tierValue).toHaveProperty('value', 'gold');

    fireEvent.change(propertySelect, { target: { value: 'custom_referral_code' } });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'FRIEND' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filter' }));
    expect(navigation.replace).toHaveBeenLastCalledWith(
      `/w/canadawide/leads?type=internet&where=${encodeURIComponent(
        JSON.stringify([{ key: 'custom_referral_code', op: 'eq', value: 'FRIEND' }]),
      )}`,
      { scroll: false },
    );
  });

  it('waits for the site catalogue before loading a view that names a custom property', async () => {
    let answer: (value: typeof siteModel) => void = () => undefined;
    mocks.getPropertyModel.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    navigation.search = 'type=internet&cols=custom_tier';
    render(<LeadsInbox workspaceSlug="canadawide" />);
    await screen.findByRole('tab', { name: /Internet/ });
    expect(mocks.getStaffLeads).not.toHaveBeenCalled();
    await act(async () => {
      answer(siteModel);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(mocks.getStaffLeads).toHaveBeenCalledWith(
        'staff-token',
        WORKSPACE,
        expect.objectContaining({ columns: ['custom_tier'] }),
      ),
    );
    expect(mocks.getStaffLeads).toHaveBeenCalledTimes(1);
  });

  it('hides and shows table columns through the URL', async () => {
    navigation.search = 'type=internet';
    const view = render(<LeadsInbox workspaceSlug="canadawide" />);
    expect(await screen.findByRole('columnheader', { name: 'Source' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Source' }));
    expect(navigation.replace).toHaveBeenLastCalledWith(
      '/w/canadawide/leads?type=internet&hide=source',
      { scroll: false },
    );

    view.unmount();
    render(<LeadsInbox workspaceSlug="canadawide" />);
    await screen.findByRole('columnheader', { name: 'Stage' });
    expect(screen.queryByRole('columnheader', { name: 'Source' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    const source = await screen.findByRole('checkbox', { name: 'Source' });
    expect(source.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(source);
    expect(navigation.replace).toHaveBeenLastCalledWith('/w/canadawide/leads?type=internet', {
      scroll: false,
    });
  });

  it('moves the hidden columns this browser kept into the URL once', async () => {
    window.localStorage.setItem(
      `gt-table-hidden-cols:${WORKSPACE}`,
      JSON.stringify(['created', 'source', 'nonsense']),
    );
    navigation.search = 'type=internet&q=avery';
    render(<LeadsInbox workspaceSlug="canadawide" />);
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith(
        '/w/canadawide/leads?type=internet&q=avery&hide=source%2Ccreated',
        { scroll: false },
      ),
    );
    expect(window.localStorage.getItem(`gt-table-hidden-cols:${WORKSPACE}`)).toBeNull();
    expect(navigation.replace).toHaveBeenCalledTimes(1);
  });

  it('sorts from the sort menu', async () => {
    navigation.search = 'type=internet';
    render(<LeadsInbox workspaceSlug="canadawide" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sort' }));
    const menu = await screen.findByRole('dialog');
    fireEvent.click(within(menu).getByRole('button', { name: 'Created' }));
    expect(navigation.replace).toHaveBeenLastCalledWith(
      '/w/canadawide/leads?type=internet&sort=createdAt%3Adesc',
      { scroll: false },
    );
  });

  it('says when the site’s properties cannot be read and keeps what the URL asked for', async () => {
    mocks.getPropertyModel.mockRejectedValue(new Error('down'));
    const where = JSON.stringify([{ key: 'custom_referral_code', op: 'eq', value: 'FRIEND' }]);
    navigation.search = `type=internet&where=${encodeURIComponent(where)}&cols=custom_tier`;
    render(<LeadsInbox workspaceSlug="canadawide" />);
    expect(
      await screen.findByText(
        "Could not load the site's properties; showing built-in ones. Reason: internal_error.",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Could not load the site's properties/).getAttribute('role')).toBe(
      'alert',
    );

    // Switching tab must not drop the custom filter and column the built-ins cannot read.
    fireEvent.click(await screen.findByRole('tab', { name: /Mobility/ }));
    expect(navigation.replace).toHaveBeenLastCalledWith(
      `/w/canadawide/leads?type=mobility&where=${encodeURIComponent(where)}&cols=custom_tier`,
      { scroll: false },
    );
  });

  it('holds the board until the site catalogue reads a custom filter', async () => {
    let answer: (value: typeof siteModel) => void = () => undefined;
    mocks.getPropertyModel.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    mocks.getLeadBoard.mockResolvedValue({
      leadType: 'internet',
      columns: [],
      access: { contacts: true, manage: true },
    });
    const where = JSON.stringify([{ key: 'custom_referral_code', op: 'eq', value: 'FRIEND' }]);
    navigation.search = `type=internet&layout=board&where=${encodeURIComponent(where)}`;
    render(<LeadsInbox workspaceSlug="canadawide" />);
    await screen.findByRole('tab', { name: /Internet/ });
    expect(mocks.getLeadBoard).not.toHaveBeenCalled();
    await act(async () => {
      answer(siteModel);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(mocks.getLeadBoard).toHaveBeenCalledWith(
        'staff-token',
        WORKSPACE,
        expect.objectContaining({
          where: [{ key: 'custom_referral_code', op: 'eq', value: 'FRIEND' }],
        }),
      ),
    );
    expect(mocks.getLeadBoard).toHaveBeenCalledTimes(1);
  });
});
