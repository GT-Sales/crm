import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Calendar } from './calendar';

describe('Calendar', () => {
  it('shows the month of the picked day, marks today and picks a day', () => {
    const onSelect = vi.fn();
    render(<Calendar value="2026-11-24" today="2026-11-19" onSelect={onSelect} />);
    expect(screen.getByText('November 2026')).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: 'Thursday, November 19, 2026' })
        .getAttribute('aria-current'),
    ).toBe('date');
    fireEvent.click(screen.getByRole('button', { name: 'Friday, November 20, 2026' }));
    expect(onSelect).toHaveBeenCalledWith('2026-11-20');
  });

  it('moves by arrow keys and months, keeping one day in the tab order', async () => {
    render(<Calendar today="2026-11-30" onSelect={() => {}} />);
    const grid = screen.getByRole('grid');
    const stop = () => grid.querySelector('button[tabindex="0"]')?.getAttribute('aria-label');
    expect(stop()).toBe('Monday, November 30, 2026');
    fireEvent.keyDown(stop() ? grid.querySelector('button[tabindex="0"]')! : grid, {
      key: 'ArrowRight',
    });
    await waitFor(() => expect(stop()).toBe('Tuesday, December 1, 2026'));
    fireEvent.keyDown(grid.querySelector('button[tabindex="0"]')!, { key: 'PageUp' });
    await waitFor(() => expect(stop()).toBe('Sunday, November 1, 2026'));
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    expect(screen.getByText('December 2026')).toBeTruthy();
  });
});
