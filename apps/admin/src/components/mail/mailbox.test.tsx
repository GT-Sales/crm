import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mailboxResponseSchema } from '@gt-sales/contracts';

import { BackendError } from '../../lib/api';
import { Mailbox } from './mailbox';

const mocks = vi.hoisted(() => ({
  listMailbox: vi.fn(),
  getStaffLeads: vi.fn(),
  emailLeadCustomer: vi.fn(),
}));
vi.mock('../../lib/api', async (original) => ({
  ...(await original<typeof import('../../lib/api')>()),
  listMailbox: mocks.listMailbox,
  getStaffLeads: mocks.getStaffLeads,
  emailLeadCustomer: mocks.emailLeadCustomer,
}));
const SELF = '20000000-0000-4000-8000-000000000001';
const WORKSPACE = '10000000-0000-4000-8000-000000000001';
vi.mock('../leads/use-lead-workspace', () => ({
  useLeadWorkspace: () => ({
    workspaceId: WORKSPACE,
    accessToken: 'staff-token',
    members: [
      {
        membershipId: '30000000-0000-4000-8000-000000000001',
        actorId: SELF,
        displayName: 'Takib',
        roles: ['owner'],
        isSelf: true,
      },
    ],
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const NOW = '2026-11-13T10:00:00.000Z';
function box(total = 2) {
  return mailboxResponseSchema.parse({
    items: [
      {
        id: '92000000-0000-4000-8000-000000000001',
        createdAt: NOW,
        actorId: SELF,
        subject: 'Your SIM is on its way',
        text: 'Hi Nadia,\nit was mailed today.',
        mailStatus: 'delivered',
        lead: {
          id: '90000000-0000-4000-8000-000000000001',
          leadType: 'sim_order',
          name: 'Nadia Khan',
        },
      },
      {
        id: '92000000-0000-4000-8000-000000000002',
        createdAt: NOW,
        actorId: SELF,
        automation: 'order_received',
        automationName: 'Order received email',
        template: 'order_received',
        lead: {
          id: '90000000-0000-4000-8000-000000000002',
          leadType: 'sim_order',
          name: 'Marco Rossi',
        },
      },
    ],
    page: { page: 1, pageSize: 50, total },
    requestId: '70000000-0000-4000-8000-000000000001',
  });
}

describe('Mailbox', () => {
  it('lists the site’s sent mail and opens the first one beside the list', async () => {
    mocks.listMailbox.mockResolvedValue(box());
    render(<Mailbox workspaceSlug="getcanadasim" />);

    const list = await screen.findByRole('list', { name: 'Sent emails' });
    expect(mocks.listMailbox).toHaveBeenCalledWith('staff-token', WORKSPACE, { page: 1 });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Nadia Khan');
    expect(rows[0]?.textContent).toContain('Delivered');
    expect(rows[1]?.textContent).toContain('Order received email');

    // The newest mail is open, with its words and a way to its lead.
    const reading = screen.getByLabelText('Email');
    expect(reading.textContent).toContain('it was mailed today.');
    expect(
      within(reading)
        .getByRole('link', { name: /Open lead/ })
        .getAttribute('href'),
    ).toBe('/w/getcanadasim/leads/90000000-0000-4000-8000-000000000001');

    // Choosing an older mail whose words were not kept says so.
    const second = rows[1];
    if (!second) throw new Error('expected a second mail');
    fireEvent.click(within(second).getByRole('button'));
    expect(screen.getByLabelText('Email').textContent).toContain('were not kept');
    expect(screen.getByLabelText('Email').textContent).toContain(
      'Automation: Order received email',
    );
  });

  it('says so when nothing was sent, and when the role cannot read mail', async () => {
    mocks.listMailbox.mockResolvedValueOnce({ ...box(0), items: [] });
    const first = render(<Mailbox workspaceSlug="getcanadasim" />);
    expect(await screen.findByText('No emails have been sent to customers yet.')).toBeTruthy();
    first.unmount();

    mocks.listMailbox.mockRejectedValueOnce(new BackendError('permission_denied', 403, NOW));
    render(<Mailbox workspaceSlug="getcanadasim" />);
    expect((await screen.findByRole('alert')).textContent).toContain(
      "Your role doesn't show customer emails",
    );
  });

  it('writes to a customer found by search, then shows the new mail', async () => {
    mocks.listMailbox.mockResolvedValue(box());
    mocks.getStaffLeads.mockResolvedValue({
      leads: [
        {
          id: '90000000-0000-4000-8000-000000000003',
          contact: { fullName: 'Priya Sharma', email: 'priya@example.test', phone: null },
        },
      ],
    });
    mocks.emailLeadCustomer.mockResolvedValue({
      activity: { id: '92000000-0000-4000-8000-000000000009' },
    });
    render(<Mailbox workspaceSlug="getcanadasim" />);
    await screen.findByRole('list', { name: 'Sent emails' });

    fireEvent.click(screen.getByRole('button', { name: 'New email' }));
    const form = screen.getByLabelText('New email');
    const send = within(form).getByRole('button', { name: 'Send email' });
    fireEvent.change(within(form).getByLabelText('Subject'), { target: { value: 'Hello' } });
    fireEvent.change(within(form).getByLabelText('Message'), { target: { value: 'All set.' } });
    // No customer chosen yet.
    expect(send).toHaveProperty('disabled', true);

    fireEvent.change(within(form).getByLabelText('To'), { target: { value: 'priya' } });
    const found = await within(form).findByRole('list', { name: 'Customers found' });
    expect(mocks.getStaffLeads).toHaveBeenCalledWith('staff-token', WORKSPACE, {
      q: 'priya',
      view: 'active',
      pageSize: 6,
    });
    fireEvent.click(within(found).getByRole('button', { name: /Priya Sharma/ }));
    expect(form.textContent).toContain('priya@example.test');

    fireEvent.click(send);
    await waitFor(() => expect(screen.queryByLabelText('New email')).toBeNull());
    expect(mocks.emailLeadCustomer).toHaveBeenCalledWith(
      'staff-token',
      WORKSPACE,
      '90000000-0000-4000-8000-000000000003',
      { subject: 'Hello', body: 'All set.' },
    );
    // The list is read again so the new mail shows.
    expect(mocks.listMailbox).toHaveBeenCalledTimes(2);
  });

  it('writes again to the customer of the open mail', async () => {
    mocks.listMailbox.mockResolvedValue(box());
    render(<Mailbox workspaceSlug="getcanadasim" />);
    await screen.findByRole('list', { name: 'Sent emails' });
    fireEvent.click(screen.getByRole('button', { name: 'Write to this customer' }));
    expect(screen.getByLabelText('New email').textContent).toContain('Nadia Khan');
    expect(mocks.getStaffLeads).not.toHaveBeenCalled();
  });
});
