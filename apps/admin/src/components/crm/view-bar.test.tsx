import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FilterChip, ViewBar } from './view-bar';

describe('ViewBar', () => {
  it('renders the switcher, the actions and the chips', () => {
    render(
      <ViewBar
        switcher={<span>All leads</span>}
        actions={<button type="button">Filter</button>}
        chips={<span>Stage: New</span>}
      />,
    );
    expect(screen.getByText('All leads')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Filter' })).toBeTruthy();
    expect(screen.getByText('Stage: New')).toBeTruthy();
  });

  it('hides the chips row when there are no chips and no details', () => {
    const { container } = render(
      <ViewBar switcher={<span>All leads</span>} actions={null} chips={null} />,
    );
    expect(container.querySelectorAll('div.border-t')).toHaveLength(0);
  });

  it('shows the details beside the chips', () => {
    render(
      <ViewBar
        switcher={<span>All leads</span>}
        actions={null}
        chips={<span>Stage: New</span>}
        details={<button type="button">Reset</button>}
      />,
    );
    expect(screen.getByRole('button', { name: 'Reset' })).toBeTruthy();
  });
});

describe('FilterChip', () => {
  it('labels its remove button with the filter label and calls onRemove', () => {
    const onRemove = vi.fn();
    render(<FilterChip label="Stage" value="New" onRemove={onRemove} />);
    expect(screen.getByText('New')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Stage' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
