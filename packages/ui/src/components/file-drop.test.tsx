import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileDrop } from './file-drop';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FileDrop', () => {
  it('renders a labelled, keyboard-focusable file input', () => {
    render(
      <FileDrop
        id="passport"
        label="Passport scan"
        hint="PDF, JPG or PNG, up to 10 MB."
        accept=".pdf,.jpg,.jpeg,.png"
      />,
    );

    const input = screen.getByLabelText<HTMLInputElement>('Passport scan');
    expect(input).toBeInstanceOf(HTMLInputElement);
    expect(input.getAttribute('type')).toBe('file');
    expect(input.getAttribute('accept')).toBe('.pdf,.jpg,.jpeg,.png');
    expect(input.disabled).toBe(false);
    expect(input.getAttribute('aria-describedby')).toBe('passport-hint passport-note');

    input.focus();
    expect(document.activeElement).toBe(input);
  });

  it('applies the default note making clear uploads are not enabled yet', () => {
    render(<FileDrop id="passport" label="Passport scan" />);

    const note = document.getElementById('passport-note');
    expect(note).not.toBeNull();
    expect(note?.textContent).toMatch(/not enabled/i);
  });

  it('honours an explicit note and a disabled state', () => {
    render(
      <FileDrop
        id="proof"
        label="Proof of address"
        note="Uploads open once the order is submitted."
        disabled
      />,
    );

    expect(screen.getByText('Uploads open once the order is submitted.')).toBeTruthy();
    const input = screen.getByLabelText<HTMLInputElement>('Proof of address');
    expect(input.disabled).toBe(true);
  });

  it('makes no network call when rendering the drop area', () => {
    render(<FileDrop id="visa" label="Visa document" />);

    expect(screen.getByLabelText<HTMLInputElement>('Visa document')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
