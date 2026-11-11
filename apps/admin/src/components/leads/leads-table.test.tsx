import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPropertyCatalog, type PropertyRow } from '@gt-sales/contracts';

import type { InboxQuery } from './inbox-query';
import { LeadsTable, NO_LEAD_SELECTION, type LeadSelection } from './leads-table';

const WORKSPACE = '10000000-0000-4000-8000-000000000001';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

const mocks = vi.hoisted(() => ({ getStaffLeads: vi.fn() }));

vi.mock('../../lib/api', () => ({
  ...mocks,
  BackendError: class extends Error {},
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
      expect(onLoaded).toHaveBeenCalledWith({ total: 2 });
      expect(screen.queryByRole('status', { name: 'Selected leads' })).toBeNull();

      fireEvent.click(avery);
      expect(onOpen).not.toHaveBeenCalled();
      expect(avery.getAttribute('aria-checked')).toBe('true');
      expect([...latest.selected]).toEqual([LEAD_1]);
      const bar = screen.getByRole('status', { name: 'Selected leads' });
      expect(within(bar).getByText('1 selected')).toBeTruthy();
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
