import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { leadActivitySchema, type AssignableMember } from '@gt-sales/contracts';

import { LeadMail } from './lead-mail';

afterEach(cleanup);

const SELF = '20000000-0000-4000-8000-000000000001';
const members: AssignableMember[] = [
  {
    membershipId: '30000000-0000-4000-8000-000000000001',
    actorId: SELF,
    displayName: 'Takib',
    roles: ['owner'],
    isSelf: true,
  },
];

function mail(n: number, extra: Record<string, unknown> = {}) {
  return leadActivitySchema.parse({
    id: `92000000-0000-4000-8000-00000000000${n}`,
    actorId: SELF,
    createdAt: `2026-11-0${n}T10:00:00.000Z`,
    kind: 'system',
    event: 'customer_emailed',
    ...extra,
  });
}

const note = leadActivitySchema.parse({
  id: '92000000-0000-4000-8000-0000000000aa',
  actorId: SELF,
  createdAt: '2026-11-09T10:00:00.000Z',
  kind: 'note',
  body: 'Called, no answer.',
});

describe('LeadMail', () => {
  it('lists only the mails, with what was written and how the send went', () => {
    render(
      <LeadMail
        activities={[
          note,
          mail(3, {
            subject: 'About your order',
            text: 'Hello,\nyour SIM ships tomorrow.',
            mailStatus: 'delivered',
          }),
          mail(2, {
            template: 'order_received',
            templateVersion: 1,
            automation: 'order_received',
            automationName: 'Order received email',
            subject: 'We got your order',
            text: 'Thanks.',
            mailStatus: 'bounced',
          }),
          // Sent before the Mail tab kept the words.
          mail(1, { template: 'sim_number_ready', templateVersion: 0 }),
        ]}
        members={members}
        customerEmail="nadia@example.test"
        canSend={false}
        onSend={vi.fn()}
      />,
    );

    const rows = within(screen.getByRole('list', { name: 'Emails sent' })).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    const row = (index: number) => {
      const found = rows[index];
      if (!found) throw new Error(`no mail row ${index}`);
      return found;
    };
    expect(rows[0]?.textContent).toContain('About your order');
    expect(rows[0]?.textContent).toContain('Delivered');
    expect(rows[1]?.textContent).toContain('Automation: Order received email');
    expect(rows[1]?.textContent).toContain('Bounced');
    expect(rows[2]?.textContent).toContain('SIM number ready email');
    expect(screen.queryByText('Called, no answer.')).toBeNull();
    // No form for someone who cannot send.
    expect(screen.queryByRole('button', { name: 'New email' })).toBeNull();

    // Opening a mail shows its words; an old one says they were not kept.
    fireEvent.click(within(row(0)).getByRole('button'));
    expect(rows[0]?.textContent).toContain('your SIM ships tomorrow.');
    fireEvent.click(within(row(2)).getByRole('button'));
    expect(rows[2]?.textContent).toContain('were not kept');
  });

  it('sends a written message and keeps the words when it fails', async () => {
    const onSend = vi
      .fn<(mail: { subject: string; body: string }) => Promise<void>>()
      .mockRejectedValueOnce(new Error('The customer has no usable email address.'))
      .mockResolvedValueOnce();
    render(
      <LeadMail
        activities={[]}
        members={members}
        customerEmail="nadia@example.test"
        canSend
        onSend={onSend}
      />,
    );
    expect(screen.getByText('No emails have been sent to this customer yet.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'New email' }));
    const form = screen.getByRole('form', { name: 'New email' });
    expect(form.textContent).toContain('nadia@example.test');
    const send = within(form).getByRole('button', { name: 'Send email' });
    expect(send).toHaveProperty('disabled', true);

    fireEvent.change(within(form).getByLabelText('Subject'), { target: { value: ' Hello ' } });
    fireEvent.change(within(form).getByLabelText('Message'), { target: { value: 'All set.' } });
    fireEvent.click(send);
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('no usable email address'),
    );
    expect(onSend).toHaveBeenCalledWith({ subject: 'Hello', body: 'All set.' });
    // Still there to try again.
    expect(within(form).getByLabelText('Message')).toHaveProperty('value', 'All set.');

    fireEvent.click(within(form).getByRole('button', { name: 'Send email' }));
    await waitFor(() => expect(screen.queryByRole('form', { name: 'New email' })).toBeNull());
    expect(onSend).toHaveBeenCalledTimes(2);
  });

  it('shows the customer’s reply among the mails, and says where replies go', () => {
    const reply = leadActivitySchema.parse({
      id: '92000000-0000-4000-8000-000000000008',
      actorId: '00000000-0000-4000-8000-00000000a002',
      createdAt: '2026-11-08T10:00:00.000Z',
      kind: 'system',
      event: 'customer_replied',
      subject: 'Re: About your order',
      text: 'Thanks, that works.',
    });
    const view = render(
      <LeadMail
        activities={[reply, mail(3, { subject: 'About your order', text: 'Hello.' })]}
        members={members}
        customerEmail="nadia@example.test"
        canSend={false}
        repliesEnabled
        onSend={vi.fn()}
      />,
    );
    const rows = within(screen.getByRole('list', { name: 'Emails sent' })).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Re: About your order');
    expect(rows[0]?.textContent).toContain('The customer replied');
    expect(screen.getByText(/the reply appears here/)).toBeTruthy();
    view.unmount();

    render(
      <LeadMail
        activities={[]}
        members={members}
        customerEmail="nadia@example.test"
        canSend={false}
        onSend={vi.fn()}
      />,
    );
    expect(screen.getByText(/reply-to mailbox, not here/)).toBeTruthy();
  });

  it('says why nobody can write from here', () => {
    render(
      <LeadMail
        activities={[]}
        members={members}
        customerEmail={undefined}
        canSend={false}
        cannotSendReason="This customer has no email address. Add one to write to them."
        onSend={vi.fn()}
      />,
    );
    expect(screen.getByText(/has no email address/)).toBeTruthy();
  });
});
