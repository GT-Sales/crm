import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
const listDocumentReviewQueue = vi.fn();
vi.mock('../lib/api', () => ({
  getLeadsSummary: (...args: unknown[]) => getLeadsSummary(...args),
  listDocumentReviewQueue: (...args: unknown[]) => listDocumentReviewQueue(...args),
}));
vi.mock('./staff-session-provider', () => ({
  useStaffSession: () => ({
    accessToken: 'staff-token',
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
    getLeadsSummary.mockReset();
    listDocumentReviewQueue.mockReset();
    // A role without document access: the queue refuses and no count shows.
    listDocumentReviewQueue.mockRejectedValue(new Error('permission_denied'));
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

  it('counts documents waiting for a first review beside Documents, and refreshes after a review', async () => {
    listDocumentReviewQueue.mockResolvedValue({ counts: { toReview: 2, rejected: 1 } });
    renderSidebar('getcanadasim');
    const link = await screen.findByRole('link', { name: 'Documents, 2 to review' });
    expect(link.getAttribute('href')).toBe('/w/getcanadasim/documents');
    expect(listDocumentReviewQueue).toHaveBeenCalledWith(
      'staff-token',
      '10000000-0000-4000-8000-000000000001',
      { status: 'to_review' },
    );
    listDocumentReviewQueue.mockResolvedValue({ counts: { toReview: 1, rejected: 1 } });
    window.dispatchEvent(new CustomEvent('crm:documents-reviewed'));
    expect(await screen.findByRole('link', { name: 'Documents, 1 to review' })).toBeTruthy();
  });

  it('shows no Documents count to a role the queue refuses', async () => {
    renderSidebar('getcanadasim');
    await waitFor(() => expect(listDocumentReviewQueue).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Documents' }).textContent).toBe('Documents'),
    );
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
