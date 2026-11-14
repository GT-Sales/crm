import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mailboxResponseSchema } from '@gt-sales/contracts';

import { BackendError } from '../../lib/api';
import { Mailbox } from './mailbox';

const mocks = vi.hoisted(() => ({
  listMailbox: vi.fn(),
  getStaffLeads: vi.fn(),
  emailLeadCustomer: vi.fn(),
  replace: vi.fn(),
  // An empty text stands for no `?lead=`.
  lead: { current: '' },
  assistant: { open: vi.fn(), send: vi.fn(), available: true },
}));
vi.mock('../../lib/api', async (original) => ({
  ...(await original<typeof import('../../lib/api')>()),
  listMailbox: mocks.listMailbox,
  getStaffLeads: mocks.getStaffLeads,
  emailLeadCustomer: mocks.emailLeadCustomer,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace }),
  usePathname: () => '/w/getcanadasim/mail',
  useSearchParams: () => ({
    get: (name: string) => (name === 'lead' && mocks.lead.current ? mocks.lead.current : null),
  }),
}));
vi.mock('../ai/assistant-provider', () => ({
  useOptionalAssistant: () => ({
    capabilities: { status: 'ready', data: { available: mocks.assistant.available } },
    open: mocks.assistant.open,
    send: mocks.assistant.send,
  }),
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
  mocks.lead.current = '';
  mocks.assistant.available = true;
});

const NOW = '2026-11-13T10:00:00.000Z';
const NADIA = '90000000-0000-4000-8000-000000000001';
const MARCO = '90000000-0000-4000-8000-000000000002';
const nadia = { id: NADIA, leadType: 'sim_order', name: 'Nadia Khan' };
const page = (items: unknown[], total = items.length) =>
  mailboxResponseSchema.parse({
    items,
    page: { page: 1, pageSize: 50, total },
    requestId: '70000000-0000-4000-8000-000000000001',
  });
const people = () =>
  page([
    {
      id: '92000000-0000-4000-8000-000000000001',
      createdAt: NOW,
      actorId: SELF,
      subject: 'Your SIM is on its way',
      text: 'Hi Nadia,\nit was mailed today.',
      mailStatus: 'delivered',
      mails: 2,
      lead: nadia,
    },
    {
      id: '92000000-0000-4000-8000-000000000002',
      createdAt: NOW,
      actorId: SELF,
      automation: 'order_received',
      automationName: 'Order received email',
      template: 'order_received',
      mails: 1,
      lead: { id: MARCO, leadType: 'sim_order', name: 'Marco Rossi' },
    },
  ]);
/** Nadia's conversation as the backend sends it: newest first. */
const thread = () =>
  page([
    {
      id: '92000000-0000-4000-8000-000000000001',
      createdAt: NOW,
      actorId: SELF,
      subject: 'Your SIM is on its way',
      text: 'Hi Nadia,\nit was mailed today.',
      mailStatus: 'delivered',
      lead: nadia,
    },
    {
      id: '92000000-0000-4000-8000-000000000003',
      createdAt: '2026-11-10T10:00:00.000Z',
      actorId: SELF,
      automation: 'order_received',
      automationName: 'Order received email',
      template: 'order_received',
      lead: nadia,
    },
  ]);
const answer = () =>
  mocks.listMailbox.mockImplementation(async (_token, _site, query: { leadId?: string }) =>
    query.leadId ? thread() : people(),
  );

describe('Mailbox', () => {
  it('lists each customer once and opens one from the list', async () => {
    answer();
    render(<Mailbox workspaceSlug="getcanadasim" />);

    const list = await screen.findByRole('list', { name: 'Customers written to' });
    expect(mocks.listMailbox).toHaveBeenCalledWith('staff-token', WORKSPACE, { page: 1 });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Nadia Khan');
    expect(rows[0]?.textContent).toContain('Your SIM is on its way');
    expect(within(list).getByTitle('2 emails')).toBeTruthy();
    expect(rows[1]?.textContent).toContain('Order received email');
    // Nothing is open until a customer is chosen.
    expect(screen.queryByRole('form', { name: 'New email' })).toBeNull();

    const first = rows[0];
    if (!first) throw new Error('expected a customer');
    fireEvent.click(within(first).getByRole('button'));
    expect(mocks.replace).toHaveBeenCalledWith(`/w/getcanadasim/mail?lead=${NADIA}`, {
      scroll: false,
    });
  });

  it('shows the chosen customer’s emails oldest first, with the writing box under them', async () => {
    mocks.lead.current = NADIA;
    answer();
    mocks.emailLeadCustomer.mockResolvedValue({ activity: { id: 'x' } });
    render(<Mailbox workspaceSlug="getcanadasim" />);

    const conversation = await screen.findByRole('region', { name: 'Emails to Nadia Khan' });
    const mails = await within(conversation).findAllByRole('listitem');
    expect(mocks.listMailbox).toHaveBeenCalledWith('staff-token', WORKSPACE, { leadId: NADIA });
    expect(mails).toHaveLength(2);
    expect(mails[0]?.textContent).toContain('Order received email');
    expect(mails[0]?.textContent).toContain('were not kept');
    expect(mails[1]?.textContent).toContain('it was mailed today.');
    expect(mails[1]?.textContent).toContain('Delivered');
    expect(
      within(conversation)
        .getByRole('link', { name: /Open lead/ })
        .getAttribute('href'),
    ).toBe(`/w/getcanadasim/leads/${NADIA}`);

    const form = within(conversation).getByRole('form', { name: 'New email' });
    const send = within(form).getByRole('button', { name: 'Send' });
    expect(send).toHaveProperty('disabled', true);
    fireEvent.change(within(form).getByLabelText('Subject'), { target: { value: ' Hello ' } });
    fireEvent.change(within(form).getByLabelText('Message'), { target: { value: 'All set.' } });
    const before = mocks.listMailbox.mock.calls.length;
    fireEvent.click(send);
    await waitFor(() =>
      expect(mocks.emailLeadCustomer).toHaveBeenCalledWith('staff-token', WORKSPACE, NADIA, {
        subject: 'Hello',
        body: 'All set.',
      }),
    );
    // The box empties and both the conversation and the list are read again.
    await waitFor(() => expect(within(form).getByLabelText('Message')).toHaveProperty('value', ''));
    await waitFor(() => expect(mocks.listMailbox.mock.calls.length).toBeGreaterThan(before + 1));
  });

  it('hands a brief to Ask AI, which drafts the email for this customer', async () => {
    mocks.lead.current = NADIA;
    answer();
    render(<Mailbox workspaceSlug="getcanadasim" />);
    const conversation = await screen.findByRole('region', { name: 'Emails to Nadia Khan' });

    fireEvent.click(within(conversation).getByRole('button', { name: 'Write with AI' }));
    const ask = within(conversation).getByRole('form', { name: 'Write with AI' });
    fireEvent.change(within(ask).getByLabelText('What should the email say?'), {
      target: { value: 'Say the SIM ships tomorrow.' },
    });
    fireEvent.click(within(ask).getByRole('button', { name: 'Write the draft' }));

    expect(mocks.assistant.open).toHaveBeenCalled();
    expect(mocks.assistant.send).toHaveBeenCalledWith(
      'Write an email to this customer (Nadia Khan). Say the SIM ships tomorrow.',
    );
    // Nothing was sent by the page itself.
    expect(mocks.emailLeadCustomer).not.toHaveBeenCalled();
  });

  it('offers no AI button where Ask AI is not available', async () => {
    mocks.lead.current = NADIA;
    mocks.assistant.available = false;
    answer();
    render(<Mailbox workspaceSlug="getcanadasim" />);
    await screen.findByRole('region', { name: 'Emails to Nadia Khan' });
    expect(screen.queryByRole('button', { name: 'Write with AI' })).toBeNull();
  });

  it('finds a customer to write to with New email', async () => {
    answer();
    mocks.getStaffLeads.mockResolvedValue({
      leads: [
        {
          id: '90000000-0000-4000-8000-000000000003',
          leadType: 'sim_order',
          contact: { fullName: 'Priya Sharma', email: 'priya@example.test', phone: null },
        },
      ],
    });
    render(<Mailbox workspaceSlug="getcanadasim" />);
    await screen.findByRole('list', { name: 'Customers written to' });

    fireEvent.click(screen.getByRole('button', { name: 'New email' }));
    fireEvent.change(screen.getByLabelText('Write to'), { target: { value: 'priya' } });
    const found = await screen.findByRole('list', { name: 'Customers found' });
    expect(mocks.getStaffLeads).toHaveBeenCalledWith('staff-token', WORKSPACE, {
      q: 'priya',
      view: 'active',
      pageSize: 6,
    });
    fireEvent.click(within(found).getByRole('button', { name: /Priya Sharma/ }));
    expect(mocks.replace).toHaveBeenCalledWith(
      '/w/getcanadasim/mail?lead=90000000-0000-4000-8000-000000000003',
      { scroll: false },
    );
  });

  it('says so when nothing was sent, and when the role cannot read mail', async () => {
    mocks.listMailbox.mockResolvedValueOnce(page([]));
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
