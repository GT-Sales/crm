import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { StaffWorkspacesResponse } from '@gt-sales/contracts';
import { StaffSessionProvider, useStaffSession } from './staff-session-provider';

const mocks = vi.hoisted(() => {
  const state: {
    load: ReturnType<typeof vi.fn<() => Promise<StaffWorkspacesResponse>>>;
    changed?: (
      event: string,
      session: { access_token: string; user?: { id: string } } | null,
    ) => void;
  } = {
    load: vi.fn<() => Promise<StaffWorkspacesResponse>>(),
  };
  return state;
});
vi.mock('../lib/api', () => ({
  getStaffWorkspaces: mocks.load,
  BackendError: class extends Error {},
}));
vi.mock('../lib/supabase-auth', () => ({
  isStaffAuthConfigured: () => true,
  getStaffAuth: () => ({
    getSession: async () => ({ data: { session: null } }),
    onAuthStateChange: (callback: typeof mocks.changed) => {
      mocks.changed = callback;
      return { data: { subscription: { unsubscribe: () => {} } } };
    },
  }),
}));
function Status() {
  const session = useStaffSession();
  return (
    <p>
      {session.status}:{session.accessToken ?? 'none'}
    </p>
  );
}
beforeEach(() => {
  mocks.load.mockReset();
});

it('swaps only the token when the same user refreshes, without reloading the screen', async () => {
  mocks.load.mockResolvedValue({
    workspaces: [],
    requestId: '70000000-0000-4000-8000-000000000003',
  });
  const seen: string[] = [];
  function Recorder() {
    const session = useStaffSession();
    seen.push(session.status);
    return (
      <p>
        {session.status}:{session.accessToken ?? 'none'}
      </p>
    );
  }
  render(
    <StaffSessionProvider>
      <Recorder />
    </StaffSessionProvider>,
  );
  await screen.findByText('signed_out:none');
  act(() => mocks.changed?.('SIGNED_IN', { access_token: 'old', user: { id: 'u1' } }));
  await screen.findByText('signed_in:old');
  seen.length = 0;
  act(() => mocks.changed?.('TOKEN_REFRESHED', { access_token: 'new', user: { id: 'u1' } }));
  await screen.findByText('signed_in:new');
  expect(seen).not.toContain('loading');
  expect(mocks.load).toHaveBeenCalledTimes(1);

  // A different person still gets a full reload.
  act(() => mocks.changed?.('SIGNED_IN', { access_token: 'other', user: { id: 'u2' } }));
  await screen.findByText('signed_in:other');
  expect(mocks.load).toHaveBeenCalledTimes(2);
});

it('ignores a workspace response arriving after logout', async () => {
  let finish: ((value: StaffWorkspacesResponse) => void) | undefined;
  mocks.load.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  render(
    <StaffSessionProvider>
      <Status />
    </StaffSessionProvider>,
  );
  await screen.findByText('signed_out:none');
  act(() => mocks.changed?.('SIGNED_IN', { access_token: 'old' }));
  act(() => mocks.changed?.('SIGNED_OUT', null));
  await act(async () =>
    finish?.({ workspaces: [], requestId: '70000000-0000-4000-8000-000000000001' }),
  );
  await waitFor(() => expect(screen.getByText('signed_out:none')).toBeTruthy());
});

it('ignores an older response after switching accounts', async () => {
  let finish: ((value: StaffWorkspacesResponse) => void) | undefined;
  mocks.load.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  mocks.load.mockResolvedValueOnce({
    workspaces: [],
    requestId: '70000000-0000-4000-8000-000000000002',
  });
  render(
    <StaffSessionProvider>
      <Status />
    </StaffSessionProvider>,
  );
  await screen.findByText('signed_out:none');
  act(() => mocks.changed?.('SIGNED_IN', { access_token: 'old' }));
  act(() => mocks.changed?.('SIGNED_IN', { access_token: 'new' }));
  await screen.findByText('signed_in:new');
  await act(async () =>
    finish?.({ workspaces: [], requestId: '70000000-0000-4000-8000-000000000001' }),
  );
  expect(screen.getByText('signed_in:new')).toBeTruthy();
});
