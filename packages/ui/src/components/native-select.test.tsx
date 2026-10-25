import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FormField } from './form-field';
import { NativeSelect } from './native-select';

describe('NativeSelect', () => {
  it('renders a native select whose value changes with the user’s choice', () => {
    render(
      <NativeSelect aria-label="Province" defaultValue="">
        <option value="">Choose</option>
        <option value="SK">Saskatchewan</option>
      </NativeSelect>,
    );

    const select = screen.getByLabelText<HTMLSelectElement>('Province');
    expect(select.tagName).toBe('SELECT');
    expect(select.getAttribute('data-slot')).toBe('native-select');
    expect(select.value).toBe('');

    fireEvent.change(select, { target: { value: 'SK' } });
    expect(select.value).toBe('SK');
  });

  it('forwards aria-invalid and merges a caller className', () => {
    render(
      <NativeSelect aria-label="Province" aria-invalid className="mt-2">
        <option value="SK">Saskatchewan</option>
      </NativeSelect>,
    );

    const select = screen.getByLabelText<HTMLSelectElement>('Province');
    expect(select.getAttribute('aria-invalid')).toBe('true');
    expect(select.className).toContain('h-9');
    expect(select.className).toContain('mt-2');
    expect(select.className).toContain('aria-invalid:border-destructive');
  });

  it('is labelled and described by FormField, including its error', () => {
    render(
      <FormField id="province" label="Province" hint="Where you live" error="Choose your province.">
        <NativeSelect>
          <option value="">Choose</option>
        </NativeSelect>
      </FormField>,
    );

    const select = screen.getByLabelText<HTMLSelectElement>('Province');
    expect(select.getAttribute('aria-invalid')).toBe('true');
    expect(select.getAttribute('aria-describedby')).toBe('province-hint province-error');
    expect(screen.getByRole('alert').textContent).toBe('Choose your province.');
  });

  it('can be disabled', () => {
    render(
      <NativeSelect aria-label="Province" disabled>
        <option value="SK">Saskatchewan</option>
      </NativeSelect>,
    );
    expect(screen.getByLabelText<HTMLSelectElement>('Province').disabled).toBe(true);
  });
});
