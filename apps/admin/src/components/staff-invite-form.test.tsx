import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StaffInviteForm } from './staff-invite-form';

const WORKSPACE = '10000000-0000-4000-8000-000000000001';

const mocks = vi.hoisted(() => ({ inviteStaff: vi.fn(), roles: ['owner'] }));

vi.mock('../lib/api', () => ({ inviteStaff: mocks.inviteStaff }));

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

  it('shows nothing to a member who is not the owner', () => {
    mocks.roles = ['leads'];
    const { container } = render(<StaffInviteForm workspaceSlug="canadawide" />);
    expect(container.textContent).toBe('');
  });
});
