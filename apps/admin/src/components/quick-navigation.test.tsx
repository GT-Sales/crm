import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { QuickNavigation } from './quick-navigation';

it('opens from the keyboard and filters links within the current site', async () => {
  render(<QuickNavigation workspaceSlug="canadawide" />);
  fireEvent.keyDown(window, { ctrlKey: true, key: 'k' });
  const dialog = await screen.findByRole('dialog', { name: 'Go to a page' });
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Find a page' }), {
    target: { value: 'settings' },
  });
  expect(within(dialog).getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe(
    '/w/canadawide/settings',
  );
  expect(within(dialog).queryByRole('link', { name: 'Leads' })).toBeNull();
  fireEvent.change(within(dialog).getByRole('textbox'), {
    target: { value: 'no matching section' },
  });
  expect(within(dialog).getByRole('status').textContent).toBe('No matching pages.');
});
