import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The workspace check's failures: a CRM that does not answer is shown here
 * with a retry, never as "Access denied"; a real refusal still goes to the
 * denied page.
 */

const mocks = vi.hoisted(() => {
  const session: Record<string, unknown> = {};
  return { replace: vi.fn(), retry: vi.fn(), signOut: vi.fn(), session };
});

vi.mock('next/navigation', () => ({
  usePathname: () => '/w/getcanadasim/leads',
  useRouter: () => ({ replace: mocks.replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('../lib/api', () => ({
  BackendError: class BackendError extends Error {
    constructor(
      readonly code: string,
      readonly status: number,
      readonly requestId: string,
    ) {
      super(code);
    }
  },
}));

vi.mock('./staff-session-provider', () => ({
  useStaffSession: () => ({
    workspaces: [],
    retry: mocks.retry,
    signOut: mocks.signOut,
    ...mocks.session,
  }),
}));

// The signed-in shell is not under test here.
vi.mock('./app-sidebar', () => ({ AppSidebar: () => null }));
vi.mock('./top-bar', () => ({ TopBar: () => null }));
vi.mock('./ai/assistant-panel', () => ({ AssistantPanel: () => null }));
vi.mock('./ai/assistant-provider', () => ({
  AssistantProvider: ({ children }: { children: unknown }) => children,
}));

import { BackendError } from '../lib/api';
import { ProtectedWorkspaceShell } from './protected-workspace-shell';

beforeEach(() => {
  mocks.replace.mockReset();
  mocks.retry.mockReset();
  mocks.session = {};
});
afterEach(cleanup);

describe('ProtectedWorkspaceShell', () => {
  it('says the CRM is not responding, with Try again, when the check times out', () => {
    mocks.session = {
      status: 'error',
      reason: 'internal_error',
      failure: new DOMException('The request timed out.', 'TimeoutError'),
    };
    render(<ProtectedWorkspaceShell workspaceSlug="getcanadasim">page</ProtectedWorkspaceShell>);
    expect(screen.getByRole('heading', { name: 'The CRM is not responding' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe(
      "Couldn't reach the CRM to check your access to this site. Check your internet connection and try again.",
    );
    expect(screen.queryByText(/internal_error|Access denied/)).toBeNull();
    expect(mocks.replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(mocks.retry).toHaveBeenCalledTimes(1);
  });

  it('treats a server failure the same way, never as a denial', () => {
    mocks.session = {
      status: 'error',
      reason: 'internal_error',
      failure: new BackendError('internal_error', 500, 'abcdef12-0000-4000-8000-000000000000'),
    };
    render(<ProtectedWorkspaceShell workspaceSlug="getcanadasim">page</ProtectedWorkspaceShell>);
    expect(screen.getByRole('alert').textContent).toContain('(Ref: abcdef12)');
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('still sends a real refusal to the denied page', () => {
    mocks.session = {
      status: 'error',
      reason: 'membership_revoked',
      failure: new BackendError('membership_revoked', 403, 'x'),
    };
    render(<ProtectedWorkspaceShell workspaceSlug="getcanadasim">page</ProtectedWorkspaceShell>);
    expect(mocks.replace).toHaveBeenCalledWith('/denied?reason=membership_revoked');
    expect(screen.queryByRole('heading', { name: 'The CRM is not responding' })).toBeNull();
  });
});
