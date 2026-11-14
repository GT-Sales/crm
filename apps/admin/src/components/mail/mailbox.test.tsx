import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mailboxResponseSchema } from '@gt-sales/contracts';

import { BackendError } from '../../lib/api';
import { Mailbox } from './mailbox';

const mocks = vi.hoisted(() => ({ listMailbox: vi.fn() }));
vi.mock('../../lib/api', async (original) => ({
  ...(await original<typeof import('../../lib/api')>()),
  listMailbox: mocks.listMailbox,
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
});
