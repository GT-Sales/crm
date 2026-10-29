import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Popover, PopoverContent, PopoverTrigger } from './popover';

describe('Popover', () => {
  it('opens from its trigger, holds interactive content and closes on Escape', async () => {
    render(
      <Popover>
        <PopoverTrigger>Filter</PopoverTrigger>
        <PopoverContent>
          <label>
            Value
            <input />
          </label>
        </PopoverContent>
      </Popover>,
    );
    expect(screen.queryByLabelText('Value')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    expect(await screen.findByLabelText('Value')).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText('Value'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByLabelText('Value')).toBeNull());
  });
});
