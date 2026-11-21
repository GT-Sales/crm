import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ServiceCredentialsManager } from './service-credentials-manager';

const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const CREDENTIAL = '30000000-0000-4000-8000-000000000001';

const mocks = vi.hoisted(() => ({
  createServiceCredential: vi.fn(),
  listServiceCredentials: vi.fn(),
  revokeServiceCredential: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  ...mocks,
  BackendError: class extends Error {},
}));

vi.mock('./staff-session-provider', () => ({
  useStaffSession: () => ({
    accessToken: 'staff-token',
    workspaces: [{ id: WORKSPACE, slug: 'site-1', roles: ['owner'] }],
  }),
}));

describe('ServiceCredentialsManager scopes', () => {
  beforeEach(() => {
    mocks.createServiceCredential.mockReset();
    mocks.listServiceCredentials.mockResolvedValue({ credentials: [] });
  });

  it('offers order tracking as a scope, off until chosen', async () => {
    render(<ServiceCredentialsManager workspaceSlug="site-1" />);
    const tracking = await screen.findByRole('checkbox', { name: /Order tracking/ });
    expect(tracking).toHaveProperty('checked', false);
    // The scope's own name is still shown beside the label.
    expect(screen.getByText('tracking')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /leads:write/ })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /uploads:customer/ })).toBeTruthy();
  });

  it('issues a credential with the tracking scope when it is ticked', async () => {
    mocks.createServiceCredential.mockResolvedValue({ secret: 'gtsk_example' });
    render(<ServiceCredentialsManager workspaceSlug="site-1" />);
    fireEvent.click(await screen.findByRole('checkbox', { name: /Order tracking/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'SIM order' }));
    fireEvent.click(screen.getByRole('button', { name: 'Issue credential' }));
    await waitFor(() =>
      expect(mocks.createServiceCredential).toHaveBeenCalledWith('staff-token', WORKSPACE, {
        scopes: ['leads:write', 'uploads:customer', 'tracking'],
        leadTypes: ['sim_order'],
      }),
    );
  });
});

describe('ServiceCredentialsManager lead types (#84)', () => {
  beforeEach(() => {
    mocks.createServiceCredential.mockReset();
    mocks.listServiceCredentials.mockResolvedValue({
      credentials: [
        {
          id: CREDENTIAL,
          scopes: ['leads:write'],
          leadTypes: ['internet', 'mobility'],
          createdAt: '2026-09-16T00:00:00.000Z',
          revokedAt: null,
        },
        {
          id: '30000000-0000-4000-8000-000000000002',
          scopes: ['leads:write'],
          leadTypes: null,
          createdAt: '2026-09-15T00:00:00.000Z',
          revokedAt: null,
        },
      ],
    });
  });

  it('offers every registered lead type, none chosen, and issues nothing until one is', async () => {
    render(<ServiceCredentialsManager workspaceSlug="site-1" />);
    const group = await screen.findByRole('group', { name: 'Lead types this key may send' });
    const boxes = within(group).getAllByRole('checkbox');
    expect(boxes.map((box) => box.closest('label')?.textContent)).toEqual([
      'Internet',
      'Mobility',
      'SIM order',
      'Partner application',
      'Contact message',
    ]);
    for (const box of boxes) expect(box).toHaveProperty('checked', false);
    const issue = screen.getByRole('button', { name: 'Issue credential' });
    expect(issue).toHaveProperty('disabled', true);

    mocks.createServiceCredential.mockResolvedValue({ secret: 'gtsk_example' });
    fireEvent.click(within(group).getByRole('checkbox', { name: 'Internet' }));
    fireEvent.click(within(group).getByRole('checkbox', { name: 'Contact message' }));
    expect(issue).toHaveProperty('disabled', false);
    fireEvent.click(issue);
    await waitFor(() =>
      expect(mocks.createServiceCredential).toHaveBeenCalledWith('staff-token', WORKSPACE, {
        scopes: ['leads:write', 'uploads:customer'],
        leadTypes: ['internet', 'contact_message'],
      }),
    );
  });

  it('shows the lead types of each existing key, and says when a key is not limited', async () => {
    render(<ServiceCredentialsManager workspaceSlug="site-1" />);
    expect(await screen.findByText('Lead types: Internet, Mobility')).toBeTruthy();
    expect(screen.getByText('Lead types: not limited (any type)')).toBeTruthy();
  });
});

describe('ServiceCredentialsManager revocation', () => {
  beforeEach(() => {
    mocks.revokeServiceCredential.mockReset();
    mocks.revokeServiceCredential.mockResolvedValue(undefined);
    mocks.listServiceCredentials.mockResolvedValue({
      credentials: [
        {
          id: CREDENTIAL,
          scopes: ['leads:write'],
          createdAt: '2026-09-16T00:00:00.000Z',
          revokedAt: null,
        },
      ],
    });
  });

  it('asks before revoking, and closing the dialog revokes nothing', async () => {
    render(<ServiceCredentialsManager workspaceSlug="site-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    expect(await screen.findByRole('button', { name: 'Revoke credential' })).toBeTruthy();
    expect(mocks.revokeServiceCredential).not.toHaveBeenCalled();

    const closeButtons = screen.getAllByRole('button', { name: 'Close' });
    const footerClose = closeButtons[closeButtons.length - 1];
    if (!footerClose) throw new Error('expected a Close button');
    fireEvent.click(footerClose);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Revoke credential' })).toBeNull(),
    );
    expect(mocks.revokeServiceCredential).not.toHaveBeenCalled();
  });

  it('revokes exactly once after confirmation', async () => {
    render(<ServiceCredentialsManager workspaceSlug="site-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke credential' }));
    await waitFor(() =>
      expect(mocks.revokeServiceCredential).toHaveBeenCalledWith(
        'staff-token',
        WORKSPACE,
        CREDENTIAL,
      ),
    );
    expect(mocks.revokeServiceCredential).toHaveBeenCalledOnce();
  });
});
