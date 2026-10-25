import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './dialog';

function renderOrderDialog() {
  render(
    <Dialog>
      <DialogTrigger>Open order</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Order details</DialogTitle>
          <DialogDescription>Review the order before submitting it.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose>Cancel</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>,
  );

  return screen.getByRole('button', { name: 'Open order' });
}

describe('Dialog', () => {
  it('stays closed until the trigger is activated', () => {
    renderOrderDialog();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('Order details')).toBeNull();
  });

  it('opens with its title, description and close button', async () => {
    fireEvent.click(renderOrderDialog());

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Order details')).toBeTruthy();
    expect(within(dialog).getByText('Review the order before submitting it.')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('closes again when the close button is pressed', async () => {
    fireEvent.click(renderOrderDialog());

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
