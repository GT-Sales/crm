import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StaffInviteForm } from './staff-invite-form';

const WORKSPACE = '10000000-0000-4000-8000-000000000001';

const mocks = vi.hoisted(() => ({ inviteStaff: vi.fn(), roles: ['owner'] }));

vi.mock('../lib/api', () => ({
  inviteStaff: mocks.inviteStaff,
  BackendError: class extends Error {},
}));

vi.mock('./staff-session-provider', () => ({
  useStaffSession: () => ({
    accessToken: 'staff-token',
    workspaces: [{ id: WORKSPACE, slug: 'canadawide', roles: mocks.roles }],
  }),
}));

const form = () => screen.getByRole('form', { name: 'Invite new members by email address' });

beforeEach(() => {
  mocks.inviteStaff.mockReset();
  mocks.roles = ['owner'];
});

describe('StaffInviteForm', () => {
  it('folds the form behind an Invite member button below md and opens it in place', () => {
    render(<StaffInviteForm workspaceSlug="canadawide" />);
    const toggle = screen.getByRole('button', { name: 'Invite member' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.className).toContain('md:hidden');
    expect(toggle.getAttribute('aria-controls')).toBe(form().id);
    // Folded on phones only: from md the form is always shown.
    expect(form().className).toContain('max-md:hidden');

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(form().className).not.toContain('max-md:hidden');

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(form().className).toContain('max-md:hidden');
  });

  it('still sends the invitation as before', async () => {
    mocks.inviteStaff.mockResolvedValue({});
    render(<StaffInviteForm workspaceSlug="canadawide" />);
    fireEvent.click(screen.getByRole('button', { name: 'Invite member' }));
    fireEvent.change(screen.getByLabelText('Staff email'), {
      target: { value: ' jane@example.com ' },
    });
    fireEvent.submit(form());
    expect(
      await screen.findByText(
        'Invitation is pending. The recipient can now accept it from the sign-in page.',
      ),
    ).toBeTruthy();
    expect(mocks.inviteStaff).toHaveBeenCalledWith('staff-token', WORKSPACE, {
      email: 'jane@example.com',
      roles: ['viewer'],
    });
  });

  it('sends a group invitation once per person when a retry follows a failure', async () => {
    mocks.inviteStaff
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('connection dropped'))
      .mockResolvedValue({});
    render(<StaffInviteForm workspaceSlug="canadawide" />);
    fireEvent.change(screen.getByLabelText('Staff email'), {
      target: { value: 'one@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add more' }));
    fireEvent.change(screen.getByLabelText('Staff email 2'), {
      target: { value: 'two@example.com' },
    });
    fireEvent.submit(form());
    expect(await screen.findByText(/1 of 2 invitations are pending/)).toBeTruthy();
    // The invited row left the form; the failed one is still there.
    expect(screen.queryByDisplayValue('one@example.com')).toBeNull();
    expect(screen.getByDisplayValue('two@example.com')).toBeTruthy();

    fireEvent.submit(form());
    expect(
      await screen.findByText(
        'Invitation is pending. The recipient can now accept it from the sign-in page.',
      ),
    ).toBeTruthy();
    const emails = mocks.inviteStaff.mock.calls.map((call) => call[2].email);
    expect(emails).toEqual(['one@example.com', 'two@example.com', 'two@example.com']);
    expect(emails.filter((email) => email === 'one@example.com')).toHaveLength(1);
  });

  it('shows nothing to a member who is not the owner', () => {
    mocks.roles = ['leads'];
    const { container } = render(<StaffInviteForm workspaceSlug="canadawide" />);
    expect(container.textContent).toBe('');
  });
});
