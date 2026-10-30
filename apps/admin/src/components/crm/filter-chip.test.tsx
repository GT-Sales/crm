import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FilterChip } from './filter-chip';

describe('FilterChip', () => {
  it('labels its remove button with the filter label and calls onRemove', () => {
    const onRemove = vi.fn();
    render(<FilterChip label="Stage" value="New" onRemove={onRemove} />);
    expect(screen.getByText('New')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Stage' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
