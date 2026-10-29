import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Checkbox } from './checkbox';

describe('Checkbox', () => {
  it('exposes the checkbox role with its label and toggles on click', () => {
    const onCheckedChange = vi.fn();
    render(<Checkbox aria-label="Select row" onCheckedChange={onCheckedChange} />);
    const box = screen.getByRole('checkbox', { name: 'Select row' });
    expect(box.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(box);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('reports the mixed state for indeterminate', () => {
    render(<Checkbox aria-label="Select all" checked="indeterminate" />);
    expect(screen.getByRole('checkbox', { name: 'Select all' }).getAttribute('aria-checked')).toBe(
      'mixed',
    );
  });

  it('does not toggle while disabled', () => {
    const onCheckedChange = vi.fn();
    render(<Checkbox aria-label="Select row" disabled onCheckedChange={onCheckedChange} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select row' }));
    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});
