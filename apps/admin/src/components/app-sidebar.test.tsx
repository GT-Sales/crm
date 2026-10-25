import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SidebarProvider } from '@gt-sales/ui';

import { AppSidebar } from './app-sidebar.js';

const usePathname = vi.fn();
vi.mock('next/navigation', () => ({ usePathname: () => usePathname() }));

function renderSidebar(workspace: string) {
  return render(
    <SidebarProvider>
      <AppSidebar workspace={workspace} />
    </SidebarProvider>,
  );
}

describe('AppSidebar', () => {
  it('marks the current section as the active page', () => {
    usePathname.mockReturnValue('/w/getcanadasim/leads');
    renderSidebar('getcanadasim');

    expect(screen.getByRole('link', { name: /leads/i }).getAttribute('aria-current')).toBe('page');
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

  it('offers only sections that exist', () => {
    usePathname.mockReturnValue('/w/canadawide/leads');
    renderSidebar('canadawide');

    expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Leads',
      'Documents',
      'Settings',
    ]);
  });
});
