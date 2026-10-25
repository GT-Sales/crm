import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import MfaEnrollPage from './page';

const mocks = vi.hoisted(() => ({
  router: { replace: vi.fn() },
  listFactors: vi.fn(),
  enroll: vi.fn(),
  unenroll: vi.fn(),
  getAuthenticatorAssuranceLevel: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => mocks.router }));
vi.mock('../../../lib/auth-navigation', () => ({ destinationAfterPrimarySignIn: vi.fn() }));
vi.mock('../../../lib/supabase-auth', () => ({
  isStaffAuthConfigured: () => true,
  getStaffAuth: () => ({
    mfa: {
      listFactors: mocks.listFactors,
      enroll: mocks.enroll,
      unenroll: mocks.unenroll,
      getAuthenticatorAssuranceLevel: mocks.getAuthenticatorAssuranceLevel,
    },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.unenroll.mockResolvedValue({ data: {}, error: null });
  mocks.enroll.mockResolvedValue({
    data: {
      id: 'new-factor',
      type: 'totp',
      totp: { qr_code: 'data:image/svg+xml;base64,AA==', secret: 'SYNTHETICSECRET' },
    },
    error: null,
  });
});

// BUG-05: Supabase lists unverified factors only under `all`, never under `totp`.
it('removes an abandoned unverified factor before enrolling again', async () => {
  mocks.listFactors.mockResolvedValue({
    data: {
      all: [
        { id: 'stale-totp', factor_type: 'totp', status: 'unverified' },
        { id: 'stale-phone', factor_type: 'phone', status: 'unverified' },
      ],
      totp: [],
    },
    error: null,
  });
  render(<MfaEnrollPage />);
  expect(await screen.findByText('Manual key: SYNTHETICSECRET')).toBeTruthy();
  expect(mocks.unenroll).toHaveBeenCalledTimes(1);
  expect(mocks.unenroll).toHaveBeenCalledWith({ factorId: 'stale-totp' });
  expect(mocks.unenroll.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.enroll.mock.invocationCallOrder[0] ?? 0,
  );
  expect(mocks.enroll).toHaveBeenCalledWith({
    factorType: 'totp',
    friendlyName: expect.stringMatching(/^GT Sales CRM Admin \d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  });
});

it('tells the user to reload when enrolment still fails', async () => {
  mocks.listFactors.mockResolvedValue({ data: { all: [], totp: [] }, error: null });
  mocks.enroll.mockResolvedValue({ data: null, error: { code: 'mfa_factor_name_conflict' } });
  render(<MfaEnrollPage />);
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain('Reload the page to try again.'),
  );
});
