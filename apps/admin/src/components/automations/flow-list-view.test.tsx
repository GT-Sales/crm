import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { FlowDraft } from '@gt-sales/contracts';
import { FlowListView } from './flow-list-view';
import { namesFromCode } from './flow-words';

const definition: FlowDraft = {
  schemaVersion: 1,
  trigger: null,
  steps: [{ id: 's_split', kind: 'if_else', condition: null, then: [], else: [] }],
};
it('offers keyboard-operated add menus in both branches and focusable cards', async () => {
  const select = vi.fn();
  const add = vi.fn();
  render(
    <FlowListView
      definition={definition}
      names={namesFromCode()}
      readOnly={false}
      onSelectNode={select}
      onAddStep={add}
    />,
  );
  const trigger = screen.getByRole('button', { name: 'No trigger yet.' });
  trigger.focus();
  fireEvent.click(trigger);
  expect(select).toHaveBeenCalledWith('trigger');
  const yes = screen.getByRole('button', { name: 'Add step to Yes branch' });
  yes.focus();
  fireEvent.keyDown(yes, { key: 'Enter' });
  const email = await screen.findByRole('menuitem', { name: 'Send email' });
  await waitFor(() => expect(document.activeElement).toBe(email));
  fireEvent.keyDown(email, { key: 'Escape' });
  await waitFor(() => expect(document.activeElement).toBe(yes));
  fireEvent.keyDown(yes, { key: 'Enter' });
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Send email' }));
  expect(add).toHaveBeenCalledWith('steps.0.then', 0, 'send_email');
  expect(screen.getByRole('button', { name: 'Add step to No branch' })).toBeDefined();
});
it('keeps read-only viewers from inserting steps', () => {
  render(
    <FlowListView
      definition={definition}
      names={namesFromCode()}
      readOnly
      onSelectNode={vi.fn()}
      onAddStep={vi.fn()}
    />,
  );
  expect(screen.queryByRole('button', { name: /Add step/ })).toBeNull();
  expect(screen.getByRole('button', { name: 'No trigger yet.' })).toBeDefined();
});
