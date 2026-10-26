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
      query={{ type: 'internet', trash: false, view: 'board', page: 1 }}
    />,
  );
}

function column(name: RegExp) {
  return screen.getByRole('region', { name });
}

async function moveTo(stageLabel: string) {
  fireEvent.pointerDown(
    await screen.findByRole('button', { name: 'Move Avery Example to another stage' }),
    { button: 0, ctrlKey: false },
  );
  fireEvent.click(await screen.findByRole('menuitem', { name: stageLabel }));
}

describe('LeadsBoard', () => {
  beforeEach(() => {
    mocks.getLeadBoard.mockReset();
    mocks.updateStaffLead.mockReset();
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
