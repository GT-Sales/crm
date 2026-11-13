import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPropertyCatalog, type LeadExportFile, type PropertyRow } from '@gt-sales/contracts';

import {
  LeadExportDialog,
  exportFieldsStorageKey,
  type LeadExportDialogProps,
} from './lead-export-dialog';

const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const LEAD_A = '90000000-0000-4000-8000-000000000001';
const LEAD_B = '90000000-0000-4000-8000-000000000002';

const mocks = vi.hoisted(() => ({ exportLeads: vi.fn(), saveBlob: vi.fn() }));

const backend = vi.hoisted(() => ({
  BackendError: class BackendError extends Error {
    readonly code: string;
    readonly details?: Record<string, unknown>;
    constructor(code: string, details?: Record<string, unknown>) {
      super(code);
      this.code = code;
      this.details = details;
    }
  },
}));

vi.mock('../../lib/api', () => ({
  exportLeads: mocks.exportLeads,
  BackendError: backend.BackendError,
}));
vi.mock('../../lib/download', () => ({ saveBlob: mocks.saveBlob }));

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
  row({ key: 'custom_loyalty', label: 'Loyalty number', kind: 'text', position: 0 }),
  row({
    key: 'custom_passport',
    label: 'Passport number',
    kind: 'text',
    sensitive: true,
    position: 1,
  }),
  row({ key: 'custom_gone', label: 'Hidden one', kind: 'text', hidden: true, position: 2 }),
]);

const file: LeadExportFile = {
  blob: new Blob(['PK']),
  fileName: 'getcanadasim-leads-sim-order-2026-11-11.xlsx',
  rowCount: 132,
};

const onOpenChange = vi.fn();
const onExported = vi.fn();

const base: LeadExportDialogProps = {
  open: true,
  onOpenChange,
  workspaceId: WORKSPACE,
  workspaceSlug: 'getcanadasim',
  accessToken: 'staff-token',
  catalog,
  leadType: 'sim_order',
  leadTypes: ['sim_order'],
  access: { contacts: true, revenue: true },
  selectedIds: [],
  filter: { type: 'sim_order', view: 'active', stage: 'pending' },
  matchingTotal: 132,
  // Next task, the arrival countdown, one property column, source and last activity.
  tableFields: [
    'nextTaskDueAt',
    'openTaskCount',
    'prop.arrivalDate',
    'prop.permitType',
    'source',
    'updatedAt',
  ],
  onExported,
};

const show = (props: Partial<LeadExportDialogProps> = {}) =>
  render(<LeadExportDialog {...base} {...props} />);

const group = (name: string) => {
  const heading = screen.getByRole('heading', { name });
  const section = heading.closest('section');
  if (!section) throw new Error(`no section for ${name}`);
  return within(section);
};
const box = (name: string) => screen.getByRole('checkbox', { name });
const isOn = (name: string) => box(name).getAttribute('aria-checked') === 'true';
const isDisabled = (element: HTMLElement) => element.hasAttribute('disabled');
const isChosen = (element: HTMLElement) => element instanceof HTMLInputElement && element.checked;
const exportButton = () => screen.getByRole('button', { name: /^(Export|Preparing file…)$/ });

async function runExport() {
  await act(async () => {
    fireEvent.click(exportButton());
  });
}

describe('LeadExportDialog', () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.exportLeads.mockReset();
    mocks.exportLeads.mockResolvedValue(file);
    mocks.saveBlob.mockReset();
    onOpenChange.mockReset();
    onExported.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens on every lead matching the filters, the main fields listed and the table’s columns ticked', () => {
    show();
    expect(screen.getByRole('dialog', { name: 'Export leads to Excel' })).toBeTruthy();
    // Nothing is ticked in the list, so there is one scope and no choice to make.
    expect(screen.getByText('All leads matching the current filters (132)')).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();

    const main = group('Main fields');
    expect(main.getByText('Always included')).toBeTruthy();
    expect(main.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Order / lead number',
      'Created (UTC)',
      'Lead type',
      'Name',
      'Email',
      'Phone',
      'Stage',
      'Status',
      'Assigned to',
      'Plan',
      'Payment status',
    ]);
    // The main fields are not checkboxes: they cannot be left out.
    expect(main.queryByRole('checkbox')).toBeNull();

    const table = group('Columns shown in the table');
    expect(
      table.getAllByRole('checkbox').map((entry) => entry.getAttribute('aria-checked')),
    ).toEqual(['true', 'true', 'true', 'true', 'true', 'true']);
    expect(table.getByText('6 of 6')).toBeTruthy();
    // A column the table shows is listed once, there, not again in its own group.
    expect(screen.getAllByRole('checkbox', { name: 'Arrival in Canada' })).toHaveLength(1);

    // Everything else is offered, unticked.
    for (const name of ['SIM type', 'Loyalty number', 'Courier', 'UTM campaign', 'Notes']) {
      expect(isOn(name), name).toBe(false);
    }
    expect(group('Form answers').getByText(/^0 of \d+$/)).toBeTruthy();
    expect(
      [
        'Form answers',
        'Custom properties',
        'Order details',
        'Dates',
        'Attribution and source',
        'Notes',
      ].every((name) => screen.getByRole('heading', { name })),
    ).toBe(true);
  });

  it('never offers a sensitive or hidden property, and money only to someone who sees it', () => {
    const { unmount } = show();
    expect(screen.queryByRole('checkbox', { name: 'Passport number' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Hidden one' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Date of birth' })).toBeNull();
    expect(box('Commission (CAD)')).toBeTruthy();
    unmount();

    show({ access: { contacts: true, revenue: false } });
    expect(screen.queryByRole('checkbox', { name: 'Commission (CAD)' })).toBeNull();
    expect(box('Plan price (CAD)')).toBeTruthy();
  });

  it('offers someone without contact access only what the list shows them', () => {
    show({ access: { contacts: false, revenue: false }, tableFields: ['source', 'updatedAt'] });
    expect(
      group('Main fields')
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Order / lead number',
      'Created (UTC)',
      'Lead type',
      'Stage',
      'Status',
      'Assigned to',
    ]);
    expect(screen.queryByRole('heading', { name: 'Form answers' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Custom properties' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Order details' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Notes' })).toBeNull();
    expect(isOn('Source')).toBe(true);
  });

  it('exports the filters with the ticked fields, downloads the file and closes', async () => {
    show();
    fireEvent.click(box('SIM type'));
    fireEvent.click(box('Loyalty number'));
    fireEvent.click(box('Source'));
    await runExport();

    expect(mocks.exportLeads).toHaveBeenCalledTimes(1);
    expect(mocks.exportLeads).toHaveBeenCalledWith('staff-token', WORKSPACE, {
      scope: { kind: 'filter', filter: { type: 'sim_order', view: 'active', stage: 'pending' } },
      // In the dialog's order: the table's columns (Source unticked), then the groups.
      fields: [
        'prop.arrivalDate',
        'prop.permitType',
        'updatedAt',
        'openTaskCount',
        'nextTaskDueAt',
        'prop.delivery',
        'prop.custom_loyalty',
      ],
    });
    expect(mocks.saveBlob).toHaveBeenCalledWith(
      file.blob,
      'getcanadasim-leads-sim-order-2026-11-11.xlsx',
    );
    expect(onExported).toHaveBeenCalledWith({
      rowCount: 132,
      fileName: 'getcanadasim-leads-sim-order-2026-11-11.xlsx',
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('with leads ticked it starts on them, and can switch to every lead matching', async () => {
    show({ selectedIds: [LEAD_A, LEAD_B] });
    const selected = screen.getByRole('radio', { name: 'Selected leads (2)' });
    const matching = screen.getByRole('radio', {
      name: 'All leads matching the current filters (132)',
    });
    expect(isChosen(selected)).toBe(true);
    expect(isChosen(matching)).toBe(false);

    await runExport();
    expect(mocks.exportLeads.mock.lastCall?.[2].scope).toEqual({
      kind: 'ids',
      ids: [LEAD_A, LEAD_B],
    });
  });

  it('switching the scope to every lead matching sends the filters instead of the ids', async () => {
    show({ selectedIds: [LEAD_A, LEAD_B] });
    fireEvent.click(
      screen.getByRole('radio', { name: 'All leads matching the current filters (132)' }),
    );
    await runExport();
    expect(mocks.exportLeads.mock.lastCall?.[2].scope).toEqual({
      kind: 'filter',
      filter: { type: 'sim_order', view: 'active', stage: 'pending' },
    });
  });

  it('ticks and clears a whole group at once', async () => {
    show();
    const dates = group('Dates');
    expect(dates.getByText('0 of 3')).toBeTruthy();
    const all = screen.getByRole('button', { name: 'Select all: Dates' });
    const none = screen.getByRole('button', { name: 'Select none: Dates' });
    expect(isDisabled(none)).toBe(true);

    fireEvent.click(all);
    expect(dates.getByText('3 of 3')).toBeTruthy();
    expect(isOn('Stage changed (UTC)')).toBe(true);
    expect(isDisabled(all)).toBe(true);
    // Other groups are untouched.
    expect(isOn('Courier')).toBe(false);

    fireEvent.click(none);
    expect(dates.getByText('0 of 3')).toBeTruthy();
    expect(isOn('Stage changed (UTC)')).toBe(false);

    fireEvent.click(
      screen.getByRole('button', { name: 'Select none: Columns shown in the table' }),
    );
    await runExport();
    // Nothing optional: the file holds the main fields alone.
    expect(mocks.exportLeads.mock.lastCall?.[2].fields).toEqual([]);
  });

  it('a field is ticked from the keyboard', () => {
    show();
    const courier = box('Courier');
    courier.focus();
    expect(document.activeElement).toBe(courier);
    // A Radix checkbox is a button: Space and Enter arrive as its click.
    fireEvent.click(courier);
    expect(isOn('Courier')).toBe(true);
    fireEvent.click(screen.getByText('Courier'));
    expect(isOn('Courier')).toBe(false);
  });

  it('remembers the last choice per site and lead type', async () => {
    const view = show();
    fireEvent.click(
      screen.getByRole('button', { name: 'Select none: Columns shown in the table' }),
    );
    fireEvent.click(box('Courier'));
    fireEvent.click(box('Notes'));
    await runExport();
    const key = exportFieldsStorageKey(WORKSPACE, 'sim_order');
    expect(JSON.parse(window.localStorage.getItem(key) ?? 'null')).toEqual([
      'prop.courier',
      'noteCount',
    ]);
    view.unmount();

    // The next time it opens for this type, that choice is back, not the table's columns.
    const again = show();
    expect(isOn('Courier')).toBe(true);
    expect(isOn('Notes')).toBe(true);
    expect(isOn('Arrival in Canada')).toBe(false);
    expect(isOn('Source')).toBe(false);
    // "Reset" goes back to the table's columns.
    fireEvent.click(screen.getByRole('button', { name: 'Reset to the table’s columns' }));
    expect(isOn('Courier')).toBe(false);
    expect(isOn('Arrival in Canada')).toBe(true);
    again.unmount();

    // Another lead type, and another site, have their own.
    show({
      leadType: 'internet',
      leadTypes: ['internet'],
      tableFields: ['source'],
      filter: { type: 'internet' },
    });
    expect(isOn('Source')).toBe(true);
    expect(exportFieldsStorageKey('other-site', 'sim_order')).not.toBe(key);
    expect(exportFieldsStorageKey(WORKSPACE, undefined)).toBe(`gt-export-fields:${WORKSPACE}:all`);
  });

  it('a remembered field the site no longer offers is let go', () => {
    window.localStorage.setItem(
      exportFieldsStorageKey(WORKSPACE, 'sim_order'),
      JSON.stringify(['prop.courier', 'prop.custom_passport', 'prop.deleted', 'planCommission', 7]),
    );
    show({ access: { contacts: true, revenue: false } });
    expect(isOn('Courier')).toBe(true);
    expect(screen.queryByRole('checkbox', { name: 'Commission (CAD)' })).toBeNull();
    expect(group('Order details').getByText(/^1 of \d+$/)).toBeTruthy();
  });

  it('works when the browser’s storage cannot be read or written', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    show();
    // The defaults, as if nothing was remembered.
    expect(isOn('Arrival in Canada')).toBe(true);
    await runExport();
    expect(mocks.saveBlob).toHaveBeenCalledTimes(1);
  });

  it('shows the work in progress and cannot be sent twice', async () => {
    let finish: (value: LeadExportFile) => void = () => undefined;
    mocks.exportLeads.mockReturnValue(
      new Promise<LeadExportFile>((resolve) => {
        finish = resolve;
      }),
    );
    show();
    fireEvent.click(exportButton());
    const busy = await screen.findByRole('button', { name: 'Preparing file…' });
    expect(isDisabled(busy)).toBe(true);
    expect(isDisabled(screen.getByRole('button', { name: 'Cancel' }))).toBe(true);
    expect(box('Courier').hasAttribute('disabled')).toBe(true);
    fireEvent.click(busy);
    expect(mocks.exportLeads).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish(file);
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('says why an export was refused, keeps the dialog open and can be tried again', async () => {
    mocks.exportLeads.mockRejectedValueOnce(
      new backend.BackendError('export_too_large', { total: 6200, max: 5000 }),
    );
    show({ matchingTotal: undefined });
    // Without a count from the list the scope names no number.
    expect(screen.getByText('All leads matching the current filters')).toBeTruthy();
    await runExport();
    expect((await screen.findByRole('alert')).textContent).toBe(
      'That is 6,200 leads. One export holds at most 5,000: narrow the filters or tick fewer leads.',
    );
    expect(mocks.saveBlob).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(isDisabled(exportButton())).toBe(false);

    for (const [code, message] of [
      ['rate_limited', 'Too many exports just now. Try again in a few minutes.'],
      [
        'permission_denied',
        "You don't have permission to export leads. Ask the owner to give your role access.",
      ],
      [
        'lead_not_found',
        'Some ticked leads are no longer available. Reload the list and try again.',
      ],
      [
        'internal_error',
        "The CRM had a problem and couldn't export the leads. Try again in a minute; if it keeps happening, tell your admin.",
      ],
    ] as const) {
      mocks.exportLeads.mockRejectedValueOnce(new backend.BackendError(code));
      await runExport();
      await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(message));
    }
    // A dropped connection is not a backend answer.
    mocks.exportLeads.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await runExport();
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        "Couldn't reach the CRM to export the leads. Check your internet connection and try again.",
      ),
    );

    // The next try works, and the error goes.
    await runExport();
    expect(mocks.saveBlob).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('does not offer an export that would be refused for its size, or of nothing', () => {
    const large = show({ matchingTotal: 5001 });
    expect(screen.getByRole('status').textContent).toBe(
      'One export holds at most 5,000 leads. Narrow the filters first.',
    );
    expect(isDisabled(exportButton())).toBe(true);
    large.unmount();

    const none = show({ matchingTotal: 0 });
    expect(screen.getByRole('status').textContent).toBe('There are no leads to export.');
    expect(isDisabled(exportButton())).toBe(true);
    none.unmount();

    // The ticked leads are few even when the filters match too many.
    show({ matchingTotal: 5001, selectedIds: [LEAD_A] });
    expect(isDisabled(exportButton())).toBe(false);
    fireEvent.click(screen.getByRole('radio', { name: /All leads matching/ }));
    expect(isDisabled(exportButton())).toBe(true);
  });

  it('names the file itself when the answer carried no name', async () => {
    mocks.exportLeads.mockResolvedValue({
      blob: file.blob,
      fileName: undefined,
      rowCount: undefined,
    });
    show({ leadType: undefined, leadTypes: ['sim_order', 'internet'] });
    // Across types the form answers of every type are offered, each once.
    expect(box('City')).toBeTruthy();
    expect(
      screen.getByText('Each lead type gets its own sheet, with the fields it has.'),
    ).toBeTruthy();
    await runExport();
    expect(mocks.saveBlob.mock.lastCall?.[1]).toMatch(
      /^getcanadasim-leads-all-\d{4}-\d{2}-\d{2}\.xlsx$/,
    );
  });

  it('renders nothing while closed', () => {
    show({ open: false });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
