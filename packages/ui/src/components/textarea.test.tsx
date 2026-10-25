import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Textarea } from './textarea';

describe('Textarea', () => {
  it('updates its value as the user types', () => {
    render(<Textarea aria-label="Notes" />);

    const textarea = screen.getByLabelText<HTMLTextAreaElement>('Notes');
    expect(textarea.tagName).toBe('TEXTAREA');
    expect(textarea.getAttribute('data-slot')).toBe('textarea');
    expect(textarea.value).toBe('');

    fireEvent.change(textarea, { target: { value: 'Two travellers, one vehicle.' } });
    expect(textarea.value).toBe('Two travellers, one vehicle.');
  });

  it('forwards aria-invalid and merges a caller className', () => {
    render(<Textarea aria-label="Notes" aria-invalid className="mt-2" rows={6} />);

    const textarea = screen.getByLabelText<HTMLTextAreaElement>('Notes');
    expect(textarea.getAttribute('aria-invalid')).toBe('true');
    expect(textarea.rows).toBe(6);
    expect(textarea.className).toContain('min-h-16');
    expect(textarea.className).toContain('mt-2');
    expect(textarea.className).toContain('aria-invalid:border-destructive');
  });
});
