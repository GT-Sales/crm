import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ReviewCard } from './review-card';

describe('ReviewCard', () => {
  it('renders the title as a heading and the children, with no edit action', () => {
    render(
      <ReviewCard title="Contact details">
        <p>takib@example.com</p>
      </ReviewCard>,
    );

    expect(screen.getByRole('heading', { name: 'Contact details' })).toBeTruthy();
    expect(screen.getByText('takib@example.com')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('calls onEdit when the edit button is pressed', () => {
    const onEdit = vi.fn();
    render(
      <ReviewCard title="Plan" onEdit={onEdit}>
        <p>Rogers 5GB</p>
      </ReviewCard>,
    );

    const edit = screen.getByRole('button', { name: 'Edit' });
    expect(edit.getAttribute('type')).toBe('button');

    fireEvent.click(edit);
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('uses a custom edit label when one is supplied', () => {
    render(
      <ReviewCard title="Plan" onEdit={vi.fn()} editLabel="Change plan">
        <p>Rogers 5GB</p>
      </ReviewCard>,
    );

    expect(screen.getByRole('button', { name: 'Change plan' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });
});
