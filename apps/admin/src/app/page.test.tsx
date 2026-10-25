import { describe, expect, it, vi } from 'vitest';

const redirect = vi.fn();
vi.mock('next/navigation', () => ({ redirect }));

describe('HomePage', () => {
  it('redirects to /login', async () => {
    const { default: HomePage } = await import('./page.js');

    expect(() => HomePage()).not.toThrow();
    expect(redirect).toHaveBeenCalledWith('/login');
  });

  it('does not redirect anywhere else', async () => {
    const { default: HomePage } = await import('./page.js');

    HomePage();

    expect(redirect).not.toHaveBeenCalledWith('/denied');
  });
});
