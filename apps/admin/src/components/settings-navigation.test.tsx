import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { SettingsNavigation } from './settings-navigation';

const mocks = vi.hoisted(
  (): { roles: string[]; pathname: string; push: ReturnType<typeof vi.fn> } => ({
    roles: ['owner'],
    pathname: '/w/canadawide/settings/ai-usage',
    push: vi.fn(),
  }),
);

vi.mock('next/navigation', () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock('./staff-session-provider', () => ({
  useStaffSession: () => ({
    accessToken: 'staff-token',
    workspaces: [{ id: 'site', slug: 'canadawide', roles: mocks.roles }],
  }),
}));

afterEach(() => {
  cleanup();
  mocks.roles = ['owner'];
  mocks.pathname = '/w/canadawide/settings/ai-usage';
  mocks.push.mockReset();
});

/** The grouped links: heading text (from aria-labelledby) and link names in order. */
function linkGroups() {
  const nav = screen.getByRole('navigation', { name: 'Settings sections' });
  return Array.from(nav.querySelectorAll<HTMLElement>('div[role="group"]')).map((group) => ({
    heading: group.ownerDocument.getElementById(group.getAttribute('aria-labelledby')!)
      ?.textContent,
    links: within(group)
      .getAllByRole('link')
      .map((link) => link.textContent),
  }));
}

it('groups the sections under Workspace, Sales, Communication, AI and System for the owner', () => {
  render(<SettingsNavigation workspaceSlug="canadawide" />);
  expect(linkGroups()).toEqual([
    { heading: 'Workspace', links: ['General', 'Team'] },
    { heading: 'Sales', links: ['Plans', 'Fields and layouts'] },
    { heading: 'Communication', links: ['Email'] },
    { heading: 'AI', links: ['AI usage'] },
    { heading: 'System', links: ['Integrations', 'Background jobs'] },
  ]);
  expect(screen.queryByText('Properties and record layouts')).toBeNull();
  expect(screen.getByRole('link', { name: 'Fields and layouts' }).getAttribute('href')).toBe(
    '/w/canadawide/settings/properties',
  );
});

it('marks only the current page with aria-current', () => {
  render(<SettingsNavigation workspaceSlug="canadawide" />);
  const usage = screen.getByRole('link', { name: 'AI usage' });
  expect(usage.getAttribute('href')).toBe('/w/canadawide/settings/ai-usage');
  expect(usage.getAttribute('aria-current')).toBe('page');
  const current = screen
    .getAllByRole('link')
    .filter((link) => link.getAttribute('aria-current') === 'page');
  expect(current).toEqual([usage]);
});

it('marks General only on the settings root', () => {
  mocks.pathname = '/w/canadawide/settings';
  render(<SettingsNavigation workspaceSlug="canadawide" />);
  expect(screen.getByRole('link', { name: 'General' }).getAttribute('aria-current')).toBe('page');
  expect(screen.getByRole('link', { name: 'Team' }).getAttribute('aria-current')).toBeNull();
});

it('drops the AI group, heading and all, for everyone but the owner: AI usage shows every member’s usage', () => {
  mocks.roles = ['leads', 'orders'];
  render(<SettingsNavigation workspaceSlug="canadawide" />);
  expect(linkGroups().map((group) => group.heading)).toEqual([
    'Workspace',
    'Sales',
    'Communication',
    'System',
  ]);
  expect(screen.queryByRole('link', { name: 'AI usage' })).toBeNull();
  expect(screen.queryByText('AI', { selector: 'p' })).toBeNull();
  expect(screen.queryByRole('option', { name: 'AI usage' })).toBeNull();
  expect(screen.queryByRole('group', { name: 'AI' })).toBeNull();
});

it('does the same for a viewer', () => {
  mocks.roles = ['viewer'];
  render(<SettingsNavigation workspaceSlug="canadawide" />);
  expect(screen.queryByRole('link', { name: 'AI usage' })).toBeNull();
  expect(screen.queryByRole('group', { name: 'AI' })).toBeNull();
  expect(screen.getByRole('link', { name: 'Team' })).toBeTruthy();
});

it('offers a select with the same groups at phone width, showing the current page', () => {
  mocks.pathname = '/w/canadawide/settings/plans';
  render(<SettingsNavigation workspaceSlug="canadawide" />);
  const select = screen.getByRole('combobox', { name: 'Settings section' });
  expect(select).toHaveProperty('value', '/w/canadawide/settings/plans');
  const groups = within(select)
    .getAllByRole('group')
    .map((group) => ({
      label: group.getAttribute('label'),
      options: within(group)
        .getAllByRole('option')
        .map((option) => option.textContent),
    }));
  expect(groups).toEqual([
    { label: 'Workspace', options: ['General', 'Team'] },
    { label: 'Sales', options: ['Plans', 'Fields and layouts'] },
    { label: 'Communication', options: ['Email'] },
    { label: 'AI', options: ['AI usage'] },
    { label: 'System', options: ['Integrations', 'Background jobs'] },
  ]);
});

it('navigates when the select changes', () => {
  mocks.pathname = '/w/canadawide/settings/plans';
  render(<SettingsNavigation workspaceSlug="canadawide" />);
  fireEvent.change(screen.getByRole('combobox', { name: 'Settings section' }), {
    target: { value: '/w/canadawide/settings/jobs' },
  });
  expect(mocks.push).toHaveBeenCalledWith('/w/canadawide/settings/jobs');
});

it('leaves AI usage out of the select for a limited role', () => {
  mocks.roles = ['leads'];
  render(<SettingsNavigation workspaceSlug="canadawide" />);
  const select = screen.getByRole('combobox', { name: 'Settings section' });
  expect(within(select).queryByRole('option', { name: 'AI usage' })).toBeNull();
  expect(within(select).queryByRole('group', { name: 'AI' })).toBeNull();
});
