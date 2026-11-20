import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssignableMember } from '@gt-sales/contracts';

import { TeamList } from './team-list';

const WORKSPACE = '10000000-0000-4000-8000-000000000001';

const mocks = vi.hoisted(() => ({
  listWorkspaceMembers: vi.fn(),
  revokeStaff: vi.fn(),
  roles: ['owner'],
}));

vi.mock('../lib/api', () => ({
  listWorkspaceMembers: mocks.listWorkspaceMembers,
  revokeStaff: mocks.revokeStaff,
  BackendError: class extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
}));

vi.mock('./staff-session-provider', () => ({
  useStaffSession: () => ({
    accessToken: 'staff-token',
    workspaces: [{ id: WORKSPACE, slug: 'canadawide', roles: mocks.roles }],
  }),
}));

const members: AssignableMember[] = [
  {
    membershipId: '30000000-0000-4000-8000-000000000001',
    actorId: '20000000-0000-4000-8000-000000000001',
    displayName: 'Takib',
    roles: ['owner'],
    isSelf: true,
  },
  {
    membershipId: '30000000-0000-4000-8000-000000000002',
    actorId: '20000000-0000-4000-8000-000000000002',
    displayName: null,
    roles: ['leads', 'viewer'],
    isSelf: false,
  },
];

describe('TeamList', () => {
  beforeEach(() => {
    mocks.listWorkspaceMembers.mockReset();
    mocks.revokeStaff.mockReset();
    mocks.roles = ['owner'];
    mocks.listWorkspaceMembers.mockResolvedValue({ members, requestId: 'r' });
  });

  it('lists each member by the name they set, or as unnamed, with their roles', async () => {
    render(<TeamList workspaceSlug="canadawide" />);
    const list = await screen.findByRole('list', { name: 'Team' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows[0]?.textContent).toContain('Takib');
    expect(rows[0]?.textContent).toContain('You');
    expect(rows[1]?.textContent).toContain('Unnamed leads');
    expect(rows[1]?.textContent).toContain('Leads, Viewer');
    expect(mocks.listWorkspaceMembers).toHaveBeenCalledWith('staff-token', WORKSPACE);
  });

  it('lets the owner remove someone else, only after confirming', async () => {
    mocks.revokeStaff.mockResolvedValue({ status: 'revoked' });
    render(<TeamList workspaceSlug="canadawide" />);
    expect(screen.queryByRole('button', { name: 'Remove Takib' })).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: 'Remove Unnamed leads' }));
    expect(mocks.revokeStaff).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove access' }));

    await waitFor(() =>
      expect(mocks.revokeStaff).toHaveBeenCalledWith(
        'staff-token',
        WORKSPACE,
        '30000000-0000-4000-8000-000000000002',
      ),
    );
    expect(mocks.revokeStaff).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText('Unnamed leads no longer has access to this site.'),
    ).toBeTruthy();
    expect(
      within(screen.getByRole('list', { name: 'Team' })).getAllByRole('listitem'),
    ).toHaveLength(1);
  });

  it('offers no removal to anyone but the owner', async () => {
    mocks.roles = ['leads'];
    render(<TeamList workspaceSlug="canadawide" />);
    await screen.findByRole('list', { name: 'Team' });
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull();
  });

  it('shows each role as its own chip, with the commas kept for the wide table', async () => {
    render(<TeamList workspaceSlug="canadawide" />);
    const list = await screen.findByRole('list', { name: 'Team' });
    const second = within(list).getAllByRole('listitem')[1] ?? list;
    expect(within(second).getByText('Leads').className).toContain('max-md:rounded-md');
    expect(within(second).getByText('Viewer').className).toContain('max-md:border');
  });

  it('lines the Access header up with its cells', async () => {
    render(<TeamList workspaceSlug="canadawide" />);
    const list = await screen.findByRole('list', { name: 'Team' });
    const header = screen.getByText('Access');
    const columns = (element: Element) =>
      element.className.split(' ').find((name) => name.startsWith('md:grid-cols-'));
    const headerRow = header.parentElement ?? header;
    const row = within(list).getAllByRole('listitem')[1] ?? list;
    // Fixed track widths, so every row and the header share the same columns.
    expect(columns(row)).toBe(columns(headerRow));
    expect(columns(row)).not.toContain('auto');
    expect(header.className).toContain('text-right');
    expect(
      within(row).getByRole('button', { name: 'Remove Unnamed leads' }).parentElement?.className,
    ).toContain('justify-end');
  });

  it('keeps Remove a plain button, not a menu, since it is the only action', async () => {
    render(<TeamList workspaceSlug="canadawide" />);
    await screen.findByRole('list', { name: 'Team' });
    const remove = screen.getByRole('button', { name: 'Remove Unnamed leads' });
    expect(remove.getAttribute('aria-haspopup')).toBeNull();
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
