import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FormField } from './form-field';
import { Input } from './input';

describe('FormField', () => {
  it('supports an error icon before the hint without changing control associations', () => {
    render(
      <FormField
        id="preview-email"
        label="Preview email"
        hint="Hint"
        error="Fix email"
        errorBeforeHint
        errorIcon={<span aria-hidden="true">!</span>}
      >
        <Input />
      </FormField>,
    );
    const error = screen.getByRole('alert');
    const hint = document.getElementById('preview-email-hint');
    expect(error.nextElementSibling).toBe(hint);
    expect(error.querySelector('[aria-hidden="true"]')?.textContent).toBe('!');
    expect(screen.getByLabelText('Preview email').getAttribute('aria-describedby')).toBe(
      'preview-email-hint preview-email-error',
    );
  });
  it('associates the label, hint and error with the child control', () => {
    render(
      <FormField
        id="email"
        label="Email address"
        hint="We only use this to send your order confirmation."
        error="Enter a valid email address."
      >
        <Input type="email" />
      </FormField>,
    );

    const input = screen.getByLabelText<HTMLInputElement>('Email address');
    expect(input.id).toBe('email');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe('email-hint email-error');

    const hint = document.getElementById('email-hint');
    expect(hint?.textContent).toBe('We only use this to send your order confirmation.');

    const error = screen.getByRole('alert');
    expect(error.id).toBe('email-error');
    expect(error.textContent).toBe('Enter a valid email address.');
  });

  it('omits the error wiring and marks the control valid when there is no error', () => {
    render(
      <FormField id="phone" label="Phone number" hint="Include your country code.">
        <Input type="tel" />
      </FormField>,
    );

    const input = screen.getByLabelText<HTMLInputElement>('Phone number');
    expect(input.getAttribute('aria-invalid')).toBe('false');
    expect(input.getAttribute('aria-describedby')).toBe('phone-hint');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.getElementById('phone-error')).toBeNull();
  });

  it('describes the control through the error alone when there is no hint', () => {
    render(
      <FormField id="city" label="City" error="City is required.">
        <Input />
      </FormField>,
    );

    const input = screen.getByLabelText<HTMLInputElement>('City');
    expect(input.getAttribute('aria-describedby')).toBe('city-error');
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('appends a required hint announced with the label', () => {
    render(
      <FormField id="full-name" label="Full name" required>
        <Input />
      </FormField>,
    );

    expect(screen.getByText('(required)')).toBeTruthy();
    const input = screen.getByLabelText<HTMLInputElement>(/full name/i);
    expect(input.id).toBe('full-name');
    expect(document.querySelector('label[for="full-name"]')?.textContent).toBe(
      'Full name (required)',
    );
  });
});
