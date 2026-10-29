import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DEFAULT_LEAD_VIEW_STATE, type SavedView } from '@gt-sales/contracts';
import { describe, expect, it, vi } from 'vitest';

import { SavedViewSwitcher } from './saved-view-switcher';

const READY: SavedView = {
  id: '40000000-0000-4000-8000-000000000001',
  object: 'lead',
  name: 'Ready to call',
  state: { ...DEFAULT_LEAD_VIEW_STATE, assignee: 'me' },
  version: 2,
  updatedAt: '2026-10-28T10:00:00.000Z',
};
const STUDENTS: SavedView = {
  id: '40000000-0000-4000-8000-000000000002',
  object: 'lead',
  name: 'Students',
  state: { ...DEFAULT_LEAD_VIEW_STATE, leadType: 'sim_order' },
  version: 1,
  updatedAt: '2026-10-27T10:00:00.000Z',
};

type Props = Parameters<typeof SavedViewSwitcher>[0];

function setup(overrides: Partial<Props> = {}) {
  const props: Props = {
    views: [READY, STUDENTS],
    activeViewId: undefined,
    dirty: false,
    total: undefined,
    onSelect: vi.fn(),
    onSave: vi.fn().mockResolvedValue(undefined),
    onSaveAs: vi.fn().mockResolvedValue(undefined),
    onRename: vi.fn().mockResolvedValue(undefined),
    onDelete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  render(<SavedViewSwitcher {...props} />);
  return props;
}

function openMenu(name: string | RegExp) {
  fireEvent.click(screen.getByRole('button', { name }));
}

describe('SavedViewSwitcher', () => {
  it('shows All leads when no view is active and lists the saved views', async () => {
    setup();
    openMenu('All leads');
    expect(await screen.findByRole('button', { name: 'Ready to call' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Students' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'All leads', pressed: true })).toBeTruthy();
  });

  it('names the active view on the trigger and marks it in the list', async () => {
    setup({ activeViewId: STUDENTS.id });
    openMenu('Students');
    expect(await screen.findByRole('button', { name: 'Students', pressed: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ready to call', pressed: false })).toBeTruthy();
  });

  it('shows the lead count beside the name once it is known', () => {
    setup({ activeViewId: READY.id, total: 42 });
    expect(screen.getByRole('button', { name: /Ready to call/ }).textContent).toContain('42');
  });

  it('selects a view or All leads and closes the list', async () => {
    const props = setup({ activeViewId: READY.id });
    openMenu('Ready to call');
    fireEvent.click(await screen.findByRole('button', { name: 'Students' }));
    expect(props.onSelect).toHaveBeenLastCalledWith(STUDENTS.id);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Students' })).toBeNull());

    openMenu('Ready to call');
    fireEvent.click(await screen.findByRole('button', { name: 'All leads' }));
    expect(props.onSelect).toHaveBeenLastCalledWith(undefined);
  });

  it('offers no save controls while the view is unchanged', () => {
    setup({ activeViewId: READY.id });
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save as new view' })).toBeNull();
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('shows the dirty state with Save and Save as new view on a saved view', async () => {
    const props = setup({ activeViewId: READY.id, dirty: true });
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Ready to call/ }).textContent).toContain(
      'Unsaved changes',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(props.onSave).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Save as new view' })).toBeTruthy();
  });

  it('offers only Save as new view when changes were made to All leads', () => {
    setup({ dirty: true });
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save as new view' })).toBeTruthy();
  });

  it('shows why a save failed', async () => {
    setup({
      activeViewId: READY.id,
      dirty: true,
      onSave: vi.fn().mockResolvedValue('This view changed elsewhere. Reload and try again.'),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This view changed elsewhere. Reload and try again.',
    );
  });

  it('names a new view in a dialog, trims the name and closes on success', async () => {
    const props = setup({ dirty: true });
    fireEvent.click(screen.getByRole('button', { name: 'Save as new view' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save as new view' });
    const submit = within(dialog).getByRole('button', { name: 'Save view' });
    expect(submit).toHaveProperty('disabled', true);
    fireEvent.change(within(dialog).getByLabelText('View name'), {
      target: { value: '  Hot leads  ' },
    });
    fireEvent.click(submit);
    await waitFor(() => expect(props.onSaveAs).toHaveBeenCalledWith('Hot leads'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps the dialog open and shows the message when the name is refused', async () => {
    setup({
      dirty: true,
      onSaveAs: vi.fn().mockResolvedValue('A view with that name already exists.'),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save as new view' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('View name'), { target: { value: 'Students' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save view' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'A view with that name already exists.',
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('renames a view from the list', async () => {
    const props = setup();
    openMenu('All leads');
    fireEvent.click(await screen.findByRole('button', { name: 'Rename Students' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename view' });
    const input = within(dialog).getByLabelText('View name');
    expect(input).toHaveProperty('value', 'Students');
    fireEvent.change(input, { target: { value: 'Student SIMs' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(props.onRename).toHaveBeenCalledWith(STUDENTS, 'Student SIMs'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('asks before deleting a view, then deletes it', async () => {
    const props = setup();
    openMenu('All leads');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Ready to call' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete view' });
    expect(props.onDelete).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/Ready to call/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete view' }));
    await waitFor(() => expect(props.onDelete).toHaveBeenCalledWith(READY));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('can be cancelled without deleting', async () => {
    const props = setup();
    openMenu('All leads');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Students' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(props.onDelete).not.toHaveBeenCalled();
  });
});
