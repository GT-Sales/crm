import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LeadsList } from './leads-list';

const mocks = vi.hoisted(() => ({
  getStaffLeads: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  getStaffLeads: mocks.getStaffLeads,
  BackendError: class extends Error {},
}));

vi.mock('./staff-session-provider', () => ({
  useStaffSession: () => ({
    accessToken: 'staff-token',
    workspaces: [
      {
        id: '10000000-0000-4000-8000-000000000001',
        slug: 'site-1',
        name: 'Site 1',
        roles: ['owner'],
        permissions: [],
      },
    ],
  }),
}));

describe('LeadsList', () => {
  beforeEach(() => {
    mocks.getStaffLeads.mockReset();
    mocks.getStaffLeads.mockResolvedValue({
      leads: [
        {
          id: '90000000-0000-4000-8000-000000000001',
          workspaceId: '10000000-0000-4000-8000-000000000001',
          leadType: 'sim_order',
          status: 'incomplete',
          contact: { fullName: 'Synthetic Customer' },
          contactId: null,
          assignedActorId: null,
          externalRef: null,
          source: 'utm:google/cpc',
          attribution: { utmSource: 'google', utmMedium: 'cpc' },
          consentVersion: 'terms-test',
          createdAt: '2026-09-16T00:00:00.000Z',
          updatedAt: '2026-09-16T00:00:00.000Z',
        },
      ],
      page: { page: 1, pageSize: 25, total: 1 },
    });
  });

  it('renders lead attribution and requests the incomplete filter', async () => {
    render(<LeadsList workspaceSlug="site-1" />);

    expect(await screen.findByText('Synthetic Customer')).toBeTruthy();
    expect(screen.getByText('utm:google/cpc')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Incomplete' }));

    await waitFor(() =>
      expect(mocks.getStaffLeads).toHaveBeenLastCalledWith(
        'staff-token',
        '10000000-0000-4000-8000-000000000001',
        { status: 'incomplete', page: 1, pageSize: 25 },
      ),
    );
  });

  it('loads the next page and resets pagination when the status filter changes', async () => {
    const response = await mocks.getStaffLeads();
    mocks.getStaffLeads.mockClear();
    mocks.getStaffLeads
      .mockResolvedValueOnce({ ...response, page: { page: 1, pageSize: 25, total: 26 } })
      .mockResolvedValueOnce({ ...response, page: { page: 2, pageSize: 25, total: 26 } });
    render(<LeadsList workspaceSlug="site-1" />);
    await screen.findByText('Synthetic Customer');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(mocks.getStaffLeads).toHaveBeenLastCalledWith(
        'staff-token',
        '10000000-0000-4000-8000-000000000001',
        { status: undefined, page: 2, pageSize: 25 },
      ),
    );
    await screen.findByText('Page 2 of 2 · 26 lead(s)');
    fireEvent.click(screen.getByRole('button', { name: 'Incomplete' }));
    await waitFor(() =>
      expect(mocks.getStaffLeads).toHaveBeenLastCalledWith(
        'staff-token',
        '10000000-0000-4000-8000-000000000001',
        { status: 'incomplete', page: 1, pageSize: 25 },
      ),
    );
  });

  it('keeps newer filter results when the initial response arrives late', async () => {
    const oldResponse = await mocks.getStaffLeads();
    type Response = Awaited<ReturnType<typeof import('../lib/api').getStaffLeads>>;
    let resolveStale: (value: Response) => void = () => undefined;
    const stale = new Promise<Response>((resolve) => {
      resolveStale = resolve;
    });
    mocks.getStaffLeads.mockReset();
    mocks.getStaffLeads.mockReturnValueOnce(stale).mockResolvedValueOnce({
      leads: [],
      page: { page: 1, pageSize: 25, total: 0 },
    });
    render(<LeadsList workspaceSlug="site-1" />);
    await waitFor(() => expect(mocks.getStaffLeads).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Incomplete' }));
    await screen.findByText('No leads yet.');
    await act(async () => {
      resolveStale(oldResponse);
    });
    expect(screen.queryByText('Synthetic Customer')).toBeNull();
  });
});
