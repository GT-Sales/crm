import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
