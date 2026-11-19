import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { AiActionProposal } from '@gt-sales/contracts';

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
  expiresAt: '2026-11-19T12:10:00.000Z',
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
});
