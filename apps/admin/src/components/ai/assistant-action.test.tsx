import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { AiActionCard, AiActionProposal } from '@gt-sales/contracts';

import { AssistantAction } from './assistant-action';
import type { AiActionView } from './assistant-provider';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

const TASK = '50000000-0000-4000-8000-000000000201';
const LEAD = '90000000-0000-4000-8000-000000000201';

const base = {
  id: '40000000-0000-4000-8000-000000000201',
  token: 'opaque-token',
  // Always in the future, so the card is never shown as expired.
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  siteName: 'Get Canada Sim',
};

function view(
  proposal: AiActionProposal,
  status: AiActionView['status'] = 'pending',
): AiActionView {
  return { proposal, status };
}

function card(proposal: AiActionProposal, status?: AiActionView['status']) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const onRevise = vi.fn();
  const rendered = render(
    <AssistantAction
      action={view(proposal, status)}
      onConfirm={onConfirm}
      onCancel={onCancel}
      onRevise={onRevise}
    />,
  );
  return { ...rendered, onConfirm, onCancel, onRevise };
}

const plainTask: AiActionProposal = {
  ...base,
  draft: { kind: 'task', title: 'Call the supplier', dueDate: '2026-11-20', assignee: 'me' },
};

const move = (leadId: string | null): AiActionProposal => ({
  ...base,
  draft: { kind: 'task_update', taskId: TASK, status: 'done' },
  taskUpdateContext: {
    version: '1795054241116000',
    title: 'Call the supplier',
    before: 'in_progress',
    leadId,
  },
  ...(leadId
    ? { leadLabel: 'MS-101 · SIM order', leadHref: `/w/getcanadasim/leads/${leadId}` }
    : {}),
});

describe('a plain task card', () => {
  it('says “No lead” and links to no lead page', () => {
    card(plainTask);
    const region = screen.getByRole('region', { name: 'Confirm task' });
    expect(within(region).getByRole('heading', { name: 'Create a task' })).toBeTruthy();
    expect(within(region).getByText('Get Canada Sim · No lead')).toBeTruthy();
    expect(within(region).getByText('Call the supplier')).toBeTruthy();
    expect(within(region).queryByRole('link')).toBeNull();
  });

  it('edits the title and due date and stays a plain task', () => {
    const { onRevise } = card(plainTask);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Task title'), {
      target: { value: 'Call the supplier back' },
    });
    fireEvent.change(screen.getByLabelText('Task due date'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update draft' }));
    expect(onRevise).toHaveBeenCalledWith({
      kind: 'task',
      title: 'Call the supplier back',
      dueDate: null,
      assignee: 'me',
    });
  });

  it('says it was created once saved', () => {
    card(plainTask, 'saved');
    expect(screen.getByRole('status').textContent).toBe('Task created.');
  });
});

describe('a task move card', () => {
  it('names the task, its current stage and the new one', () => {
    const { onConfirm } = card(move(null));
    const region = screen.getByRole('region', { name: 'Confirm task move' });
    expect(within(region).getByRole('heading', { name: 'Move a task' })).toBeTruthy();
    expect(within(region).getByText('Get Canada Sim · No lead')).toBeTruthy();
    expect(within(region).getByText('Call the supplier')).toBeTruthy();
    expect(within(region).getByText('In progress')).toBeTruthy();
    expect(within(region).getByText('Done')).toBeTruthy();
    expect(within(region).queryByRole('link')).toBeNull();
    fireEvent.click(within(region).getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalled();
  });

  it('links to the task’s lead when it has one', () => {
    card(move(LEAD));
    expect(screen.getByText('Get Canada Sim · MS-101 · SIM order')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View lead' }).getAttribute('href')).toBe(
      `/w/getcanadasim/leads/${LEAD}`,
    );
  });

  it('edits the new stage, offering every stage but the one it is in', () => {
    const { onRevise } = card(move(null));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const select = screen.getByLabelText('New stage');
    if (!(select instanceof HTMLSelectElement)) throw new Error('expected a select');
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      'To do',
      'Done',
      'Cancelled',
    ]);
    fireEvent.change(select, { target: { value: 'open' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update draft' }));
    expect(onRevise).toHaveBeenCalledWith({ kind: 'task_update', taskId: TASK, status: 'open' });
  });

  it('says it was moved once saved', () => {
    card(move(null), 'saved');
    expect(screen.getByRole('status').textContent).toBe('Task moved.');
  });

  it('says a task was updated when more than its stage changed (T9)', () => {
    const edited = (draft: AiActionCard['draft']): AiActionCard => ({ ...move(null), draft });
    wide(
      edited({
        kind: 'task_update',
        taskId: TASK,
        status: 'done',
        title: 'Call the supplier back',
      }),
      'saved',
    );
    expect(screen.getByRole('status').textContent).toBe('Task updated.');
    cleanup();
    wide(edited({ kind: 'task_update', taskId: TASK, dueDate: '2026-12-01' }), 'saved');
    expect(screen.getByRole('status').textContent).toBe('Task updated.');
  });
});

const wideCard = (extra: Partial<AiActionCard> & Pick<AiActionCard, 'draft'>): AiActionCard => ({
  ...base,
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  leadLabel: 'MS-101 · Robin Example (SIM order, created 2026-11-02)',
  leadHref: `/w/getcanadasim/leads/${LEAD}`,
  ...extra,
});

function wide(proposal: AiActionCard, status?: AiActionView['status']) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const onRevise = vi.fn();
  render(
    <AssistantAction
      action={{ proposal, status: status ?? 'pending' }}
      onConfirm={onConfirm}
      onCancel={onCancel}
      onRevise={onRevise}
    />,
  );
  return { onConfirm, onCancel, onRevise };
}

const deliveryCard = (order: Record<string, string> = {}) =>
  wideCard({
    draft: { kind: 'lead_edit', leadId: LEAD, changes: { stage: 'delivered', order } },
    leadEditContext: {
      rows: [{ key: 'stage', label: 'Stage', before: 'Verified', after: 'Delivered' }],
      inputs: [
        { field: 'courier', label: 'Courier', kind: 'text', required: true, current: null },
        {
          field: 'trackingNumber',
          label: 'Tracking number',
          kind: 'text',
          required: false,
          current: null,
        },
      ],
      ...(order['courier'] ? {} : { needs: 'dispatch_details' as const }),
    },
    sideEffects: ['“Dispatched” runs: sends the “Dispatched” email to the customer.'],
  });

describe('a stage move with dispatch details', () => {
  it('shows the move, every side effect in full, and the label with type and day', () => {
    wide(deliveryCard({ courier: 'Canada Post' }));
    const region = screen.getByRole('region', { name: 'Confirm lead change' });
    expect(within(region).getByRole('heading', { name: 'Move the lead' })).toBeTruthy();
    expect(
      within(region).getByText(
        'Get Canada Sim · MS-101 · Robin Example (SIM order, created 2026-11-02)',
      ),
    ).toBeTruthy();
    expect(within(region).getByText('Delivered')).toBeTruthy();
    const effects = within(region).getByRole('region', { name: 'What else happens' });
    expect(within(effects).getByText(/sends the “Dispatched” email to the customer/)).toBeTruthy();
    expect(within(region).getByRole('button', { name: 'Confirm' }).hasAttribute('disabled')).toBe(
      false,
    );
  });

  it('holds Confirm until the person types the courier, and revises with it', () => {
    const { onRevise, onConfirm } = wide(deliveryCard());
    const confirmButton = screen.getByRole('button', { name: 'Confirm' });
    expect(confirmButton.hasAttribute('disabled')).toBe(true);
    fireEvent.click(confirmButton);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText(/Enter the courier with Edit/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Courier'), { target: { value: 'Purolator' } });
    fireEvent.change(screen.getByLabelText('Tracking number'), { target: { value: 'TRK-9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update draft' }));
    expect(onRevise).toHaveBeenCalledWith({
      kind: 'lead_edit',
      leadId: LEAD,
      changes: { stage: 'delivered', order: { courier: 'Purolator', trackingNumber: 'TRK-9' } },
    });
  });
});

describe('what a stage move card shows (T2)', () => {
  it('shows only the server’s rows, a required detail still to type as needed, never “Cleared”', () => {
    wide(
      wideCard({
        draft: { kind: 'lead_edit', leadId: LEAD, changes: { stage: 'delivered' } },
        leadEditContext: {
          rows: [
            { key: 'stage', label: 'Stage', before: 'Verified', after: 'Delivered' },
            { key: 'order.courier', label: 'Courier', before: null, after: null },
          ],
          inputs: [
            { field: 'courier', label: 'Courier', kind: 'text', required: true, current: null },
            {
              field: 'trackingNumber',
              label: 'Tracking number',
              kind: 'text',
              required: false,
              current: null,
            },
            {
              field: 'dispatchedAt',
              label: 'Dispatch date',
              kind: 'date',
              required: false,
              current: null,
            },
          ],
          needs: 'dispatch_details',
        },
      }),
    );
    const region = screen.getByRole('region', { name: 'Confirm lead change' });
    expect(within(region).queryByText('Cleared')).toBeNull();
    expect(within(region).queryByText('Tracking number')).toBeNull();
    expect(within(region).queryByText('Dispatch date')).toBeNull();
    expect(within(region).getByText('Courier (required)')).toBeTruthy();
    expect(within(region).getByText('To enter with Edit')).toBeTruthy();
  });

  it('shows the default date as the day it is', () => {
    wide(
      wideCard({
        draft: {
          kind: 'lead_edit',
          leadId: LEAD,
          changes: { stage: 'delivered', order: { courier: 'UPS', dispatchedAt: '2026-11-20' } },
        },
        leadEditContext: {
          rows: [
            { key: 'stage', label: 'Stage', before: 'Verified', after: 'Delivered' },
            { key: 'order.courier', label: 'Courier', before: null, after: 'UPS' },
            {
              key: 'order.dispatchedAt',
              label: 'Dispatch date',
              before: null,
              after: '20 Nov 2026 (today)',
            },
          ],
          inputs: [
            { field: 'courier', label: 'Courier', kind: 'text', required: true, current: null },
          ],
        },
      }),
    );
    expect(screen.getByText('20 Nov 2026 (today)')).toBeTruthy();
    expect(screen.queryByText('Cleared')).toBeNull();
  });
});

describe('Edit only where there is something to edit (T6)', () => {
  it('offers no Edit on a quantity or plan card, which has nothing to type', () => {
    wide(
      wideCard({
        draft: { kind: 'lead_edit', leadId: LEAD, changes: { order: { quantity: 2 } } },
        leadEditContext: {
          rows: [{ key: 'order.quantity', label: 'Quantity', before: '1', after: '2' }],
          inputs: [],
        },
      }),
    );
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeTruthy();
  });

  it('offers Edit on a move that carries details to type', () => {
    wide(deliveryCard({ courier: 'Canada Post' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Courier')).toBeTruthy();
  });
});

describe('keyboard focus through a card’s steps (T4)', () => {
  const note = (status: AiActionView['status'], error?: string): AiActionView => ({
    proposal: wideCard({ draft: { kind: 'note', leadId: LEAD, body: 'Called.' } }),
    status,
    ...(error ? { error } : {}),
  });

  function rendered(action: AiActionView) {
    const onRevise = vi.fn();
    const props = { onConfirm: vi.fn(), onCancel: vi.fn(), onRevise };
    const view = render(<AssistantAction action={action} {...props} />);
    return {
      onRevise,
      update: (next: AiActionView) => view.rerender(<AssistantAction action={next} {...props} />),
    };
  }

  it('moves into the form on Edit, to the status while it updates, then to Confirm', () => {
    const { update } = rendered(note('pending'));
    const edit = screen.getByRole('button', { name: 'Edit' });
    edit.focus();
    fireEvent.click(edit);
    expect(document.activeElement).toBe(screen.getByLabelText('Note text'));
    fireEvent.click(screen.getByRole('button', { name: 'Update draft' }));
    update(note('revising'));
    expect(document.activeElement).toBe(screen.getByRole('status'));
    update(note('pending'));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Confirm' }));
  });

  it('keeps focus on the status message, which is announced, through saving and saved', () => {
    const { update } = rendered(note('pending'));
    const confirmButton = screen.getByRole('button', { name: 'Confirm' });
    confirmButton.focus();
    fireEvent.click(confirmButton);
    update(note('saving'));
    const status = screen.getByRole('status');
    expect(document.activeElement).toBe(status);
    expect(status.getAttribute('aria-live') ?? 'polite').toBe('polite');
    update(note('saved'));
    expect(document.activeElement).toBe(screen.getByRole('status'));
    expect(screen.getByRole('status').textContent).toBe('Note added.');
  });

  it('puts focus on the refusal’s words, and offers no Retry after a final refusal', () => {
    const { update } = rendered(note('pending'));
    screen.getByRole('button', { name: 'Confirm' }).focus();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    update(note('saving'));
    update(note('refused', 'Not saved. You have reached today’s limit.'));
    expect(document.activeElement).toBe(screen.getByRole('status'));
    expect(screen.getByRole('status').textContent).toBe(
      'Not saved. You have reached today’s limit.',
    );
    expect(screen.queryByRole('button', { name: 'Retry save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
  });

  it('takes no focus from elsewhere when the card changes on its own', () => {
    const { update } = rendered(note('pending'));
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    update(note('error', 'Could not confirm the save.'));
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});

describe('a card that names other customers', () => {
  const mentioning = wideCard({
    draft: { kind: 'email', leadId: LEAD, subject: 'Your order', body: 'Zara Quill too.' },
    emailContext: { toAddress: 'robin@example.test', fromAddress: 'orders@site.example' },
    mentions: ['Zara Quill'],
    acknowledgementRequired: true,
  });

  it('names them and sends only once the person ticks that they checked it', () => {
    const { onConfirm } = wide(mentioning);
    expect(screen.getByText('This names other customers: Zara Quill.')).toBeTruthy();
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByLabelText('I checked it, and it may name them.'));
    expect(send.hasAttribute('disabled')).toBe(false);
    fireEvent.click(send);
    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it('confirms a card without the warning with no tick', () => {
    const { onConfirm } = wide(wideCard({ draft: { kind: 'note', leadId: LEAD, body: 'Plain' } }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledWith(false);
  });
});

describe('the other new cards', () => {
  it('shows a template mail as rendered, with no Edit', () => {
    wide(
      wideCard({
        draft: { kind: 'template_email', leadId: LEAD, template: 'sim_number_ready' },
        emailContext: { toAddress: 'robin@example.test', fromAddress: 'orders@site.example' },
        templateEmailContext: {
          templateName: 'SIM number ready',
          version: 3,
          subject: 'Your Canadian number',
          text: 'Your number is +1 778 555 0142.',
        },
        sideEffects: ['Sends the “SIM number ready” email to robin@example.test.'],
      }),
    );
    expect(screen.getByRole('heading', { name: 'Send the “SIM number ready” email' })).toBeTruthy();
    expect(screen.getByText('robin@example.test')).toBeTruthy();
    expect(screen.getByText('Your number is +1 778 555 0142.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  });

  it('says what archiving cancels, and that it was archived', () => {
    const archive = wideCard({
      draft: { kind: 'lead_archive', leadId: LEAD, archived: true },
      sideEffects: [
        'Waiting automation runs and timers for this lead are cancelled. Restoring the lead does not bring them back.',
      ],
    });
    wide(archive);
    expect(screen.getByRole('heading', { name: 'Archive the lead' })).toBeTruthy();
    expect(screen.getByText(/Restoring the lead does not bring them back/)).toBeTruthy();
    cleanup();
    wide(archive, 'saved');
    expect(screen.getByRole('status').textContent).toBe('Lead archived.');
  });

  it('switches an automation off and links to it, never offering to switch it on', () => {
    wide(
      wideCard({
        draft: { kind: 'automation_off', automationKey: 'order_received' },
        automationOffContext: { name: 'Order received', revision: 4 },
        leadLabel: undefined,
        leadHref: '/w/getcanadasim/automations/order_received',
      }),
    );
    expect(screen.getByRole('heading', { name: 'Switch off “Order received”' })).toBeTruthy();
    expect(screen.getByText('Get Canada Sim · Automation')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View automation' }).getAttribute('href')).toBe(
      '/w/getcanadasim/automations/order_received',
    );
    expect(screen.queryByText(/switch.*on/i, { selector: 'button' })).toBeNull();
  });

  it('assigns a task to a chosen member', () => {
    const { onRevise } = wide(
      wideCard({
        draft: { kind: 'task', leadId: LEAD, title: 'Call', dueDate: null, assignee: 'me' },
        assigneeChoices: [
          { value: 'me', label: 'You' },
          { value: 'none', label: 'Unassigned' },
          { value: TASK, label: 'Lee Leads' },
        ],
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Task assignee'), { target: { value: TASK } });
    fireEvent.click(screen.getByRole('button', { name: 'Update draft' }));
    expect(onRevise).toHaveBeenCalledWith({
      kind: 'task',
      leadId: LEAD,
      title: 'Call',
      dueDate: null,
      assignee: TASK,
    });
  });

  it('shows a task edit as before and after, and sends only what changed', () => {
    const { onRevise } = wide(
      wideCard({
        draft: { kind: 'task_update', taskId: TASK, title: 'Call twice' },
        taskUpdateContext: { version: '1', title: 'Call', before: 'open', leadId: null },
        taskEditContext: { dueDate: null, assigneeLabel: 'You' },
        leadLabel: undefined,
        leadHref: undefined,
      }),
    );
    expect(screen.getByRole('heading', { name: 'Change a task' })).toBeTruthy();
    expect(screen.getByText('Call twice')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Task due date'), { target: { value: '2026-12-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update draft' }));
    expect(onRevise).toHaveBeenCalledWith({
      kind: 'task_update',
      taskId: TASK,
      title: 'Call twice',
      dueDate: '2026-12-01',
    });
  });

  it('turns an expired card into a refusal with no Confirm', () => {
    wide({
      ...wideCard({ draft: { kind: 'note', leadId: LEAD, body: 'Late' } }),
      expiresAt: '2026-01-01T00:00:00.000Z',
    });
    expect(screen.getByRole('status').textContent).toMatch(/This draft expired/);
    expect(screen.getByRole('button', { name: 'Confirm' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });
});
