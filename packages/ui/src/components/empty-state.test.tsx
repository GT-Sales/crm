import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { EmptyState } from './empty-state';

describe('EmptyState', () => {
  it('shows the headline, the line and the action, with the icon hidden from screen readers', () => {
    const { container } = render(
      <EmptyState
        icon={<svg data-testid="icon" />}
        title="You are all caught up"
        description="Nothing is due."
        action={<button type="button">Add task</button>}
      />,
    );

    expect(screen.getByText('You are all caught up')).toBeTruthy();
    expect(screen.getByText('Nothing is due.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add task' })).toBeTruthy();
    expect(screen.getByTestId('icon').parentElement?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('[data-slot="empty-state"]')).not.toBeNull();
  });

  it('renders only the headline when nothing else is given', () => {
    const { container } = render(<EmptyState title="No mail yet" />);

    expect(screen.getByText('No mail yet')).toBeTruthy();
    expect(container.querySelectorAll('p')).toHaveLength(1);
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
  });
});
