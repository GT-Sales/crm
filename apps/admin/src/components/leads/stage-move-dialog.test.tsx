import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LEAD_ORDER,
  stageGates,
  type ApiErrorCode,
  type LeadDetail,
  type UpdateWorkspaceLeadResponse,
} from '@gt-sales/contracts';

import { torontoDay } from '../../lib/dates';
import { StageMoveDialog } from './stage-move-dialog';

vi.mock('../../lib/api', () => ({
  BackendError: class extends Error {
    constructor(
      readonly code: string,
      readonly status?: number,
      readonly requestId?: string,
      readonly details?: Record<string, unknown>,
    ) {
      super(code);
    }
  },
}));

const NOW = '2026-10-30T12:00:00.000Z';

const order: LeadDetail = {
  id: '90000000-0000-4000-8000-000000000001',
  workspaceId: '10000000-0000-4000-8000-000000000001',
  leadType: 'sim_order',
  status: 'submitted',
  stage: 'verified',
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
  form: null,
  order: DEFAULT_LEAD_ORDER,
};

const moved: UpdateWorkspaceLeadResponse = {
  lead: { ...order, stage: 'delivered' },
  activities: [],
  allowedMoves: ['activated', 'on_hold', 'cancelled'],
  requestId: NOW,
};

async function refusal(code: ApiErrorCode, details?: Record<string, unknown>) {
  const { BackendError } = await import('../../lib/api');
  return new BackendError(code, 409, NOW, details);
}

type Props = Parameters<typeof StageMoveDialog>[0];

function dialog(options: Partial<Pick<Props, 'lead' | 'to' | 'canOverride'>> = {}) {
  const lead = options.lead ?? order;
  const to = options.to ?? 'delivered';
  const onMove = vi.fn<Props['onMove']>();
  const onDone = vi.fn<Props['onDone']>();
  const onCancel = vi.fn<Props['onCancel']>();
  render(
    <StageMoveDialog
      lead={lead}
      to={to}
      gates={stageGates(lead.leadType, to)}
      canOverride={options.canOverride ?? false}
      onMove={onMove}
      onDone={onDone}
      onCancel={onCancel}
    />,
  );
  return { onMove, onDone, onCancel, view: screen.getByRole('dialog', { name: /^Move to / }) };
}

describe('StageMoveDialog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('asks for the dispatch details, dated today, and moves with them', async () => {
    const { onMove, onDone, view } = dialog();
    onMove.mockResolvedValue(moved);
    expect(within(view).getByRole('heading', { name: 'Move to Delivered' })).toBeTruthy();
    expect(within(view).getByLabelText<HTMLInputElement>(/^Dispatched on/).value).toBe(
      torontoDay(),
    );
    expect(within(view).queryByLabelText(/^Activated on/)).toBeNull();
    fireEvent.change(within(view).getByLabelText(/^Courier/), { target: { value: 'Canada Post' } });
    fireEvent.change(within(view).getByLabelText(/^Tracking number/), {
      target: { value: ' LX1 ' },
    });
    fireEvent.click(within(view).getByRole('button', { name: 'Move' }));

    await waitFor(() =>
      expect(onMove).toHaveBeenCalledWith({
        stage: 'delivered',
        order: { courier: 'Canada Post', trackingNumber: 'LX1', dispatchedAt: torontoDay() },
      }),
    );
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(moved));
  });

  it('needs a courier before it asks the backend', () => {
    const { onMove, view } = dialog();
    fireEvent.click(within(view).getByRole('button', { name: 'Move' }));
    expect(within(view).getByRole('alert').textContent).toBe('Add the courier first.');
    expect(onMove).not.toHaveBeenCalled();
  });

  it('asks for the activation details, prefilled from the order', async () => {
    const lead: LeadDetail = {
      ...order,
      stage: 'delivered',
      order: {
        ...DEFAULT_LEAD_ORDER,
        activatedAt: '2026-10-28',
        activationNumber: '4165550104',
        activationAccount: 'Rogers 12',
      },
    };
    const { onMove, view } = dialog({ lead, to: 'activated' });
    onMove.mockResolvedValue(moved);
    expect(within(view).getByLabelText<HTMLInputElement>(/^Activated on/).value).toBe('2026-10-28');
    expect(within(view).getByLabelText<HTMLInputElement>(/^Activation number/).value).toBe(
      '4165550104',
    );
    expect(within(view).queryByLabelText(/^Courier/)).toBeNull();
    fireEvent.click(within(view).getByRole('button', { name: 'Move' }));
    await waitFor(() =>
      expect(onMove).toHaveBeenCalledWith({
        stage: 'activated',
        order: {
          activatedAt: '2026-10-28',
          activationNumber: '4165550104',
          activationAccount: 'Rogers 12',
        },
      }),
    );
  });

  it('dates the dispatch by Toronto’s calendar, not the browser’s', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // 23:30 on 30 October in Toronto, already 31 October in UTC.
      vi.setSystemTime(new Date('2026-10-31T03:30:00.000Z'));
      const { view } = dialog();
      expect(within(view).getByLabelText<HTMLInputElement>(/^Dispatched on/).value).toBe(
        '2026-10-30',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('dates an activation today when the order has none', () => {
    const { view } = dialog({ lead: { ...order, stage: 'delivered' }, to: 'activated' });
    expect(within(view).getByLabelText<HTMLInputElement>(/^Activated on/).value).toBe(torontoDay());
  });

  it('lists the missing documents and moves anyway with a reason, for those allowed', async () => {
    const { onMove, onDone, view } = dialog({ canOverride: true });
    onMove
      .mockRejectedValueOnce(
        await refusal('documents_incomplete', { missing: ['passport', 'visa'] }),
      )
      .mockResolvedValueOnce(moved);
    fireEvent.change(within(view).getByLabelText(/^Courier/), { target: { value: 'Canada Post' } });
    fireEvent.click(within(view).getByRole('button', { name: 'Move' }));

    expect(
      await within(view).findByText('Missing approved documents: Passport, Visa'),
    ).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
    const reason = within(view).getByLabelText(/^Reason for moving anyway/);
    expect(reason.getAttribute('maxlength')).toBe('2000');
    expect(within(view).queryByRole('button', { name: 'Move' })).toBeNull();

    // A blank reason is not sent.
    fireEvent.click(within(view).getByRole('button', { name: 'Move anyway' }));
    expect(within(view).getByRole('alert').textContent).toBe(
      'Say why the order moves on without them.',
    );
    expect(onMove).toHaveBeenCalledTimes(1);

    fireEvent.change(reason, { target: { value: ' Customer sent them by email ' } });
    fireEvent.click(within(view).getByRole('button', { name: 'Move anyway' }));
    await waitFor(() =>
      expect(onMove).toHaveBeenLastCalledWith({
        stage: 'delivered',
        order: { courier: 'Canada Post', dispatchedAt: torontoDay() },
        documentsOverrideReason: 'Customer sent them by email',
      }),
    );
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(moved));
  });

  it('tells those not allowed to override to approve the documents first', async () => {
    const { onMove, view } = dialog();
    onMove.mockRejectedValueOnce(await refusal('documents_incomplete', { missing: ['passport'] }));
    fireEvent.change(within(view).getByLabelText(/^Courier/), { target: { value: 'Canada Post' } });
    fireEvent.click(within(view).getByRole('button', { name: 'Move' }));

    expect(await within(view).findByText('Missing approved documents: Passport')).toBeTruthy();
    expect(
      within(view).getByText('Approve the documents first, or ask someone with the Orders role.'),
    ).toBeTruthy();
    expect(within(view).queryByLabelText(/^Reason for moving anyway/)).toBeNull();
    expect(within(view).queryByRole('button', { name: 'Move anyway' })).toBeNull();
  });

  it('says when the move is not allowed from where the lead is', async () => {
    const { onMove, view } = dialog();
    onMove.mockRejectedValueOnce(
      await refusal('illegal_stage_move', { from: 'verified', to: 'delivered', allowed: [] }),
    );
    fireEvent.change(within(view).getByLabelText(/^Courier/), { target: { value: 'Canada Post' } });
    fireEvent.click(within(view).getByRole('button', { name: 'Move' }));
    expect((await within(view).findByRole('alert')).textContent).toBe(
      'That move is not allowed from Verified.',
    );
  });

  it('cancels without a request', () => {
    const { onMove, onCancel, view } = dialog();
    fireEvent.click(within(view).getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onMove).not.toHaveBeenCalled();
  });
});
