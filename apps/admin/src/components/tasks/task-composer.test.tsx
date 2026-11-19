import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssignableMember } from '@gt-sales/contracts';

import { TaskComposer, type NewTask, type TaskLeadRef } from './task-composer';

const SELF = '20000000-0000-4000-8000-000000000001';
const SAM = '20000000-0000-4000-8000-000000000002';
const members: AssignableMember[] = [
  {
    membershipId: '30000000-0000-4000-8000-000000000001',
    actorId: SELF,
    displayName: 'Takib',
    roles: ['owner'],
    isSelf: true,
  },
  {
    membershipId: '30000000-0000-4000-8000-000000000002',
    actorId: SAM,
    displayName: 'Sam Rivers',
    roles: ['leads'],
    isSelf: false,
  },
];
const lead: TaskLeadRef = {
  id: '90000000-0000-4000-8000-000000000001',
  leadType: 'internet',
  stage: 'new',
  contact: { fullName: 'Blake Sample' },
  externalRef: 'MS-101',
};

afterEach(() => vi.useRealTimers());

function setup(props: Partial<React.ComponentProps<typeof TaskComposer>> = {}) {
  const onAdd = vi.fn<(task: NewTask) => Promise<void>>().mockResolvedValue(undefined);
  const onError = vi.fn();
  render(<TaskComposer members={members} onAdd={onAdd} onError={onError} {...props} />);
  const form = screen.getByRole('form', { name: 'New task' });
  const title = within(form).getByRole('textbox', { name: 'Task name' });
  if (!(title instanceof HTMLInputElement)) throw new Error('the task name is not an input');
  return { form, title, onAdd, onError };
}

const type = (title: HTMLElement, value: string) => fireEvent.change(title, { target: { value } });

describe('TaskComposer', () => {
  it('needs a title before a task can be added', () => {
    const { form, title, onAdd } = setup();
    const add = within(form).getByRole('button', { name: 'Add task' });
    expect(add.hasAttribute('disabled')).toBe(true);
    type(title, '   ');
    expect(add.hasAttribute('disabled')).toBe(true);
    type(title, 'Call Blake');
    expect(add.hasAttribute('disabled')).toBe(false);
    expect(title.maxLength).toBe(200);
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('names each chip with its current value', () => {
    const { form } = setup({ searchLeads: async () => [] });
    expect(within(form).getByRole('button', { name: 'Due date: none' })).toBeTruthy();
    expect(within(form).getByRole('button', { name: 'Task assignee: Me' })).toBeTruthy();
    expect(within(form).getByRole('button', { name: 'Lead: No lead' })).toBeTruthy();
  });

  it('offers no lead chip unless it can search leads', () => {
    const { form } = setup();
    expect(within(form).queryByRole('button', { name: /^Lead:/ })).toBeNull();
  });

  it('sets the due date from a quick pick, the calendar and No due date', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 19, 10, 0) }); // Thu 19 Nov
    const { form } = setup();
    const chip = () => within(form).getByRole('button', { name: /^Due date:/ });
    fireEvent.click(chip());
    expect(screen.getByRole('button', { name: /^Next Monday/ }).textContent).toContain(
      'Mon 23 Nov',
    );
    fireEvent.click(screen.getByRole('button', { name: /^Next Monday/ }));
    expect(chip().getAttribute('aria-label')).toBe('Due date: Mon 23 Nov');
    // Overdue days are not quick picks.
    fireEvent.click(chip());
    expect(screen.queryByRole('button', { name: /Yesterday/ })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Friday, November 20, 2026' }));
    expect(chip().getAttribute('aria-label')).toBe('Due date: Tomorrow');
    fireEvent.click(chip());
    fireEvent.click(await screen.findByRole('button', { name: 'No due date' }));
    expect(chip().getAttribute('aria-label')).toBe('Due date: none');
  });

  it('adds with Enter, stays open and empty, keeps the date and assignee and refocuses the name', async () => {
    const { form, title, onAdd } = setup();
    fireEvent.click(within(form).getByRole('button', { name: 'Due date: none' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Today/ }));
    fireEvent.click(within(form).getByRole('button', { name: 'Task assignee: Me' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Sam Rivers' }));
    // A choice returns focus to the name.
    await waitFor(() => expect(document.activeElement).toBe(title));
    type(title, '  First  ');
    fireEvent.submit(form);
    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
    const first = onAdd.mock.calls[0]?.[0];
    expect(first?.title).toBe('First');
    expect(first?.assignedActorId).toBe(SAM);
    expect(first?.dueAt).toMatch(/^\d{4}-\d{2}-\d{2}T12:00:00\.000Z$/);
    expect(title.value).toBe('');
    expect(document.activeElement).toBe(title);
    expect(within(form).getByRole('button', { name: 'Task assignee: Sam Rivers' })).toBeTruthy();
    type(title, 'Second');
    fireEvent.keyDown(title, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(2));
    expect(onAdd.mock.calls[1]?.[0]).toMatchObject({ title: 'Second', dueAt: first?.dueAt });
  });

  it('puts the name back and says why when the add is refused', async () => {
    const { form, title, onAdd, onError } = setup();
    onAdd.mockRejectedValue(new Error('offline'));
    type(title, 'Keep me');
    fireEvent.submit(form);
    expect(title.value).toBe('');
    await waitFor(() => expect(title.value).toBe('Keep me'));
    expect(onError).toHaveBeenLastCalledWith(expect.stringMatching(/add the task/i));
  });

  it('cancels with Escape, but Escape in a popover only closes the popover', async () => {
    const onCancel = vi.fn();
    const { form, title } = setup({ onCancel });
    fireEvent.click(within(form).getByRole('button', { name: 'Task assignee: Me' }));
    const search = await screen.findByRole('combobox', { name: 'Assign to' });
    fireEvent.keyDown(search, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('combobox')).toBeNull());
    expect(onCancel).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(form).getByRole('button', { name: 'Task assignee: Me' }),
      ),
    );
    fireEvent.keyDown(title, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('searches the people, with No one for an unassigned task', async () => {
    const { form, title, onAdd } = setup();
    fireEvent.click(within(form).getByRole('button', { name: 'Task assignee: Me' }));
    const search = await screen.findByRole('combobox', { name: 'Assign to' });
    fireEvent.change(search, { target: { value: 'sam' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option', { name: 'Sam Rivers' })).toBeTruthy();
    fireEvent.change(search, { target: { value: '' } });
    // Arrow keys move, Enter chooses.
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(within(form).getByRole('button', { name: 'Task assignee: No one' })).toBeTruthy();
    type(title, 'Nobody’s');
    fireEvent.submit(form);
    await waitFor(() => expect(onAdd).toHaveBeenCalled());
    expect(onAdd.mock.calls[0]?.[0].assignedActorId).toBeNull();
  });

  it('starts with the due day it is given', () => {
    const { form } = setup({ initialDay: '2026-11-20' });
    expect(within(form).getByRole('button', { name: /^Due date: / }).textContent).toBeTruthy();
    expect(within(form).queryByRole('button', { name: 'Due date: none' })).toBeNull();
  });

  it('chooses a lead from a search and passes it with the task', async () => {
    const searchLeads = vi.fn().mockResolvedValue([lead]);
    const { form, title, onAdd } = setup({ searchLeads });
    fireEvent.click(within(form).getByRole('button', { name: 'Lead: No lead' }));
    const option = await screen.findByRole('option', { name: /Blake Sample/ });
    expect(option.textContent).toContain('MS-101');
    fireEvent.click(option);
    expect(within(form).getByRole('button', { name: 'Lead: Blake Sample' })).toBeTruthy();
    type(title, 'Send the contract');
    fireEvent.submit(form);
    await waitFor(() => expect(onAdd).toHaveBeenCalled());
    expect(onAdd.mock.calls[0]?.[0].lead).toEqual(lead);
  });

  it('turns "Today" and "Tomorrow" into the right day around midnight', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 19, 23, 59, 30) });
    const { form, title, onAdd } = setup();
    const pick = async (name: RegExp) => {
      fireEvent.click(within(form).getByRole('button', { name: /^Due date:/ }));
      fireEvent.click(await screen.findByRole('button', { name }));
    };
    await pick(/^Today/);
    type(title, 'Late one');
    fireEvent.submit(form);
    await pick(/^Tomorrow/);
    type(title, 'Next one');
    fireEvent.submit(form);
    // The clock passes midnight: the same words now mean the next day.
    act(() => {
      vi.setSystemTime(new Date(2026, 10, 20, 0, 1));
    });
    await pick(/^Today/);
    type(title, 'After midnight');
    fireEvent.submit(form);
    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(3));
    expect(onAdd.mock.calls.map((call) => call[0].dueAt)).toEqual([
      '2026-11-19T12:00:00.000Z',
      '2026-11-20T12:00:00.000Z',
      '2026-11-20T12:00:00.000Z',
    ]);
  });
});
