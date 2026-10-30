import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildPropertyCatalog,
  codePropertyCatalog,
  DEFAULT_LEAD_VIEW_STATE,
  savedViewStateSchema,
  type PlanOption,
  type SavedView,
  type SiteProperty,
} from '@gt-sales/contracts';

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
  listSavedViews: vi.fn(),
  createSavedView: vi.fn(),
  updateSavedView: vi.fn(),
  deleteSavedView: vi.fn(),
  getStaffLead: vi.fn(),
  markLeadOpened: vi.fn(),
  updateStaffLead: vi.fn(),
}));

const backend = vi.hoisted(() => ({
  BackendError: class BackendError extends Error {
    readonly code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
}));

vi.mock('../../lib/api', () => ({
  ...mocks,
  BackendError: backend.BackendError,
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
    websiteVisible: false,
    leadTypes: [],
    editable: true,
    version: 1,
    ...overrides,
  };
}

/** `GET /properties` as the backend answers it: the whole catalogue, built-ins first. */
function propertyModel(
  properties: readonly SiteProperty[] = codePropertyCatalog.all,
  plans?: readonly PlanOption[],
) {
  return {
    properties,
    ...(plans ? { plans } : {}),
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

describe('the side panel lead in the URL', () => {
  const LEAD_ID = '90000000-0000-4000-8000-0000000000aa';

  it('keeps ?lead= through other changes and drops one that is not an id', () => {
    const query = parseInboxQuery(new URLSearchParams(`type=internet&page=2&lead=${LEAD_ID}`));
    expect(query.lead).toBe(LEAD_ID);
    expect(inboxSearch({ ...query, stage: 'won' })).toBe(
      `?type=internet&stage=won&page=2&lead=${LEAD_ID}`,
    );
    expect(parseInboxQuery(new URLSearchParams(inboxSearch(query).slice(1)))).toEqual(query);
    expect(parseInboxQuery(new URLSearchParams('lead=not-a-lead')).lead).toBeUndefined();
  });
});

describe('LeadsInbox', () => {
  beforeEach(() => {
    navigation.replace.mockClear();
    navigation.search = '';
    window.localStorage.clear();
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.listWorkspaceMembers.mockResolvedValue({ members: [] });
    mocks.listSavedViews.mockResolvedValue({ views: [], requestId: 'req_test' });
    mocks.getPropertyModel.mockResolvedValue(propertyModel());
    mocks.getLeadsSummary.mockResolvedValue({
      types: [
        { leadType: 'internet', total: 665 },
        { leadType: 'mobility', total: 39 },
      ],
      archived: 3,
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

  it('offers a tab per lead type the site has, with counts, and the archive', async () => {
    render(<LeadsInbox workspaceSlug="canadawide" />);
    expect(await screen.findByRole('tab', { name: /Internet\s*665/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Mobility\s*39/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /All leads\s*704/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Archive\s*3/ })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /trash/i })).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: /Mobility/ }));
    expect(navigation.replace).toHaveBeenLastCalledWith('/w/canadawide/leads?type=mobility', {
      scroll: false,
    });
    fireEvent.click(screen.getByRole('tab', { name: /Archive/ }));
    expect(navigation.replace).toHaveBeenLastCalledWith('/w/canadawide/leads?archived=1', {
      scroll: false,
    });
  });

  it('lays out the toolbar: the view switcher ends the tabs row, outline buttons follow the filters', async () => {
    navigation.search = 'type=internet';
    render(<LeadsInbox workspaceSlug="canadawide" />);
    const tablist = await screen.findByRole('tablist', { name: 'Lead types' });
    // The saved-view switcher sits at the right end of the type tabs' row, outside the tablist.
    const switcher = await screen.findByRole('button', { name: /^All leads/ });
    expect(tablist.contains(switcher)).toBe(false);
    expect(tablist.parentElement?.contains(switcher)).toBe(true);
    expect(switcher.closest('.ml-auto')).toBeTruthy();

    // One filter row: search, stage, assignee, Add filter, then Sort and Columns on the right.
    const addFilter = await screen.findByRole('button', { name: 'Add filter' });
    const row = addFilter.parentElement;
    expect(row?.contains(screen.getByRole('searchbox'))).toBe(true);
    expect(row?.contains(screen.getByLabelText('Assignee'))).toBe(true);
    const sort = screen.getByRole('button', { name: 'Sort' });
    const columns = screen.getByRole('button', { name: 'Columns' });
    expect(sort.closest('.ml-auto')?.parentElement).toBe(row);
    expect(columns.closest('.ml-auto')).toBe(sort.closest('.ml-auto'));
    expect(screen.queryByRole('button', { name: 'View options' })).toBeNull();
    // No chips row while nothing is filtered.
    expect(screen.queryByRole('region', { name: 'Active filters' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
  });

  it('offers View options and no Columns on the board', async () => {
    mocks.getLeadBoard.mockResolvedValue({
      leadType: 'internet',
      columns: [],
      access: { contacts: true, manage: true },
    });
    navigation.search = 'type=internet&layout=board';
    render(<LeadsInbox workspaceSlug="canadawide" />);
    expect(await screen.findByRole('button', { name: 'View options' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Columns' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sort' })).toBeNull();
  });

  it('opens the archive from ?archived=1, with no board and no trash in its words', async () => {
    navigation.search = 'archived=1';
    render(<LeadsInbox workspaceSlug="canadawide" />);
    const tab = await screen.findByRole('tab', { name: /Archive\s*3/ });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    await waitFor(() =>
      expect(mocks.getStaffLeads).toHaveBeenCalledWith(
        'staff-token',
        WORKSPACE,
        expect.objectContaining({ view: 'archived' }),
      ),
    );
    expect(await screen.findByText('The archive is empty.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Board/ }).getAttribute('title')).toBe(
      'The archive has no board',
    );
    expect(document.body.textContent ?? '').not.toMatch(/trash/i);
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it('reads a link from before Archive, ?trash=1, as the archive and rewrites it as archived=1', async () => {
    navigation.search = 'trash=1';
    render(<LeadsInbox workspaceSlug="canadawide" />);
    const tab = await screen.findByRole('tab', { name: /Archive\s*3/ });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith('/w/canadawide/leads?archived=1', {
        scroll: false,
      }),
    );
    expect(mocks.getStaffLeads).toHaveBeenCalledWith(
      'staff-token',
      WORKSPACE,
      expect.objectContaining({ view: 'archived' }),
    );
  });

  it('filters an order type by its plan, payment status, carrier commission and quantity', async () => {
    const plans: PlanOption[] = [
      {
        id: '70000000-0000-4000-8000-000000000001',
        name: 'Unlimited 50',
        active: true,
        leadType: 'sim_order',
      },
      {
        id: '70000000-0000-4000-8000-000000000002',
        name: 'Legacy 10',
        active: false,
        leadType: 'sim_order',
      },
      // Another type's plan: the SIM order filter does not list it.
      {
        id: '70000000-0000-4000-8000-000000000003',
        name: 'Fibre 500',
        active: true,
        leadType: 'internet',
      },
    ];
    mocks.getPropertyModel.mockResolvedValue(
      propertyModel(buildPropertyCatalog([], 'lead', { plans }).all, plans),
    );
    navigation.search = 'type=sim_order';
    render(<LeadsInbox workspaceSlug="canadawide" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add filter' }));
    const propertySelect = await screen.findByLabelText('Property');
    const labels = Array.from(propertySelect.querySelectorAll('option')).map(
      (opt) => opt.textContent,
    );
    expect(labels).toEqual(
      expect.arrayContaining(['Plan', 'Quantity', 'Payment status', 'Carrier commission']),
    );
    fireEvent.change(propertySelect, { target: { value: 'paymentStatus' } });
    expect(
      Array.from(screen.getByLabelText('Value').querySelectorAll('option')).map(
        (opt) => opt.textContent,
      ),
    ).toEqual(['Not needed', 'Pending', 'Paid']);
    fireEvent.change(propertySelect, { target: { value: 'plan' } });
    await waitFor(() =>
      expect(
        Array.from(screen.getByLabelText('Value').querySelectorAll('option')).map(
          (opt) => opt.textContent,
        ),
      ).toEqual(['Unlimited 50', 'Legacy 10 (retired)']),
    );
  });

  it('names each plan’s type in the filter across all types', async () => {
    const plans: PlanOption[] = [
      {
        id: '70000000-0000-4000-8000-000000000001',
        name: 'Basic',
        active: true,
        leadType: 'internet',
      },
      {
        id: '70000000-0000-4000-8000-000000000002',
        name: 'Basic',
        active: true,
        leadType: 'mobility',
      },
    ];
    mocks.getPropertyModel.mockResolvedValue(
      propertyModel(buildPropertyCatalog([], 'lead', { plans }).all, plans),
    );
    render(<LeadsInbox workspaceSlug="canadawide" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add filter' }));
    const propertySelect = await screen.findByLabelText('Property');
    await waitFor(() =>
      expect(propertySelect.querySelector('option[value="plan"]')).not.toBeNull(),
    );
    fireEvent.change(propertySelect, { target: { value: 'plan' } });
    await waitFor(() =>
      expect(
        Array.from(screen.getByLabelText('Value').querySelectorAll('option')).map(
          (opt) => opt.textContent,
        ),
      ).toEqual(['Basic (Internet)', 'Basic (Mobility)']),
    );
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
      archived: 3,
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
    fireEvent.click(await screen.findByRole('button', { name: 'Add filter' }));
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
    // The chips row appears under the filter row only while a filter is on.
    const chipsRow = screen.getByRole('region', { name: 'Active filters' });
    expect(chipsRow.contains(remove)).toBe(true);
    expect(within(chipsRow).getByRole('button', { name: 'Clear filters' })).toBeTruthy();
    expect(chipsRow.previousElementSibling?.contains(screen.getByRole('searchbox'))).toBe(true);

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
      archived: 0,
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

    fireEvent.click(await screen.findByRole('button', { name: 'Add filter' }));
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

  it('rewrites a legacy ?trash=1 link and moves the stored hidden columns in one change', async () => {
    window.localStorage.setItem(
      `gt-table-hidden-cols:${WORKSPACE}`,
      JSON.stringify(['created', 'source']),
    );
    navigation.search = 'trash=1&q=avery';
    render(<LeadsInbox workspaceSlug="canadawide" />);
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith(
        '/w/canadawide/leads?archived=1&q=avery&hide=source%2Ccreated',
        { scroll: false },
      ),
    );
    expect(navigation.replace).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(`gt-table-hidden-cols:${WORKSPACE}`)).toBeNull();
    // The address it settled on keeps both.
    const settled = new URLSearchParams(navigation.search);
    expect(settled.get('archived')).toBe('1');
    expect(settled.get('hide')).toBe('source,created');
    expect(settled.has('trash')).toBe(false);
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

  describe('saved views', () => {
    const READY: SavedView = {
      id: '40000000-0000-4000-8000-000000000001',
      object: 'lead',
      name: 'Ready to call',
      state: {
        ...DEFAULT_LEAD_VIEW_STATE,
        leadType: 'internet',
        assignee: 'me',
        hiddenColumns: ['source'],
      },
      version: 2,
      updatedAt: '2026-10-28T10:00:00.000Z',
    };
    const STUDENTS: SavedView = {
      id: '40000000-0000-4000-8000-000000000002',
      object: 'lead',
      name: 'Students',
      state: { ...DEFAULT_LEAD_VIEW_STATE, leadType: 'mobility' },
      version: 1,
      updatedAt: '2026-10-27T10:00:00.000Z',
    };
    const READY_URL = `type=internet&view=${READY.id}&assignee=me&hide=source`;

    beforeEach(() => {
      mocks.listSavedViews.mockResolvedValue({ views: [READY, STUDENTS], requestId: 'req_test' });
    });

    /** The switcher's trigger, found by the name it currently shows. */
    function trigger(name: string | RegExp) {
      return screen.findByRole('button', { name });
    }

    it('loads the staff member’s views once for the site', async () => {
      render(<LeadsInbox workspaceSlug="canadawide" />);
      await trigger('All leads');
      await waitFor(() =>
        expect(mocks.listSavedViews).toHaveBeenCalledWith('staff-token', WORKSPACE),
      );
      expect(mocks.listSavedViews).toHaveBeenCalledTimes(1);
    });

    it('opens a view by rewriting the URL with its state and clearing the search box', async () => {
      navigation.search = 'q=blake';
      render(<LeadsInbox workspaceSlug="canadawide" />);
      fireEvent.click(await trigger('All leads'));
      fireEvent.click(await screen.findByRole('button', { name: 'Ready to call' }));
      expect(navigation.replace).toHaveBeenLastCalledWith(
        `/w/canadawide/leads?type=internet&view=${READY.id}&assignee=me&hide=source`,
        { scroll: false },
      );
      expect(screen.getByRole('searchbox')).toHaveProperty('value', '');
    });

    it('opens a view saved before Archive replaced Trash in the archive', async () => {
      const OLD: SavedView = {
        id: '40000000-0000-4000-8000-000000000003',
        object: 'lead',
        name: 'Old bin',
        // As the contract reads a view saved with the legacy `trash` key.
        state: savedViewStateSchema.parse({
          layout: 'table',
          trash: true,
          due: false,
          where: [],
          columns: [],
          hiddenColumns: [],
        }),
        version: 1,
        updatedAt: '2026-10-26T10:00:00.000Z',
      };
      mocks.listSavedViews.mockResolvedValue({ views: [OLD], requestId: 'req_test' });
      render(<LeadsInbox workspaceSlug="canadawide" />);
      fireEvent.click(await trigger('All leads'));
      fireEvent.click(await screen.findByRole('button', { name: 'Old bin' }));
      expect(navigation.replace).toHaveBeenLastCalledWith(
        `/w/canadawide/leads?archived=1&view=${OLD.id}`,
        { scroll: false },
      );
    });

    it('goes back to All leads with the default state and no view id', async () => {
      navigation.search = `${READY_URL}&sort=createdAt%3Adesc&page=2`;
      render(<LeadsInbox workspaceSlug="canadawide" />);
      fireEvent.click(await trigger(/Ready to call/));
      fireEvent.click(await screen.findByRole('button', { name: 'All leads' }));
      expect(navigation.replace).toHaveBeenLastCalledWith('/w/canadawide/leads', {
        scroll: false,
      });
    });

    it('names the view the URL points at and starts clean', async () => {
      navigation.search = READY_URL;
      render(<LeadsInbox workspaceSlug="canadawide" />);
      const name = await trigger(/Ready to call/);
      expect(name.textContent).not.toContain('Unsaved changes');
      expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
      expect(navigation.replace).not.toHaveBeenCalled();
    });

    it('marks the view changed when a filter is edited and keeps its id in the URL', async () => {
      navigation.search = READY_URL;
      const view = render(<LeadsInbox workspaceSlug="canadawide" />);
      await trigger(/Ready to call/);
      fireEvent.change(screen.getByLabelText('Assignee'), { target: { value: 'none' } });
      expect(navigation.replace).toHaveBeenLastCalledWith(
        `/w/canadawide/leads?type=internet&view=${READY.id}&assignee=none&hide=source`,
        { scroll: false },
      );
      view.rerender(<LeadsInbox workspaceSlug="canadawide" />);
      expect((await trigger(/Ready to call/)).textContent).toContain('Unsaved changes');
      expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Save as new view' })).toBeTruthy();
    });

    it('does not count the search text or the page as a change', async () => {
      navigation.search = `${READY_URL}&q=blake&page=3`;
      render(<LeadsInbox workspaceSlug="canadawide" />);
      expect((await trigger(/Ready to call/)).textContent).not.toContain('Unsaved changes');
    });

    it('saves the current state over the view with its version', async () => {
      navigation.search = READY_URL;
      const view = render(<LeadsInbox workspaceSlug="canadawide" />);
      await trigger(/Ready to call/);
      fireEvent.change(screen.getByLabelText('Assignee'), { target: { value: 'none' } });
      view.rerender(<LeadsInbox workspaceSlug="canadawide" />);
      const state = { ...READY.state, assignee: 'none' };
      mocks.updateSavedView.mockResolvedValue({
        view: { ...READY, state, version: 3 },
        requestId: 'req_test',
      });
      fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
      await waitFor(() =>
        expect(mocks.updateSavedView).toHaveBeenCalledWith('staff-token', WORKSPACE, READY.id, {
          expectedVersion: 2,
          state,
        }),
      );
      // The saved copy is now what the list is compared with.
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /Ready to call/ }).textContent).not.toContain(
          'Unsaved changes',
        ),
      );
      expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    });

    it('says when another tab changed the view first', async () => {
      navigation.search = `${READY_URL}&stage=contacted`;
      mocks.updateSavedView.mockRejectedValue(new backend.BackendError('version_conflict'));
      render(<LeadsInbox workspaceSlug="canadawide" />);
      fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
      expect((await screen.findByRole('alert')).textContent).toBe(
        'This view changed elsewhere. Reload and try again.',
      );
    });

    it('saves the list as a new view and moves onto it', async () => {
      navigation.search = 'type=internet&assignee=me';
      mocks.createSavedView.mockResolvedValue({
        view: {
          ...READY,
          id: '40000000-0000-4000-8000-000000000003',
          name: 'Internet mine',
          version: 1,
          state: { ...DEFAULT_LEAD_VIEW_STATE, leadType: 'internet', assignee: 'me' },
        },
        requestId: 'req_test',
      });
      const view = render(<LeadsInbox workspaceSlug="canadawide" />);
      fireEvent.click(await screen.findByRole('button', { name: 'Save as new view' }));
      const dialog = await screen.findByRole('dialog', { name: 'Save as new view' });
      fireEvent.change(within(dialog).getByLabelText('View name'), {
        target: { value: 'Internet mine' },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save view' }));
      await waitFor(() =>
        expect(mocks.createSavedView).toHaveBeenCalledWith('staff-token', WORKSPACE, {
          object: 'lead',
          name: 'Internet mine',
          state: { ...DEFAULT_LEAD_VIEW_STATE, leadType: 'internet', assignee: 'me' },
        }),
      );
      await waitFor(() =>
        expect(navigation.replace).toHaveBeenLastCalledWith(
          '/w/canadawide/leads?type=internet&view=40000000-0000-4000-8000-000000000003&assignee=me',
          { scroll: false },
        ),
      );
      view.rerender(<LeadsInbox workspaceSlug="canadawide" />);
      const name = await trigger(/Internet mine/);
      expect(name.textContent).not.toContain('Unsaved changes');
    });

    it.each([
      ['saved_view_name_taken', 'A view with that name already exists.'],
      ['saved_view_limit', 'You already have 30 views. Delete one first.'],
    ])('shows %s in the dialog and keeps it open', async (code, message) => {
      navigation.search = 'type=internet';
      mocks.createSavedView.mockRejectedValue(new backend.BackendError(code));
      render(<LeadsInbox workspaceSlug="canadawide" />);
      fireEvent.click(await screen.findByRole('button', { name: 'Save as new view' }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.change(within(dialog).getByLabelText('View name'), {
        target: { value: 'Students' },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save view' }));
      expect((await within(dialog).findByRole('alert')).textContent).toBe(message);
      expect(navigation.replace).not.toHaveBeenCalled();
    });

    it('renames a view with its version', async () => {
      render(<LeadsInbox workspaceSlug="canadawide" />);
      fireEvent.click(await trigger('All leads'));
      fireEvent.click(await screen.findByRole('button', { name: 'Rename Students' }));
      mocks.updateSavedView.mockResolvedValue({
        view: { ...STUDENTS, name: 'Mobility', version: 2 },
        requestId: 'req_test',
      });
      const dialog = await screen.findByRole('dialog', { name: 'Rename view' });
      fireEvent.change(within(dialog).getByLabelText('View name'), {
        target: { value: 'Mobility' },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
      await waitFor(() =>
        expect(mocks.updateSavedView).toHaveBeenCalledWith('staff-token', WORKSPACE, STUDENTS.id, {
          expectedVersion: 1,
          name: 'Mobility',
        }),
      );
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      fireEvent.click(screen.getByRole('button', { name: 'All leads' }));
      expect(await screen.findByRole('button', { name: 'Mobility' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Students' })).toBeNull();
    });

    it('deletes the open view and drops its id, keeping the filters', async () => {
      navigation.search = READY_URL;
      mocks.deleteSavedView.mockResolvedValue({ viewId: READY.id, requestId: 'req_test' });
      render(<LeadsInbox workspaceSlug="canadawide" />);
      fireEvent.click(await trigger(/Ready to call/));
      fireEvent.click(await screen.findByRole('button', { name: 'Delete Ready to call' }));
      const dialog = await screen.findByRole('dialog', { name: 'Delete view' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete view' }));
      await waitFor(() =>
        expect(mocks.deleteSavedView).toHaveBeenCalledWith('staff-token', WORKSPACE, READY.id),
      );
      await waitFor(() =>
        expect(navigation.replace).toHaveBeenLastCalledWith(
          '/w/canadawide/leads?type=internet&assignee=me&hide=source',
          { scroll: false },
        ),
      );
    });

    it('shows All leads for a view id the list does not have, leaving the URL alone', async () => {
      navigation.search = 'type=internet&view=40000000-0000-4000-8000-0000000000ff';
      const view = render(<LeadsInbox workspaceSlug="canadawide" />);
      fireEvent.click(await trigger(/All leads/));
      // The list is here once it names the views.
      await screen.findByRole('button', { name: 'Ready to call' });
      fireEvent.keyDown(screen.getByRole('button', { name: 'Ready to call' }), { key: 'Escape' });
      expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
      expect(navigation.replace).not.toHaveBeenCalled();
      // Until the user acts: the next change drops the dead id.
      fireEvent.change(screen.getByLabelText('Assignee'), { target: { value: 'me' } });
      expect(navigation.replace).toHaveBeenLastCalledWith(
        '/w/canadawide/leads?type=internet&assignee=me',
        { scroll: false },
      );
      view.unmount();
    });

    it('opens a view naming a property the site hides without it: clean, and never asks for it', async () => {
      const CITY: SavedView = {
        id: '40000000-0000-4000-8000-000000000003',
        object: 'lead',
        name: 'Calgary installs',
        state: {
          ...DEFAULT_LEAD_VIEW_STATE,
          leadType: 'internet',
          where: [
            { key: 'city', op: 'eq', value: 'Calgary' },
            { key: 'planId', op: 'notEmpty' },
          ],
          sort: 'prop.city:desc',
          columns: ['city', 'planId'],
        },
        version: 1,
        updatedAt: '2026-10-28T10:00:00.000Z',
      };
      mocks.listSavedViews.mockResolvedValue({ views: [CITY], requestId: 'req_test' });
      // The site hid the built-in City since the view was saved.
      mocks.getPropertyModel.mockResolvedValue(siteModel);
      // As the backend answers a list that filters, sorts or shows a hidden property.
      mocks.getStaffLeads.mockImplementation(
        async (_token: string, _site: string, query: unknown) => {
          if (JSON.stringify(query).includes('city'))
            throw new backend.BackendError('invalid_request');
          return { ...emptyPage, access: { contacts: true, manage: true } };
        },
      );

      const view = render(<LeadsInbox workspaceSlug="canadawide" />);
      fireEvent.click(await trigger('All leads'));
      fireEvent.click(await screen.findByRole('button', { name: 'Calgary installs' }));

      const url = navigation.replace.mock.lastCall?.[0];
      expect(typeof url).toBe('string');
      expect(String(url)).not.toContain('city');
      const params = new URLSearchParams(String(url).split('?')[1]);
      expect(params.get('view')).toBe(CITY.id);
      expect(params.get('type')).toBe('internet');
      expect(params.get('cols')).toBe('planId');
      expect(JSON.parse(params.get('where') ?? '[]')).toEqual([{ key: 'planId', op: 'notEmpty' }]);
      expect(params.get('sort')).toBeNull();

      view.rerender(<LeadsInbox workspaceSlug="canadawide" />);
      expect((await trigger(/Calgary installs/)).textContent).not.toContain('Unsaved changes');
      expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
      await waitFor(() =>
        expect(mocks.getStaffLeads).toHaveBeenCalledWith(
          'staff-token',
          WORKSPACE,
          expect.objectContaining({ columns: ['planId'] }),
        ),
      );
      // No list request named the hidden property, so none was refused with a 400.
      for (const [, , query] of mocks.getStaffLeads.mock.calls) {
        expect(JSON.stringify(query)).not.toContain('city');
      }
      expect(screen.queryByText(/invalid_request/)).toBeNull();
    });

    it('says when the views could not be loaded and still works as All leads', async () => {
      mocks.listSavedViews.mockRejectedValue(new backend.BackendError('internal_error'));
      render(<LeadsInbox workspaceSlug="canadawide" />);
      expect(await screen.findByText(/Could not load your saved views/)).toBeTruthy();
      expect(await trigger(/All leads/)).toBeTruthy();
    });
  });
});

describe('LeadsInbox side panel', () => {
  const LEAD_ID = '90000000-0000-4000-8000-0000000000aa';
  const NOW = '2026-10-26T12:00:00.000Z';
  const row = {
    id: LEAD_ID,
    workspaceId: WORKSPACE,
    leadType: 'internet',
    status: 'submitted',
    stage: 'new',
    contact: { fullName: 'Avery Example', email: 'avery@example.test' },
    contactId: null,
    assignedActorId: null,
    externalRef: null,
    source: 'direct',
    attribution: {},
    consentVersion: null,
    openTaskCount: 0,
    nextTaskDueAt: null,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };

  beforeEach(() => {
    navigation.replace.mockClear();
    navigation.push.mockClear();
    navigation.search = '';
    window.localStorage.clear();
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.listWorkspaceMembers.mockResolvedValue({ members: [] });
    mocks.listSavedViews.mockResolvedValue({ views: [], requestId: 'req_test' });
    mocks.getPropertyModel.mockResolvedValue(propertyModel());
    mocks.getLeadsSummary.mockResolvedValue({
      types: [{ leadType: 'internet', total: 1 }],
      archived: 0,
      trash: 0,
      access: { contacts: true, manage: true },
    });
    mocks.getStaffLeads.mockResolvedValue({
      leads: [row],
      page: { page: 2, pageSize: 50, total: 51 },
      access: { contacts: true, manage: true },
    });
    mocks.getStaffLead.mockResolvedValue({
      lead: {
        ...row,
        form: { schemaVersion: 1, payload: { streetAddress: '12 Example Street' } },
        customValues: {},
      },
      activities: [],
      tasks: [],
      related: [],
      identities: [],
      documents: [],
      allowedMoves: [],
      access: { contacts: true, manage: true },
      requestId: 'req_test',
    });
  });

  it('opens the lead named by ?lead= beside the list, with a link to its full page', async () => {
    navigation.search = `type=internet&lead=${LEAD_ID}`;
    render(<LeadsInbox workspaceSlug="canadawide" />);
    const panel = await screen.findByRole('complementary', { name: 'Lead' });
    expect(
      await within(panel).findByRole('heading', { level: 2, name: 'Avery Example' }),
    ).toBeTruthy();
    expect(within(panel).getByText('12 Example Street')).toBeTruthy();
    expect(mocks.getStaffLead).toHaveBeenCalledWith('staff-token', WORKSPACE, LEAD_ID);
    expect(within(panel).getByRole('link', { name: 'Open full page' }).getAttribute('href')).toBe(
      `/w/canadawide/leads/${LEAD_ID}`,
    );
    // The list stays where it was.
    expect(screen.getByRole('table')).toBeTruthy();
  });

  it('opens the panel from a row or its name, keeping the filters and the page', async () => {
    navigation.search = 'type=internet&page=2';
    render(<LeadsInbox workspaceSlug="canadawide" />);
    const name = await screen.findByRole('link', { name: 'Avery Example' });
    expect(name.getAttribute('href')).toBe(
      `/w/canadawide/leads?type=internet&page=2&lead=${LEAD_ID}`,
    );

    fireEvent.click(name);
    expect(navigation.replace).toHaveBeenLastCalledWith(
      `/w/canadawide/leads?type=internet&page=2&lead=${LEAD_ID}`,
      { scroll: false },
    );
    navigation.replace.mockClear();
    fireEvent.click(screen.getByText('avery@example.test'));
    expect(navigation.replace).toHaveBeenLastCalledWith(
      `/w/canadawide/leads?type=internet&page=2&lead=${LEAD_ID}`,
      { scroll: false },
    );
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it('closes from Escape or its button, clearing only ?lead=, and hands focus back', async () => {
    navigation.search = `type=internet&page=2&lead=${LEAD_ID}`;
    const view = render(<LeadsInbox workspaceSlug="canadawide" />);
    const panel = await screen.findByRole('complementary', { name: 'Lead' });
    await within(panel).findByRole('heading', { name: 'Avery Example' });

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(navigation.replace).toHaveBeenLastCalledWith(
      '/w/canadawide/leads?type=internet&page=2',
      {
        scroll: false,
      },
    );
    view.rerender(<LeadsInbox workspaceSlug="canadawide" />);
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Lead' })).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Avery Example' })),
    );

    navigation.search = `type=internet&lead=${LEAD_ID}`;
    view.rerender(<LeadsInbox workspaceSlug="canadawide" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Close panel' }));
    expect(navigation.replace).toHaveBeenLastCalledWith('/w/canadawide/leads?type=internet', {
      scroll: false,
    });
  });
  it('asks for the list again once, on close, after a change saved in the panel', async () => {
    mocks.updateStaffLead.mockResolvedValue({
      lead: { ...row, stage: 'contacted', form: null, customValues: {} },
      activities: [],
      allowedMoves: [],
      requestId: 'req_test',
    });
    navigation.search = `type=internet&page=2&lead=${LEAD_ID}`;
    const view = render(<LeadsInbox workspaceSlug="canadawide" />);
    const panel = await screen.findByRole('complementary', { name: 'Lead' });
    await waitFor(() => expect(mocks.getStaffLeads).toHaveBeenCalledTimes(1));
    const [listCall] = mocks.getStaffLeads.mock.calls;

    fireEvent.change(await within(panel).findByLabelText('Stage'), {
      target: { value: 'contacted' },
    });
    await waitFor(() => expect(mocks.updateStaffLead).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(within(panel).getByLabelText<HTMLSelectElement>('Stage').value).toBe('contacted'),
    );
    expect(mocks.getStaffLeads).toHaveBeenCalledTimes(1);

    fireEvent.click(within(panel).getByRole('button', { name: 'Close panel' }));
    view.rerender(<LeadsInbox workspaceSlug="canadawide" />);
    await waitFor(() => expect(mocks.getStaffLeads).toHaveBeenCalledTimes(2));
    expect(mocks.getStaffLeads.mock.calls[1]).toEqual(listCall);

    // Closing a panel where nothing changed asks for nothing.
    navigation.search = `type=internet&page=2&lead=${LEAD_ID}`;
    view.rerender(<LeadsInbox workspaceSlug="canadawide" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Close panel' }));
    view.rerender(<LeadsInbox workspaceSlug="canadawide" />);
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Lead' })).toBeNull());
    expect(mocks.getStaffLeads).toHaveBeenCalledTimes(2);
  });

  it('asks for the counts again on close after a change in the panel, not after a close without one', async () => {
    mocks.updateStaffLead.mockResolvedValue({
      lead: { ...row, stage: 'contacted', form: null, customValues: {} },
      activities: [],
      allowedMoves: [],
      requestId: 'req_test',
    });
    navigation.search = `type=internet&lead=${LEAD_ID}`;
    const view = render(<LeadsInbox workspaceSlug="canadawide" />);
    const panel = await screen.findByRole('complementary', { name: 'Lead' });
    await waitFor(() => expect(mocks.getLeadsSummary).toHaveBeenCalledTimes(1));

    // Nothing changed: closing asks for no counts.
    fireEvent.click(within(panel).getByRole('button', { name: 'Close panel' }));
    view.rerender(<LeadsInbox workspaceSlug="canadawide" />);
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Lead' })).toBeNull());
    expect(mocks.getLeadsSummary).toHaveBeenCalledTimes(1);

    // A change saved in the panel: closing asks for the counts once more.
    mocks.getLeadsSummary.mockResolvedValue({
      types: [{ leadType: 'internet', total: 0 }],
      archived: 1,
      trash: 1,
      access: { contacts: true, manage: true },
    });
    navigation.search = `type=internet&lead=${LEAD_ID}`;
    view.rerender(<LeadsInbox workspaceSlug="canadawide" />);
    const reopened = await screen.findByRole('complementary', { name: 'Lead' });
    fireEvent.change(await within(reopened).findByLabelText('Stage'), {
      target: { value: 'contacted' },
    });
    await waitFor(() => expect(mocks.updateStaffLead).toHaveBeenCalledTimes(1));
    expect(mocks.getLeadsSummary).toHaveBeenCalledTimes(1);
    fireEvent.click(within(reopened).getByRole('button', { name: 'Close panel' }));
    view.rerender(<LeadsInbox workspaceSlug="canadawide" />);
    await waitFor(() => expect(mocks.getLeadsSummary).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('tab', { name: /Archive\s*1/ })).toBeTruthy();
  });
});
