import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceReportResponse } from '@gt-sales/contracts';

import { SourceReport, madeItRate, sourceLabel } from './source-report';

const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const REQUEST = '00000000-0000-4000-8000-000000000001';

const mocks = vi.hoisted(() => ({
  getLeadsSummary: vi.fn(),
  getSourceReport: vi.fn(),
}));

vi.mock('../../lib/api', () => ({
  ...mocks,
  BackendError: class extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
}));

vi.mock('../staff-session-provider', () => ({
  useStaffSession: () => ({
    accessToken: 'staff-token',
    workspaces: [{ id: WORKSPACE, slug: 'canadawide', roles: ['viewer'] }],
  }),
}));

const summary = {
  types: [
    { leadType: 'mobility', total: 1, unopened: 0, followUpsDue: null },
    { leadType: 'internet', total: 4, unopened: 0, followUpsDue: null },
  ],
  archived: 0,
  trash: 0,
  access: { contacts: false, manage: false },
  requestId: REQUEST,
};

const report: SourceReportResponse = {
  leadType: 'internet',
  days: 30,
  totals: { received: 4, submitted: 4, madeIt: 1 },
  rows: [
    {
      source: 'utm:google/cpc',
      kind: 'utm',
      received: 3,
      submitted: 3,
      madeIt: 1,
      campaigns: [
        { campaign: 'fall_promo', other: false, received: 1, submitted: 1, madeIt: 0 },
        { campaign: null, other: false, received: 2, submitted: 2, madeIt: 1 },
      ],
    },
    { source: 'direct', kind: 'direct', received: 1, submitted: 1, madeIt: 0, campaigns: [] },
  ],
  withSourceData: 3,
  requestId: REQUEST,
};

/** The text of each cell of a row, in order. */
function cells(row: HTMLElement): string[] {
  return Array.from(row.querySelectorAll('th, td'), (cell) => cell.textContent ?? '');
}

function rowNamed(name: string): HTMLElement {
  const row = screen
    .getAllByRole('row')
    .find((candidate) => candidate.querySelector('th, td')?.textContent === name);
  if (!row) throw new Error(`no row ${name}`);
  return row;
}

describe('SourceReport', () => {
  beforeEach(() => {
    mocks.getLeadsSummary.mockReset();
    mocks.getSourceReport.mockReset();
    mocks.getLeadsSummary.mockResolvedValue(summary);
    mocks.getSourceReport.mockResolvedValue(report);
  });

  it('opens on the last 30 days and the busiest type', async () => {
    render(<SourceReport workspaceSlug="canadawide" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Sources' })).toBeTruthy();
    await screen.findByRole('table');
    expect(mocks.getSourceReport).toHaveBeenLastCalledWith('staff-token', WORKSPACE, {
      leadType: 'internet',
      days: 30,
    });
    const period = screen.getByRole('group', { name: 'Period' });
    expect(
      within(period).getByRole('button', { name: 'Last 30 days' }).getAttribute('aria-pressed'),
    ).toBe('true');
    const select = screen.getByLabelText('Lead type');
    expect(select instanceof HTMLSelectElement && select.value).toBe('internet');
  });

  it('All time sends no window and another type reloads', async () => {
    render(<SourceReport workspaceSlug="canadawide" />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'All time' }));
    await waitFor(() =>
      expect(mocks.getSourceReport).toHaveBeenLastCalledWith('staff-token', WORKSPACE, {
        leadType: 'internet',
      }),
    );
    fireEvent.change(screen.getByLabelText('Lead type'), { target: { value: 'mobility' } });
    await waitFor(() =>
      expect(mocks.getSourceReport).toHaveBeenLastCalledWith('staff-token', WORKSPACE, {
        leadType: 'mobility',
      }),
    );
  });

  it('lists each source with its counts, rate and the total', async () => {
    render(<SourceReport workspaceSlug="canadawide" />);
    const table = await screen.findByRole('table');
    expect(table.querySelector('caption')?.textContent).toBe('Leads per source, the last 30 days');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Source', 'Received', 'Submitted', 'Made it', 'Made-it rate']);
    expect(cells(rowNamed('utm:google/cpc'))).toEqual(['utm:google/cpc', '3', '3', '1', '33%']);
    expect(cells(rowNamed('Direct'))).toEqual(['Direct', '1', '1', '0', '0%']);
    expect(cells(rowNamed('Total'))).toEqual(['Total', '4', '4', '1', '25%']);
    expect(rowNamed('Total').closest('tfoot')).toBeTruthy();
    expect(
      screen.getByText(/Made it: the lead reached Activated, Installed, Completed or Won/),
    ).toBeTruthy();
    expect(screen.queryByText(/No source data yet/)).toBeNull();
  });

  it("opens and closes a source's campaigns from its button", async () => {
    render(<SourceReport workspaceSlug="canadawide" />);
    await screen.findByRole('table');
    const toggle = screen.getByRole('button', { name: 'utm:google/cpc' });
    expect(toggle.getAttribute('type')).toBe('button');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('fall_promo')).toBeNull();
    // A native button: the browser turns Enter and Space into a click (the e2e
    // journey presses the keys); jsdom does not, so the click stands for them.
    toggle.focus();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const controls = toggle.getAttribute('aria-controls');
    expect(controls && document.getElementById(controls)).toBeTruthy();
    expect(cells(rowNamed('fall_promo'))).toEqual(['fall_promo', '1', '1', '0', '0%']);
    expect(cells(rowNamed('(no campaign)'))).toEqual(['(no campaign)', '2', '2', '1', '50%']);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('fall_promo')).toBeNull();
  });

  it('names the summed campaign row Other', async () => {
    mocks.getSourceReport.mockResolvedValue({
      ...report,
      rows: [
        {
          ...report.rows[0],
          campaigns: [{ campaign: null, other: true, received: 3, submitted: 3, madeIt: 1 }],
        },
      ],
    });
    render(<SourceReport workspaceSlug="canadawide" />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'utm:google/cpc' }));
    expect(cells(rowNamed('Other'))).toEqual(['Other', '3', '3', '1', '33%']);
  });

  it('says so when no lead carries source data', async () => {
    mocks.getSourceReport.mockResolvedValue({
      ...report,
      rows: [report.rows[1]],
      totals: { received: 1, submitted: 1, madeIt: 0 },
      withSourceData: 0,
    });
    render(<SourceReport workspaceSlug="canadawide" />);
    await screen.findByRole('table');
    expect(
      screen.getByText(
        "No source data yet. Your websites don't send UTM tags or referrers to the CRM yet, so every lead counts as direct.",
      ),
    ).toBeTruthy();
  });

  it('shows an empty period without a table', async () => {
    mocks.getSourceReport.mockResolvedValue({
      ...report,
      rows: [],
      totals: { received: 0, submitted: 0, madeIt: 0 },
      withSourceData: 0,
    });
    render(<SourceReport workspaceSlug="canadawide" />);
    expect(await screen.findByText('No leads in this period')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText(/No source data yet/)).toBeNull();
  });

  it('shows a failed load with a retry, never a table or sample rows', async () => {
    mocks.getSourceReport.mockRejectedValueOnce(new Error('down'));
    render(<SourceReport workspaceSlug="canadawide" />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not load the report.');
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText('Direct')).toBeNull();
    expect(mocks.getSourceReport).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('table');
    expect(mocks.getSourceReport).toHaveBeenCalledTimes(2);
  });

  it('shows the loading state first', async () => {
    let resolve: (value: SourceReportResponse) => void = () => {};
    mocks.getSourceReport.mockReturnValue(
      new Promise<SourceReportResponse>((settle) => {
        resolve = settle;
      }),
    );
    render(<SourceReport workspaceSlug="canadawide" />);
    expect((await screen.findByRole('status')).textContent).toBe('Loading the report…');
    resolve(report);
    await screen.findByRole('table');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders a source with markup as plain text', async () => {
    mocks.getSourceReport.mockResolvedValue({
      ...report,
      rows: [
        {
          source: 'utm:<b>x</b>',
          kind: 'utm',
          received: 1,
          submitted: 1,
          madeIt: 0,
          campaigns: [{ campaign: '<i>y</i>', other: false, received: 1, submitted: 1, madeIt: 0 }],
        },
        {
          source: 'referrer:<a href="https://evil.example">x</a>',
          kind: 'referrer',
          received: 1,
          submitted: 1,
          madeIt: 0,
          campaigns: [],
        },
      ],
    });
    const { container } = render(<SourceReport workspaceSlug="canadawide" />);
    await screen.findByRole('table');
    const toggle = screen.getByRole('button', { name: 'utm:<b>x</b>' });
    fireEvent.click(toggle);
    expect(screen.getByText('<i>y</i>')).toBeTruthy();
    expect(screen.getByText('referrer:<a href="https://evil.example">x</a>')).toBeTruthy();
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('i')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
  });
});

describe('sourceLabel and madeItRate', () => {
  it('names direct and other, and keeps every other label as sent', () => {
    expect(sourceLabel({ source: 'direct', kind: 'direct' })).toBe('Direct');
    expect(sourceLabel({ source: 'other', kind: 'other' })).toBe('Other');
    expect(sourceLabel({ source: 'utm:google/cpc', kind: 'utm' })).toBe('utm:google/cpc');
    expect(sourceLabel({ source: 'partner:PT-7 (unmatched)', kind: 'partner' })).toBe(
      'partner:PT-7 (unmatched)',
    );
  });

  it('rounds the rate to a whole percent, a dash with nothing received', () => {
    expect(madeItRate(1, 4)).toBe('25%');
    expect(madeItRate(1, 3)).toBe('33%');
    expect(madeItRate(2, 3)).toBe('67%');
    expect(madeItRate(0, 5)).toBe('0%');
    expect(madeItRate(0, 0)).toBe('—');
  });
});
