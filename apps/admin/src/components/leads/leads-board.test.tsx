import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LeadBoardResponse, LeadListItem } from '@gt-sales/contracts';

import { LeadsBoard } from './leads-board';

const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const NOW = '2026-10-26T12:00:00.000Z';

const mocks = vi.hoisted(() => ({
  getLeadBoard: vi.fn(),
  updateStaffLead: vi.fn(),
}));

vi.mock('../../lib/api', () => ({
  ...mocks,
  BackendError: class extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
}));

const card: LeadListItem = {
  id: '90000000-0000-4000-8000-000000000001',
  workspaceId: WORKSPACE,
  leadType: 'internet',
  status: 'submitted',
  stage: 'new',
  contact: { fullName: 'Avery Example', phone: '403 555 0101' },
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

function board(manage: boolean): LeadBoardResponse {
  return {
    leadType: 'internet',
    columns: [
      { stage: 'new', total: 1, leads: [card] },
      { stage: 'contacted', total: 0, leads: [] },
      { stage: 'won', total: 4, leads: [] },
    ],
    access: { contacts: true, manage },
    requestId: '00000000-0000-4000-8000-000000000001',
  };
}

function renderBoard() {
  return render(
    <LeadsBoard
      workspaceSlug="canadawide"
      workspaceId={WORKSPACE}
      accessToken="staff-token"
      members={[]}
      query={{ type: 'internet', archived: false, due: false, layout: 'board', hide: [], page: 1 }}
    />,
  );
}

function column(name: RegExp) {
  return screen.getByRole('region', { name });
}

/** Drags the Avery Example card onto a column, as the browser would. */
async function moveTo(stageLabel: string) {
  const items = new Map<string, string>();
  const dataTransfer = {
    get types() {
      return [...items.keys()];
    },
    setData: (type: string, value: string) => void items.set(type, value),
    getData: (type: string) => items.get(type) ?? '',
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
  };
  const card = (await screen.findByText('Avery Example')).closest('li');
  if (!card) throw new Error('the Avery Example card is not on the board');
  const target = column(new RegExp(`^${stageLabel}, \\d+ leads$`));
  fireEvent.dragStart(card, { dataTransfer });
  fireEvent.dragOver(target, { dataTransfer });
  fireEvent.drop(target, { dataTransfer });
}

describe('LeadsBoard', () => {
  beforeEach(() => {
    mocks.getLeadBoard.mockReset();
    mocks.updateStaffLead.mockReset();
    window.localStorage.clear();
  });

  it('lays out a column per stage with its count', async () => {
    mocks.getLeadBoard.mockResolvedValue(board(true));
    renderBoard();
    expect(await screen.findByRole('region', { name: 'New, 1 leads' })).toBeTruthy();
    expect(column(/^Won, 4 leads$/)).toBeTruthy();
    expect(within(column(/^Won/)).getByText('4 more in the table')).toBeTruthy();
    expect(mocks.getLeadBoard).toHaveBeenCalledWith('staff-token', WORKSPACE, {
      type: 'internet',
      assignee: undefined,
      q: undefined,
      perStage: 50,
    });
  });

  it('drags the card itself, never its name link', async () => {
    // A link grabbed by the name would be the drag source, and hiding the card's
    // contents on dragstart would make Chromium cancel that drag at once.
    mocks.getLeadBoard.mockResolvedValue(board(true));
    renderBoard();
    const link = await screen.findByRole('link', { name: 'Avery Example' });
    expect(link.getAttribute('draggable')).toBe('false');
    expect(link.closest('li')?.getAttribute('draggable')).toBe('true');
  });

  it('moves a card at once and keeps it there when the backend agrees', async () => {
    mocks.getLeadBoard.mockResolvedValue(board(true));
    mocks.updateStaffLead.mockResolvedValue({
      lead: { ...card, stage: 'contacted', form: null },
      activities: [],
      requestId: NOW,
    });
    renderBoard();
    await moveTo('Contacted');

    await waitFor(() =>
      expect(within(column(/^Contacted, 1 leads$/)).getByText('Avery Example')).toBeTruthy(),
    );
    expect(within(column(/^New, 0 leads$/)).queryByText('Avery Example')).toBeNull();
    expect(mocks.updateStaffLead).toHaveBeenCalledWith('staff-token', WORKSPACE, card.id, {
      stage: 'contacted',
    });
  });

  it('moves a card through its "Move to" menu, the keyboard and touch path', async () => {
    mocks.getLeadBoard.mockResolvedValue(board(true));
    mocks.updateStaffLead.mockResolvedValue({
      lead: { ...card, stage: 'won', form: null },
      activities: [],
      requestId: NOW,
    });
    renderBoard();
    fireEvent.pointerDown(
      await screen.findByRole('button', { name: 'Move Avery Example to another stage' }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Won' }));

    await waitFor(() =>
      expect(within(column(/^Won, 5 leads$/)).getByText('Avery Example')).toBeTruthy(),
    );
    expect(mocks.updateStaffLead).toHaveBeenCalledWith('staff-token', WORKSPACE, card.id, {
      stage: 'won',
    });
  });

  it('puts the card back and says why when the backend refuses', async () => {
    mocks.getLeadBoard.mockResolvedValue(board(true));
    const { BackendError } = await import('../../lib/api');
    mocks.updateStaffLead.mockRejectedValue(new BackendError('lead_trashed', 409, NOW));
    renderBoard();
    await moveTo('Won');

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'The lead could not be moved. Reason: lead_trashed.',
    );
    expect(within(column(/^New, 1 leads$/)).getByText('Avery Example')).toBeTruthy();
    expect(column(/^Won, 4 leads$/)).toBeTruthy();
  });

  it('collapses a column to a strip and expands it again', async () => {
    mocks.getLeadBoard.mockResolvedValue(board(true));
    renderBoard();
    await screen.findByText('Avery Example');

    fireEvent.click(screen.getByRole('button', { name: 'Collapse New column' }));
    expect(screen.queryByText('Avery Example')).toBeNull();
    expect(window.localStorage.getItem('gt-board-collapsed:' + WORKSPACE + ':internet')).toBe(
      '["new"]',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Expand New column' }));
    expect(screen.getByText('Avery Example')).toBeTruthy();
  });

  it('hides a column via the options menu and restores it from Hidden columns', async () => {
    mocks.getLeadBoard.mockResolvedValue(board(true));
    renderBoard();
    await screen.findByText('Avery Example');

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Contacted column options' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Hide column' }));
    expect(screen.queryByRole('region', { name: /^Contacted/ })).toBeNull();
    expect(window.localStorage.getItem('gt-board-hidden:' + WORKSPACE + ':internet')).toBe(
      '["contacted"]',
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Hidden columns (1)' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: /Contacted \(0\)/ }));
    expect(column(/^Contacted, 0 leads$/)).toBeTruthy();
  });

  it('offers no move controls to a role that cannot manage leads', async () => {
    mocks.getLeadBoard.mockResolvedValue(board(false));
    renderBoard();
    await screen.findByText('Avery Example');
    expect(screen.queryByRole('button', { name: /Move Avery Example/ })).toBeNull();
    expect(screen.getByText('Avery Example').closest('li')?.getAttribute('draggable')).toBe(
      'false',
    );
  });
});
