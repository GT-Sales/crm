import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPropertyCatalog, type PropertyRow } from '@gt-sales/contracts';

import { relativeTime } from '../../lib/dates';
import { readableSource } from '../../lib/source-label';
import type { InboxQuery } from './inbox-query';
import { LeadsTable, NO_LEAD_SELECTION, type LeadSelection } from './leads-table';

const WORKSPACE = '10000000-0000-4000-8000-000000000001';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

const mocks = vi.hoisted(() => ({ getStaffLeads: vi.fn(), updateStaffLead: vi.fn() }));

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

function row(overrides: Partial<PropertyRow> & Pick<PropertyRow, 'key' | 'label' | 'kind'>) {
  return {
    object: 'lead',
    origin: 'custom',
    options: [],
    staffOnly: false,
    sensitive: false,
    hidden: false,
    websiteVisible: false,
    leadTypes: [],
    position: 0,
    version: 1,
    createdAt: '2026-10-29T09:00:00.000Z',
    updatedAt: '2026-10-29T09:00:00.000Z',
    ...overrides,
  } satisfies PropertyRow;
}

const catalog = buildPropertyCatalog([
  row({ key: 'custom_deposit', label: 'Deposit', kind: 'money', position: 0 }),
  row({ key: 'custom_website', label: 'Website', kind: 'url', position: 1 }),
]);

const query: InboxQuery = {
  type: 'internet',
  archived: false,
  due: false,
  layout: 'table',
  hide: ['source'],
  columns: ['custom_deposit', 'custom_website'],
  page: 1,
};

describe('LeadsTable', () => {
  beforeEach(() => {
    mocks.getStaffLeads.mockReset();
    mocks.getStaffLeads.mockResolvedValue({
      leads: [
        {
          id: '90000000-0000-4000-8000-000000000001',
          workspaceId: WORKSPACE,
          leadType: 'internet',
          status: 'submitted',
          stage: 'new',
          contact: { fullName: 'Avery Example', email: 'avery@example.com' },
          contactId: null,
          assignedActorId: null,
          externalRef: null,
          source: 'direct',
          attribution: {},
          consentVersion: null,
          openTaskCount: 0,
          nextTaskDueAt: null,
          countdownDate: null,
          deletedAt: null,
          createdAt: '2026-10-20T09:00:00.000Z',
          updatedAt: '2026-10-21T10:00:00.000Z',
          properties: { custom_deposit: 1999, custom_website: 'https://shop.example/avery' },
        },
      ],
      page: { page: 1, pageSize: 50, total: 1 },
      access: { contacts: true, manage: true },
    });
  });

  it('renders site property columns by kind: money in dollars, a url as a safe link', async () => {
    render(
      <LeadsTable
        workspaceSlug="canadawide"
        workspaceId={WORKSPACE}
        accessToken="staff-token"
        members={[]}
        query={query}
        catalog={catalog}
        canUseProperties
        onPage={vi.fn()}
        onSort={vi.fn()}
      />,
    );
    expect(await screen.findByText('$19.99')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: /Deposit/ })).toBeTruthy();
    const link = screen.getByRole('link', { name: 'https://shop.example/avery' });
    expect(link.getAttribute('rel')).toContain('noreferrer');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(mocks.getStaffLeads).toHaveBeenCalledWith(
      'staff-token',
      WORKSPACE,
      expect.objectContaining({ columns: ['custom_deposit', 'custom_website'] }),
    );
  });

  it('leaves out the columns hidden in the URL and keeps the roomy rows', async () => {
    render(
      <LeadsTable
        workspaceSlug="canadawide"
        workspaceId={WORKSPACE}
        accessToken="staff-token"
        members={[]}
        query={query}
        catalog={catalog}
        canUseProperties
        onPage={vi.fn()}
      />,
    );
    const name = await screen.findByRole('link', { name: 'Avery Example' });
    expect(screen.queryByRole('columnheader', { name: 'Source' })).toBeNull();
    expect(screen.getByRole('columnheader', { name: 'Stage' })).toBeTruthy();
    const cell = name.closest('td');
    // The email sits on its own line under the name, not beside it.
    const secondary = screen.getByText('avery@example.com');
    expect(secondary.closest('td')).toBe(cell);
    expect(secondary.className).toContain('block');
    expect(name.parentElement?.contains(secondary)).toBe(false);
    expect(name.compareDocumentPosition(secondary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // No pinned name column and no cell grid.
    expect(cell?.className).not.toContain('sticky');
    expect(cell?.className).toContain('py-3');
    expect(name.closest('table')?.className).not.toContain('border-separate');
    expect(name.closest('tr')?.className).toContain('border-b');
  });

  it('marks the row whose lead is open in the side panel', async () => {
    const onOpen = vi.fn();
    render(
      <LeadsTable
        workspaceSlug="canadawide"
        workspaceId={WORKSPACE}
        accessToken="staff-token"
        members={[]}
        query={query}
        catalog={catalog}
        canUseProperties
        onPage={vi.fn()}
        panel={{
          openId: '90000000-0000-4000-8000-000000000001',
          href: (id) => `/w/canadawide/leads?lead=${id}`,
          onOpen,
        }}
      />,
    );
    const name = await screen.findByRole('link', { name: 'Avery Example' });
    const tr = name.closest('tr');
    expect(tr?.getAttribute('aria-current')).toBe('true');
    expect(tr?.className).toContain('aria-[current=true]:bg-muted/60');
    expect(name.getAttribute('href')).toBe(
      '/w/canadawide/leads?lead=90000000-0000-4000-8000-000000000001',
    );
  });

  it('lists the archive with the archived view, and says when it is empty', async () => {
    mocks.getStaffLeads.mockResolvedValue({
      leads: [],
      page: { page: 1, pageSize: 50, total: 0 },
      access: { contacts: true, manage: true },
    });
    render(
      <LeadsTable
        workspaceSlug="canadawide"
        workspaceId={WORKSPACE}
        accessToken="staff-token"
        members={[]}
        query={{ archived: true, due: false, layout: 'table', hide: [], page: 1 }}
        catalog={catalog}
        canUseProperties
        onPage={vi.fn()}
      />,
    );
    expect(await screen.findByText('The archive is empty.')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Archived' })).toBeTruthy();
    expect(mocks.getStaffLeads).toHaveBeenCalledWith(
      'staff-token',
      WORKSPACE,
      expect.objectContaining({ view: 'archived' }),
    );
    expect(document.body.textContent ?? '').not.toMatch(/trash/i);
  });
  describe('on a phone', () => {
    it('shows each lead as two lines: name and stage, then type, assignee, source and activity', async () => {
      const onOpen = vi.fn();
      render(
        <LeadsTable
          workspaceSlug="canadawide"
          workspaceId={WORKSPACE}
          accessToken="staff-token"
          members={[]}
          query={{ ...query, type: undefined, hide: [], columns: undefined }}
          catalog={catalog}
          canUseProperties
          onPage={vi.fn()}
          panel={{ href: (id) => `/w/canadawide/leads?lead=${id}`, onOpen }}
        />,
      );
      const name = await screen.findByRole('link', { name: 'Avery Example' });
      const leadCell = name.closest('td');
      if (!leadCell) throw new Error('expected the lead cell');
      // Line one: the name and, below md only, the stage chip.
      const phoneStage = within(leadCell).getByText('New').closest('.md\\:hidden');
      expect(phoneStage).toBeTruthy();
      expect(name.parentElement?.contains(phoneStage ?? null)).toBe(true);
      // Line two, below md only: type, assignee, source and last activity.
      const meta = leadCell.querySelector('[data-slot="lead-row-phone-meta"]');
      expect(meta?.className).toContain('md:hidden');
      expect(meta?.textContent).toBe(
        [
          'Internet',
          'Unassigned',
          readableSource('direct'),
          relativeTime('2026-10-21T10:00:00.000Z'),
        ].join(' · '),
      );
      // The email line and every other column are for wider screens; the table fits a phone.
      expect(screen.getByText('avery@example.com').className).toMatch(/(^| )hidden( |$)/);
      const row = leadCell.closest('tr');
      const others = [...(row?.querySelectorAll('td') ?? [])].filter((td) => td !== leadCell);
      expect(others.length).toBeGreaterThan(5);
      for (const td of others) expect(td.className).toContain('hidden md:table-cell');
      const table = name.closest('table');
      expect(table?.className).toContain('md:min-w-[880px]');
      expect(table?.className).not.toMatch(/(^| )min-w-/);
      // The whole row still opens the lead.
      if (meta) fireEvent.click(meta);
      expect(onOpen).toHaveBeenCalledWith('90000000-0000-4000-8000-000000000001');
    });
  });

  describe('row actions', () => {
    const SELF = '20000000-0000-4000-8000-000000000001';
    const me = {
      membershipId: '30000000-0000-4000-8000-000000000001',
      actorId: SELF,
      displayName: 'Takib',
      roles: ['owner' as const],
      isSelf: true,
    };
    const onOpen = vi.fn();

    function table(members = [me]) {
      return render(
        <LeadsTable
          workspaceSlug="canadawide"
          workspaceId={WORKSPACE}
          accessToken="staff-token"
          members={members}
          query={query}
          catalog={catalog}
          canUseProperties
          onPage={vi.fn()}
          panel={{ href: (id) => `/w/canadawide/leads?lead=${id}`, onOpen }}
        />,
      );
    }

    async function openMenu() {
      const trigger = await screen.findByRole('button', { name: 'Actions for Avery Example' });
      // Its own click never reaches the row.
      fireEvent.click(trigger);
      expect(onOpen).not.toHaveBeenCalled();
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      return screen.findByRole('menu');
    }

    beforeEach(() => {
      onOpen.mockReset();
      mocks.updateStaffLead.mockReset();
      mocks.updateStaffLead.mockResolvedValue({ requestId: 'req_test' });
    });

    it('shows on hover and focus, and always on a touch screen', async () => {
      table();
      const trigger = await screen.findByRole('button', { name: 'Actions for Avery Example' });
      for (const name of [
        'opacity-0',
        'group-hover/row:opacity-100',
        'group-focus-within/row:opacity-100',
        'focus-visible:opacity-100',
        'pointer-coarse:opacity-100',
      ]) {
        expect(trigger.className).toContain(name);
      }
      expect(trigger.closest('tr')?.className).toContain('group/row');
    });

    it('opens the lead, here or in a new tab, assigns it to the viewer and copies the email', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      table();
      let menu = await openMenu();
      expect(
        within(menu)
          .getAllByRole('menuitem')
          .map((item) => item.textContent),
      ).toEqual(['Open lead', 'Open in new tab', 'Assign to me', 'Copy email']);
      const newTab = within(menu).getByRole('menuitem', { name: 'Open in new tab' });
      expect(newTab.getAttribute('href')).toBe(
        '/w/canadawide/leads/90000000-0000-4000-8000-000000000001',
      );
      expect(newTab.getAttribute('target')).toBe('_blank');
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Open lead' }));
      // Once, from the menu: the click does not also reach the row.
      expect(onOpen).toHaveBeenCalledTimes(1);

      onOpen.mockReset();
      menu = await openMenu();
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Assign to me' }));
      await waitFor(() =>
        expect(mocks.updateStaffLead).toHaveBeenCalledWith(
          'staff-token',
          WORKSPACE,
          '90000000-0000-4000-8000-000000000001',
          { assignedActorId: SELF },
        ),
      );
      expect(onOpen).not.toHaveBeenCalled();

      menu = await openMenu();
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Copy email' }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith('avery@example.com'));
      expect((await screen.findByRole('status')).textContent).toBe('Email copied.');
      expect(onOpen).not.toHaveBeenCalled();
    });

    it('leaves out Assign to me for a lead already the viewer’s, or without lead management', async () => {
      mocks.getStaffLeads.mockResolvedValue({
        ...(await mocks.getStaffLeads()),
        leads: [
          {
            ...(await mocks.getStaffLeads()).leads[0],
            assignedActorId: SELF,
            contact: { fullName: 'Avery Example' },
          },
        ],
      });
      const view = table();
      let menu = await openMenu();
      expect(
        within(menu)
          .getAllByRole('menuitem')
          .map((item) => item.textContent),
      ).toEqual(['Open lead', 'Open in new tab']);
      view.unmount();

      mocks.getStaffLeads.mockResolvedValue({
        ...(await mocks.getStaffLeads()),
        leads: [{ ...(await mocks.getStaffLeads()).leads[0], assignedActorId: null }],
        access: { contacts: true, manage: false },
      });
      table();
      menu = await openMenu();
      expect(within(menu).queryByRole('menuitem', { name: 'Assign to me' })).toBeNull();
    });
  });

  it('pads rows less in compact rows', async () => {
    const view = render(
      <LeadsTable
        workspaceSlug="canadawide"
        workspaceId={WORKSPACE}
        accessToken="staff-token"
        members={[]}
        query={query}
        catalog={catalog}
        canUseProperties
        onPage={vi.fn()}
        density="compact"
      />,
    );
    const cell = (await screen.findByRole('link', { name: 'Avery Example' })).closest('td');
    expect(cell?.className).toContain('py-1');
    expect(cell?.className).not.toContain('py-3');
    for (const td of cell?.closest('tr')?.querySelectorAll('td') ?? []) {
      expect(td.className).not.toContain('py-3');
    }
    view.unmount();
  });

  describe('the footer', () => {
    function footer() {
      const element = document.querySelector<HTMLElement>('[data-slot="lead-list-footer"]');
      if (!element) throw new Error('expected the footer');
      return element;
    }

    it('keeps the count but hides the pager when everything is on one page', async () => {
      render(
        <LeadsTable
          workspaceSlug="canadawide"
          workspaceId={WORKSPACE}
          accessToken="staff-token"
          members={[]}
          query={query}
          catalog={catalog}
          canUseProperties
          onPage={vi.fn()}
        />,
      );
      await screen.findByRole('link', { name: 'Avery Example' });
      expect(screen.queryByRole('navigation', { name: 'Lead pages' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
      expect(footer().textContent).toBe('1 lead');
    });

    it('offers first, previous, next and last when there are several pages', async () => {
      mocks.getStaffLeads.mockResolvedValue({
        leads: [],
        page: { page: 2, pageSize: 50, total: 1320 },
        access: { contacts: true, manage: true },
      });
      const onPage = vi.fn();
      render(
        <LeadsTable
          workspaceSlug="canadawide"
          workspaceId={WORKSPACE}
          accessToken="staff-token"
          members={[]}
          query={{ ...query, page: 2 }}
          catalog={catalog}
          canUseProperties
          onPage={onPage}
        />,
      );
      const pager = await screen.findByRole('navigation', { name: 'Lead pages' });
      expect(pager.textContent).toContain('Page 2 of 27');
      expect(footer().firstElementChild?.textContent).toBe('1,320 leads');
      fireEvent.click(within(pager).getByRole('button', { name: 'First page' }));
      expect(onPage).toHaveBeenLastCalledWith(1);
      fireEvent.click(within(pager).getByRole('button', { name: 'Previous' }));
      expect(onPage).toHaveBeenLastCalledWith(1);
      fireEvent.click(within(pager).getByRole('button', { name: 'Next' }));
      expect(onPage).toHaveBeenLastCalledWith(3);
      fireEvent.click(within(pager).getByRole('button', { name: 'Last page' }));
      expect(onPage).toHaveBeenLastCalledWith(27);
    });

    it('keeps the pager on a page past the end, so the list can be found again', async () => {
      mocks.getStaffLeads.mockResolvedValue({
        leads: [],
        page: { page: 4, pageSize: 50, total: 3 },
        access: { contacts: true, manage: true },
      });
      const onPage = vi.fn();
      render(
        <LeadsTable
          workspaceSlug="canadawide"
          workspaceId={WORKSPACE}
          accessToken="staff-token"
          members={[]}
          query={{ ...query, page: 4 }}
          catalog={catalog}
          canUseProperties
          onPage={onPage}
        />,
      );
      const pager = await screen.findByRole('navigation', { name: 'Lead pages' });
      fireEvent.click(within(pager).getByRole('button', { name: 'First page' }));
      expect(onPage).toHaveBeenLastCalledWith(1);
    });
  });

  describe('selecting leads', () => {
    const LEAD_1 = '90000000-0000-4000-8000-000000000001';
    const LEAD_2 = '90000000-0000-4000-8000-000000000002';

    function leadRow(id: string, fullName: string) {
      return {
        id,
        workspaceId: WORKSPACE,
        leadType: 'internet',
        status: 'submitted',
        stage: 'new',
        contact: { fullName },
        contactId: null,
        assignedActorId: null,
        externalRef: null,
        source: 'direct',
        attribution: {},
        consentVersion: null,
        openTaskCount: 0,
        nextTaskDueAt: null,
        countdownDate: null,
        deletedAt: null,
        createdAt: '2026-10-20T09:00:00.000Z',
        updatedAt: '2026-10-21T10:00:00.000Z',
      };
    }

    const onOpen = vi.fn();
    const onLoaded = vi.fn();
    let latest: LeadSelection = NO_LEAD_SELECTION;

    /** The table with its selection held by a parent, as the inbox holds it. */
    function Selectable({ total = 2 }: { total?: number }) {
      const [selection, setSelection] = useState<LeadSelection>(NO_LEAD_SELECTION);
      latest = selection;
      return (
        <LeadsTable
          workspaceSlug="canadawide"
          workspaceId={WORKSPACE}
          accessToken="staff-token"
          members={[]}
          query={{ ...query, columns: undefined }}
          catalog={catalog}
          canUseProperties
          onPage={vi.fn()}
          panel={{ href: (id) => `/w/canadawide/leads?lead=${id}`, onOpen }}
          selection={selection}
          onSelectionChange={setSelection}
          selectionActions={<button type="button">Export</button>}
          onLoaded={onLoaded}
          key={total}
        />
      );
    }

    beforeEach(() => {
      onOpen.mockReset();
      onLoaded.mockReset();
      latest = NO_LEAD_SELECTION;
      mocks.getStaffLeads.mockResolvedValue({
        leads: [leadRow(LEAD_1, 'Avery Example'), leadRow(LEAD_2, 'Blake Example')],
        page: { page: 1, pageSize: 50, total: 2 },
        access: { contacts: true, manage: true, export: true },
      });
    });

    it('changes a stage and an assignee from the row, without opening the lead', async () => {
      mocks.updateStaffLead.mockReset();
      mocks.updateStaffLead.mockResolvedValue({ requestId: 'req_test' });
      render(<Selectable />);
      const stage = await screen.findByRole('button', {
        name: 'Change stage of Avery Example, now New',
      });
      fireEvent.pointerDown(stage, { button: 0, ctrlKey: false });
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Contacted' }));
      await waitFor(() =>
        expect(mocks.updateStaffLead).toHaveBeenCalledWith('staff-token', WORKSPACE, LEAD_1, {
          stage: 'contacted',
        }),
      );
      expect(onOpen).not.toHaveBeenCalled();
      // The list is read again after the change.
      await waitFor(() => expect(mocks.getStaffLeads.mock.calls.length).toBeGreaterThan(1));

      fireEvent.pointerDown(
        screen.getByRole('button', { name: 'Change assignee of Blake Example, now unassigned' }),
        { button: 0, ctrlKey: false },
      );
      expect(await screen.findByRole('menu')).toBeTruthy();
    });

    it('says why a move was refused', async () => {
      mocks.updateStaffLead.mockReset();
      mocks.updateStaffLead.mockRejectedValue(new backend.BackendError('illegal_stage_move'));
      render(<Selectable />);
      fireEvent.pointerDown(
        await screen.findByRole('button', { name: 'Change stage of Avery Example, now New' }),
        { button: 0, ctrlKey: false },
      );
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Contacted' }));
      expect((await screen.findByRole('alert')).textContent).toContain('not allowed from New');
    });

    it('offers no quick edit without lead management', async () => {
      mocks.getStaffLeads.mockResolvedValue({
        leads: [leadRow(LEAD_1, 'Avery Example')],
        page: { page: 1, pageSize: 50, total: 1 },
        access: { contacts: true, manage: false, export: true },
      });
      render(<Selectable total={1} />);
      await screen.findByRole('link', { name: 'Avery Example' });
      expect(screen.queryByRole('button', { name: /^Change stage of/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /^Change assignee of/ })).toBeNull();
    });

    it('has no checkbox column unless a selection is asked for', async () => {
      render(
        <LeadsTable
          workspaceSlug="canadawide"
          workspaceId={WORKSPACE}
          accessToken="staff-token"
          members={[]}
          query={query}
          catalog={catalog}
          canUseProperties
          onPage={vi.fn()}
        />,
      );
      await screen.findByRole('link', { name: 'Avery Example' });
      expect(screen.queryByRole('checkbox')).toBeNull();
    });

    it('ticks a row without opening it; the row and its name still open the lead', async () => {
      render(<Selectable />);
      const avery = await screen.findByRole('checkbox', { name: 'Select Avery Example' });
      expect(onLoaded).toHaveBeenCalledWith({ total: 2, rowIds: [LEAD_1, LEAD_2] });
      expect(screen.queryByRole('status', { name: 'Selected leads' })).toBeNull();

      fireEvent.click(avery);
      expect(onOpen).not.toHaveBeenCalled();
      expect(avery.getAttribute('aria-checked')).toBe('true');
      expect([...latest.selected]).toEqual([LEAD_1]);
      const bar = screen.getByRole('status', { name: 'Selected leads' });
      expect(within(bar).getByText('1 selected')).toBeTruthy();
      // The footer says how many of the list are ticked.
      expect(
        document.querySelector('[data-slot="lead-list-footer"]')?.firstElementChild?.textContent,
      ).toBe('1 of 2 selected');
      // What can be done with the ticked leads sits in the bar.
      expect(within(bar).getByRole('button', { name: 'Export' })).toBeTruthy();
      // A click in the checkbox's cell, beside the box, opens nothing either.
      const cell = avery.closest('td');
      if (!cell) throw new Error('expected a cell');
      fireEvent.click(cell);
      expect(onOpen).not.toHaveBeenCalled();

      // The rest of the row, and the name, open the lead as before.
      fireEvent.click(screen.getByText('Blake Example').closest('tr')?.lastElementChild ?? cell);
      expect(onOpen).toHaveBeenLastCalledWith(LEAD_2);
      fireEvent.click(screen.getByRole('link', { name: 'Avery Example' }));
      expect(onOpen).toHaveBeenLastCalledWith(LEAD_1);

      fireEvent.click(avery);
      expect(latest.selected.size).toBe(0);
      expect(screen.queryByRole('status', { name: 'Selected leads' })).toBeNull();
    });

    it('the header box ticks the page, shows a part-ticked page, and clears it', async () => {
      render(<Selectable />);
      const page = await screen.findByRole('checkbox', { name: 'Select all leads on this page' });
      expect(page.getAttribute('aria-checked')).toBe('false');

      fireEvent.click(screen.getByRole('checkbox', { name: 'Select Blake Example' }));
      expect(page.getAttribute('aria-checked')).toBe('mixed');

      fireEvent.click(page);
      expect(page.getAttribute('aria-checked')).toBe('true');
      expect([...latest.selected].sort()).toEqual([LEAD_1, LEAD_2]);
      // The whole list is on this page, so there is nothing more to offer.
      expect(screen.queryByRole('button', { name: /Select all .* leads matching/ })).toBeNull();

      fireEvent.click(page);
      expect(latest.selected.size).toBe(0);
    });

    it('offers every lead matching once the page is ticked, and one untick goes back to ticks', async () => {
      mocks.getStaffLeads.mockResolvedValue({
        leads: [leadRow(LEAD_1, 'Avery Example'), leadRow(LEAD_2, 'Blake Example')],
        page: { page: 1, pageSize: 50, total: 1320 },
        access: { contacts: true, manage: true, export: true },
      });
      render(<Selectable total={1320} />);
      fireEvent.click(
        await screen.findByRole('checkbox', { name: 'Select all leads on this page' }),
      );
      expect(screen.getByText('2 selected')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Select all 1,320 leads matching' }));
      expect(latest).toEqual({ selected: new Set(), allMatching: true });
      expect(screen.getByText('All 1,320 leads matching are selected')).toBeTruthy();
      expect(
        screen.getByRole('checkbox', { name: 'Select Avery Example' }).getAttribute('aria-checked'),
      ).toBe('true');

      // Unticking one lead leaves this page's others ticked, by id.
      fireEvent.click(screen.getByRole('checkbox', { name: 'Select Avery Example' }));
      expect(latest.allMatching).toBe(false);
      expect([...latest.selected]).toEqual([LEAD_2]);

      fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
      expect(latest).toEqual(NO_LEAD_SELECTION);
    });
  });
});
