import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarProvider } from '@gt-sales/ui';

import { AppSidebar } from './app-sidebar.js';

const usePathname = vi.fn();
const push = vi.fn();
vi.mock('next/navigation', () => ({
  usePathname: () => usePathname(),
  useRouter: () => ({ push }),
}));

const getLeadsSummary = vi.fn();
const listWorkspaceMembers = vi.fn();
const signOut = vi.fn();
const askAi = vi.hoisted(() => ({ enabled: false }));
vi.mock('./ai/assistant-provider', () => ({
  useOptionalAssistant: () => ({ conversations: { enabled: askAi.enabled } }),
}));
vi.mock('../lib/api', () => ({
  listWorkspaceMembers: (...args: unknown[]) => listWorkspaceMembers(...args),
  getLeadsSummary: (...args: unknown[]) => getLeadsSummary(...args),
}));
vi.mock('./staff-session-provider', () => ({
  useStaffSession: () => ({
    accessToken: 'staff-token',
    email: 'alex@example.test',
    signOut,
    workspaces: [
      {
        id: '10000000-0000-4000-8000-000000000001',
        slug: 'getcanadasim',
        name: 'Get Canada Sim',
        roles: ['owner'],
      },
      {
        id: '10000000-0000-4000-8000-000000000002',
        slug: 'canadawide',
        name: 'CanadaWide',
        roles: ['owner'],
      },
    ],
  }),
}));

function renderSidebar(workspace: string) {
  return render(
    <SidebarProvider>
      <AppSidebar workspace={workspace} />
    </SidebarProvider>,
  );
}

describe('AppSidebar', () => {
  beforeEach(() => {
    push.mockReset();
    signOut.mockReset();
    listWorkspaceMembers.mockResolvedValue({
      members: [{ displayName: 'Alex Example', isSelf: true }],
    });
    getLeadsSummary.mockReset();
    askAi.enabled = false;
    getLeadsSummary.mockResolvedValue({
      types: [],
      archived: 0,
      trash: 0,
      requestId: '00000000-0000-4000-8000-000000000001',
    });
  });

  it('replaces the brand with a site switcher that keeps the current section', async () => {
    usePathname.mockReturnValue('/w/getcanadasim/tasks');
    renderSidebar('getcanadasim');

    expect(screen.queryByText('GT Sales CRM')).toBeNull();
    const switcher = screen.getByRole('button', { name: 'Switch site' });
    expect(switcher.textContent).toContain('Get Canada Sim');
    fireEvent.pointerDown(switcher, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'CanadaWide' }));
    expect(push).toHaveBeenCalledWith('/w/canadawide/tasks');
  });

  it('shows the signed-in identity and signs out from the sidebar footer', async () => {
    usePathname.mockReturnValue('/w/canadawide/dashboard');
    renderSidebar('canadawide');

    expect(await screen.findByText('Alex Example')).toBeTruthy();
    expect(screen.getByText('alex@example.test')).toBeTruthy();
    expect(screen.queryByText('Site workspace')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalledOnce();
  });

  it('marks the current section as the active page', () => {
    usePathname.mockReturnValue('/w/getcanadasim/leads');
    renderSidebar('getcanadasim');

    expect(screen.getByRole('link', { name: /^leads$/i }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('does not mark a different section as active', () => {
    usePathname.mockReturnValue('/w/getcanadasim/leads');
    renderSidebar('getcanadasim');

    expect(screen.getByRole('link', { name: 'My tasks' }).getAttribute('aria-current')).toBeNull();
  });

  it('links every nav item to the current site slug', () => {
    usePathname.mockReturnValue('/w/canadawide/leads');
    renderSidebar('canadawide');

    expect(screen.getByRole('link', { name: 'My tasks' }).getAttribute('href')).toBe(
      '/w/canadawide/tasks',
    );
  });

  it('has no Reports link: the source report lives on the Dashboard', () => {
    usePathname.mockReturnValue('/w/canadawide/dashboard');
    renderSidebar('canadawide');

    expect(screen.queryByRole('link', { name: /^reports$/i })).toBeNull();
  });

  /** Each group of the sidebar: its heading (or none) and its link names, in order. */
  function groupsOf() {
    const nav = screen.getByRole('navigation', { name: 'Site navigation' });
    return within(nav)
      .getAllByRole('group')
      .map((group) => ({
        heading: group.getAttribute('aria-labelledby')
          ? (group.ownerDocument.getElementById(group.getAttribute('aria-labelledby')!)
              ?.textContent ?? null)
          : null,
        links: within(group)
          .getAllByRole('link')
          .map((link) => link.textContent),
      }));
  }

  it('groups the pages: Dashboard alone, then Work, Insights and Setup', () => {
    usePathname.mockReturnValue('/w/canadawide/leads');
    renderSidebar('canadawide');

    expect(groupsOf()).toEqual([
      { heading: null, links: ['Dashboard'] },
      { heading: 'Work', links: ['Leads', 'My tasks', 'Mail'] },
      { heading: 'Insights', links: ['Analytics'] },
      { heading: 'Setup', links: ['Automations', 'Settings'] },
    ]);
    expect(screen.queryByRole('link', { name: /documents/i })).toBeNull();
    expect(screen.queryByText('Manage')).toBeNull();
  });

  it('puts Ask AI under Dashboard, outside the headed groups, only when conversations are stored', () => {
    usePathname.mockReturnValue('/w/canadawide/chat');
    askAi.enabled = true;
    renderSidebar('canadawide');

    expect(groupsOf()[0]).toEqual({ heading: null, links: ['Dashboard', 'Ask AI'] });
    expect(screen.getByRole('link', { name: 'Ask AI' }).getAttribute('aria-current')).toBe('page');
  });

  it('lists Automations, linked to the site', () => {
    usePathname.mockReturnValue('/w/canadawide/automations');
    renderSidebar('canadawide');

    const link = screen.getByRole('link', { name: 'Automations' });
    expect(link.getAttribute('href')).toBe('/w/canadawide/automations');
    expect(link.getAttribute('aria-current')).toBe('page');
  });

  it('counts the leads no one has opened yet beside Leads', async () => {
    usePathname.mockReturnValue('/w/getcanadasim/tasks');
    getLeadsSummary.mockResolvedValue({
      types: [
        { leadType: 'sim_order', total: 94, unopened: 3 },
        { leadType: 'partner_application', total: 5, unopened: 0 },
      ],
      archived: 44,
      trash: 44,
      requestId: '00000000-0000-4000-8000-000000000001',
    });
    renderSidebar('getcanadasim');

    expect(await screen.findByRole('link', { name: 'Leads, 3 new' })).toBeTruthy();
    expect(getLeadsSummary).toHaveBeenCalledWith(
      'staff-token',
      '10000000-0000-4000-8000-000000000001',
    );
  });
});
