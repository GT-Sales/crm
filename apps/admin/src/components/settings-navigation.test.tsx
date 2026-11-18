import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { SettingsNavigation } from './settings-navigation';

const mocks = vi.hoisted((): { roles: string[] } => ({ roles: ['owner'] }));

vi.mock('next/navigation', () => ({ usePathname: () => '/w/canadawide/settings/ai-usage' }));
vi.mock('./staff-session-provider', () => ({
  useStaffSession: () => ({
    accessToken: 'staff-token',
    workspaces: [{ id: 'site', slug: 'canadawide', roles: mocks.roles }],
  }),
}));

afterEach(() => {
  cleanup();
  mocks.roles = ['owner'];
});

it('lists AI usage for the owner', () => {
  render(<SettingsNavigation workspaceSlug="canadawide" />);
  const usage = screen.getByRole('link', { name: 'AI usage' });
  expect(usage.getAttribute('href')).toBe('/w/canadawide/settings/ai-usage');
  expect(usage.getAttribute('aria-current')).toBe('page');
  expect(screen.getByRole('link', { name: 'Team' }).getAttribute('href')).toBe(
    '/w/canadawide/settings/team',
  );
});

it('leaves AI usage out for everyone else: it shows every member’s usage', () => {
  mocks.roles = ['leads', 'orders'];
  render(<SettingsNavigation workspaceSlug="canadawide" />);
  expect(screen.queryByRole('link', { name: 'AI usage' })).toBeNull();
  expect(screen.getByRole('link', { name: 'Team' })).toBeTruthy();
});
