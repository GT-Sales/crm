import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import { QuickNavigation } from './quick-navigation';

const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const LEAD = '40000000-0000-4000-8000-000000000001';

const mocks = vi.hoisted(() => {
  const accessToken: string | undefined = 'staff-token';
  return { getStaffLeads: vi.fn(), push: vi.fn(), accessToken };
});
vi.mock('../lib/api', () => ({
  getStaffLeads: mocks.getStaffLeads,
  BackendError: class BackendError extends Error {},
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('./staff-session-provider', () => ({
  useStaffSession: () => ({ accessToken: mocks.accessToken }),
}));

const nadia = {
  id: LEAD,
  leadType: 'sim_order',
  stage: 'pending',
  externalRef: 'MS-4',
  contact: { fullName: 'Nadia Khan', email: 'nadia@example.test', phone: null },
};

beforeEach(() => {
  mocks.getStaffLeads.mockReset();
  mocks.push.mockReset();
  mocks.accessToken = 'staff-token';
});

async function openPalette() {
  render(<QuickNavigation workspaceSlug="canadawide" workspaceId={WORKSPACE} />);
  fireEvent.keyDown(window, { ctrlKey: true, key: 'k' });
  const dialog = await screen.findByRole('dialog', { name: 'Search' });
  return { dialog, input: within(dialog).getByRole('textbox', { name: 'Search leads and pages' }) };
}

it('opens from the keyboard and filters page links within the current site', async () => {
  const { dialog, input } = await openPalette();
  fireEvent.change(input, { target: { value: 'se' } });
  expect(within(dialog).getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe(
    '/w/canadawide/settings',
  );
  fireEvent.change(input, { target: { value: 'x' } });
  expect(within(dialog).getByRole('status').textContent).toBe('No matching pages.');
  // One character never searches leads.
  expect(mocks.getStaffLeads).not.toHaveBeenCalled();
});

it('finds leads on this site once typing stops and opens the first with Enter', async () => {
  mocks.getStaffLeads.mockResolvedValue({
    leads: [nadia],
    page: { page: 1, pageSize: 6, total: 9 },
    access: { contacts: true, manage: true },
  });
  const { dialog, input } = await openPalette();
  fireEvent.change(input, { target: { value: ' MS-4 ' } });
  const results = await within(dialog).findByRole('region', { name: 'Lead results' });
  const link = await within(results).findByRole('link', { name: /Nadia Khan/ });
  expect(link.getAttribute('href')).toBe(`/w/canadawide/leads/${LEAD}`);
  expect(link.textContent).toContain('MS-4 · SIM order · Pending');
  expect(mocks.getStaffLeads).toHaveBeenCalledTimes(1);
  expect(mocks.getStaffLeads).toHaveBeenCalledWith('staff-token', WORKSPACE, {
    q: 'MS-4',
    view: 'active',
    pageSize: 6,
  });
  expect(
    within(results).getByRole('link', { name: 'See all 9 matches in Leads' }).getAttribute('href'),
  ).toBe('/w/canadawide/leads?q=MS-4');
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(mocks.push).toHaveBeenCalledWith(`/w/canadawide/leads/${LEAD}`);
});

it('drops a slower earlier answer once a newer search has been typed', async () => {
  let answerFirst: (value: unknown) => void = () => {};
  mocks.getStaffLeads
    .mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve)))
    .mockResolvedValueOnce({
      leads: [],
      page: { page: 1, pageSize: 6, total: 0 },
      access: { contacts: true, manage: true },
    });
  const { dialog, input } = await openPalette();
  fireEvent.change(input, { target: { value: 'na' } });
  await waitFor(() => expect(mocks.getStaffLeads).toHaveBeenCalledTimes(1));
  fireEvent.change(input, { target: { value: 'nobody' } });
  expect(await within(dialog).findByText('No active lead matches.')).toBeTruthy();
  await act(async () => {
    answerFirst({
      leads: [nadia],
      page: { page: 1, pageSize: 6, total: 1 },
      access: { contacts: true, manage: true },
    });
  });
  expect(within(dialog).queryByRole('link', { name: /Nadia Khan/ })).toBeNull();
});

it('explains when the role cannot see customer details, and when the search fails', async () => {
  mocks.getStaffLeads.mockResolvedValueOnce({
    leads: [],
    page: { page: 1, pageSize: 6, total: 0 },
    access: { contacts: false, manage: false },
  });
  const { dialog, input } = await openPalette();
  fireEvent.change(input, { target: { value: 'nadia' } });
  expect(await within(dialog).findByText(/does not show customer details/)).toBeTruthy();
  mocks.getStaffLeads.mockRejectedValueOnce(new Error('offline'));
  fireEvent.change(input, { target: { value: 'nadia k' } });
  expect((await within(dialog).findByRole('alert')).textContent).toContain(
    'Leads could not be searched',
  );
});
