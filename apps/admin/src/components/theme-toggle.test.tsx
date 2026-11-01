import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ThemeToggle } from './theme-toggle';

afterEach(() => {
  document.documentElement.classList.remove('dark');
  localStorage.removeItem('gt-sales-theme');
});

it('switches the palette and persists the browser preference', () => {
  render(<ThemeToggle />);
  fireEvent.click(screen.getByRole('button', { name: 'Switch to dark mode' }));
  expect(document.documentElement.classList.contains('dark')).toBe(true);
  expect(localStorage.getItem('gt-sales-theme')).toBe('dark');
  fireEvent.click(screen.getByRole('button', { name: 'Switch to light mode' }));
  expect(document.documentElement.classList.contains('dark')).toBe(false);
  expect(localStorage.getItem('gt-sales-theme')).toBe('light');
});
