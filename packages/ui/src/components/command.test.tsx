import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Command } from './command';

const options = [
  { value: 'a', label: 'Alex Kim' },
  { value: 'b', label: 'Sam Rivers', description: 'Leads' },
  { value: 'c', label: 'Taylor Ng' },
];

describe('Command', () => {
  it('filters as you type and chooses with the arrow keys and Enter', () => {
    const onSelect = vi.fn();
    render(<Command label="People" options={options} onSelect={onSelect} />);
    const box = screen.getByRole('combobox', { name: 'People' });
    expect(screen.getAllByRole('option')).toHaveLength(3);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(box.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[1]?.id);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSelect).toHaveBeenLastCalledWith('b');
    fireEvent.change(box, { target: { value: 'tay' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.change(box, { target: { value: 'zzz' } });
    expect(screen.getByRole('status').textContent).toBe('No results.');
  });

  it('leaves filtering to the caller when asked', () => {
    const onQueryChange = vi.fn();
    render(
      <Command
        label="Leads"
        options={options}
        shouldFilter={false}
        onQueryChange={onQueryChange}
        onSelect={() => {}}
      />,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zzz' } });
    expect(onQueryChange).toHaveBeenCalledWith('zzz');
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('does not choose on Enter while results are loading', () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <Command label="Leads" options={options} loading onSelect={onSelect} />,
    );
    const box = screen.getByRole('combobox', { name: 'Leads' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();
    rerender(<Command label="Leads" options={options} onSelect={onSelect} />);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('a');
  });
});
