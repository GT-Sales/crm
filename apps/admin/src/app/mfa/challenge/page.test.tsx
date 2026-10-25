import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import MfaChallengePage from './page';

const mocks = vi.hoisted(() => ({
  router: { replace: vi.fn() },
  listFactors: vi.fn(),
  challengeAndVerify: vi.fn(),
  getSession: vi.fn(),
  destination: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => mocks.router }));
vi.mock('../../../lib/auth-navigation', () => ({
  destinationAfterPrimarySignIn: mocks.destination,
}));
vi.mock('../../../lib/supabase-auth', () => ({
  isStaffAuthConfigured: () => true,
  getStaffAuth: () => ({
    mfa: { listFactors: mocks.listFactors, challengeAndVerify: mocks.challengeAndVerify },
    getSession: mocks.getSession,
  }),
}));

const factors = [
  { id: 'primary', friendly_name: 'Primary phone', status: 'verified' },
  { id: 'backup', friendly_name: 'Backup phone', status: 'verified' },
  { id: 'pending', friendly_name: 'Unverified phone', status: 'unverified' },
];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.listFactors.mockResolvedValue({ data: { totp: factors }, error: null });
  mocks.challengeAndVerify.mockResolvedValue({ error: null });
  mocks.getSession.mockResolvedValue({ data: { session: { access_token: 'synthetic-session' } } });
  mocks.destination.mockResolvedValue('/w/site-1/orders');
});

it('challenges the selected verified backup factor', async () => {
  render(<MfaChallengePage />);
  const selector = await screen.findByLabelText('Authenticator');
  expect(screen.queryByRole('option', { name: 'Unverified phone' })).toBeNull();
  fireEvent.change(selector, { target: { value: 'backup' } });
  fireEvent.change(screen.getByLabelText('Authenticator code'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
  await waitFor(() =>
    expect(mocks.challengeAndVerify).toHaveBeenCalledWith({ factorId: 'backup', code: '123456' }),
  );
  await waitFor(() => expect(mocks.router.replace).toHaveBeenCalledWith('/w/site-1/orders'));
});

it('does not silently challenge a different factor when the chosen factor was revoked', async () => {
  render(<MfaChallengePage />);
  fireEvent.change(await screen.findByLabelText('Authenticator'), { target: { value: 'backup' } });
  mocks.listFactors.mockResolvedValueOnce({ data: { totp: [factors[0]] }, error: null });
  fireEvent.change(screen.getByLabelText('Authenticator code'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    expect.stringContaining('no longer available'),
  );
  expect(mocks.challengeAndVerify).not.toHaveBeenCalled();
});
