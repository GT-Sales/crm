import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { toast } from './toast';

// The setup file mounts the Toaster once, as the root layout does.
const corner = () => screen.getByRole('region', { name: 'Notifications' });

describe('toast', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a confirmation in the corner and closes it with Dismiss', () => {
    act(() => {
      toast('Archived 1 lead.');
    });
    const shown = within(corner()).getByRole('status');
    expect(shown.textContent).toContain('Archived 1 lead.');
    fireEvent.click(within(shown).getByRole('button', { name: 'Dismiss' }));
    expect(within(corner()).queryByText('Archived 1 lead.')).toBeNull();
  });

  it('announces an error as an alert', () => {
    act(() => {
      toast('The browser did not allow copying.', { tone: 'error' });
    });
    expect(within(corner()).getByRole('alert').textContent).toContain(
      'The browser did not allow copying.',
    );
  });

  it('closes on its own, an error later than a confirmation', () => {
    vi.useFakeTimers();
    act(() => {
      toast('Saved.');
      toast('Could not save.', { tone: 'error' });
    });
    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    expect(within(corner()).queryByText('Saved.')).toBeNull();
    expect(within(corner()).getByText('Could not save.')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    expect(within(corner()).queryByText('Could not save.')).toBeNull();
  });

  it('keeps at most three, and one copy of the same words', () => {
    act(() => {
      for (const text of ['One.', 'Two.', 'Three.', 'Four.', 'Four.']) toast(text);
    });
    const texts = within(corner())
      .getAllByRole('status')
      .map((item) => item.textContent);
    expect(texts).toEqual(['Two.', 'Three.', 'Four.']);
  });
});
