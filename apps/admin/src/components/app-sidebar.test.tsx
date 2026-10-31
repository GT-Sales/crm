import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarProvider } from '@gt-sales/ui';

import { AppSidebar } from './app-sidebar.js';

const usePathname = vi.fn();
vi.mock('next/navigation', () => ({ usePathname: () => usePathname() }));

const getLeadsSummary = vi.fn();
vi.mock('../lib/api', () => ({
  getLeadsSummary: (...args: unknown[]) => getLeadsSummary(...args),
}));
vi.mock('./staff-session-provider', () => ({
  useStaffSession: () => ({
    accessToken: 'staff-token',
    workspaces: [
      { id: '10000000-0000-4000-8000-000000000001', slug: 'getcanadasim', roles: ['owner'] },
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
    getLeadsSummary.mockReset();
    getLeadsSummary.mockResolvedValue({
      types: [],
      archived: 0,
      trash: 0,
      requestId: '00000000-0000-4000-8000-000000000001',
    });
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

    expect(
      screen.getByRole('link', { name: /documents/i }).getAttribute('aria-current'),
    ).toBeNull();
  });

  it('links every nav item to the current site slug', () => {
    usePathname.mockReturnValue('/w/canadawide/leads');
    renderSidebar('canadawide');

    expect(screen.getByRole('link', { name: /documents/i }).getAttribute('href')).toBe(
      '/w/canadawide/documents',
    );
  });

  it('links Reports to the site reports', () => {
    usePathname.mockReturnValue('/w/canadawide/reports/sources');
    renderSidebar('canadawide');

    const reports = screen.getByRole('link', { name: /^reports$/i });
    expect(reports.getAttribute('href')).toBe('/w/canadawide/reports');
    expect(reports.getAttribute('aria-current')).toBe('page');
  });

  it('offers only sections that exist', () => {
    usePathname.mockReturnValue('/w/canadawide/leads');
    renderSidebar('canadawide');

    expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Dashboard',
      'Leads',
      'My tasks',
      'Documents',
      'Reports',
      'Automations',
      'Settings',
    ]);
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
