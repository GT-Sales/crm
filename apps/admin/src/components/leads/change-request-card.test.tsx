import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BackendError,
  DEFAULT_LEAD_ORDER,
  buildPropertyCatalog,
  formatPropertyValue,
  type LeadDetail,
  type ResolveChangeRequestResponse,
  type StaffChangeRequest,
} from '@gt-sales/contracts';

import { ChangeRequestCard } from './change-request-card';

const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const LEAD = '90000000-0000-4000-8000-000000000001';
const REQUEST = 'c0000000-0000-4000-8000-000000000001';
const PLAN_NOW = 'a0000000-0000-4000-8000-000000000001';
const PLAN_NEXT = 'a0000000-0000-4000-8000-000000000002';
const PASSPORT_FILE = 'f0000000-0000-4000-8000-000000000001';
const VISA_FILE = 'f0000000-0000-4000-8000-000000000002';
const NOW = '2026-10-30T12:00:00.000Z';

const lead: LeadDetail = {
  id: LEAD,
  workspaceId: WORKSPACE,
  leadType: 'sim_order',
  status: 'submitted',
  stage: 'pending',
  contact: { fullName: 'Nadia Khan', email: 'nadia@example.test', phone: '403 555 0101' },
  contactId: null,
  assignedActorId: null,
  externalRef: 'MS-70',
  source: 'direct',
  attribution: {},
  consentVersion: null,
  openTaskCount: 0,
  nextTaskDueAt: null,
  deletedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  form: {
    schemaVersion: 1,
    payload: {
      delivery: 'esim',
      arrivalDate: '2026-11-01',
      permitType: 'student',
      flightBooked: false,
      canadaAddress: '12 Example Street',
    },
  },
  order: {
    ...DEFAULT_LEAD_ORDER,
    planId: PLAN_NOW,
    plan: {
      planId: PLAN_NOW,
      name: 'Unlimited Data',
      priceMinor: 4000,
      currency: 'CAD',
      billingPeriod: 'month',
      paymentRequired: false,
      requiredDocuments: [],
      properties: {},
      frozenAt: NOW,
    },
  },
};

const catalog = buildPropertyCatalog([], 'lead', {
  plans: [
    { id: PLAN_NOW, name: 'Unlimited Data', active: true, leadType: 'sim_order' },
    { id: PLAN_NEXT, name: 'Student 20 GB', active: true, leadType: 'sim_order' },
  ],
});

function changeRequest(overrides: Partial<StaffChangeRequest> = {}): StaffChangeRequest {
  return {
    id: REQUEST,
    requestNo: 70,
    status: 'pending',
    fields: { phone: '+1 403 555 0199', arrivalDate: '2026-11-09' },
    documents: [],
    version: 2,
    createdAt: '2026-10-30T10:00:00.000Z',
    updatedAt: '2026-10-30T11:55:00.000Z',
    ...overrides,
  };
}

const decided = {
  lead,
  activities: [],
  allowedMoves: [],
  requestId: '00000000-0000-4000-8000-000000000001',
} satisfies ResolveChangeRequestResponse;

function mount(
  props: {
    lead?: LeadDetail;
    changeRequest?: StaffChangeRequest;
    canDecide?: boolean;
    canDownload?: boolean;
    onDecide?: (...args: ['approve' | 'reject', number]) => Promise<ResolveChangeRequestResponse>;
    onReload?: () => void;
  } = {},
) {
  const onDecide = vi.fn(props.onDecide ?? (() => Promise.resolve(decided)));
  const onDone = vi.fn();
  const openDocument = vi.fn(() => Promise.resolve());
  render(
    <ChangeRequestCard
      lead={props.lead ?? lead}
      changeRequest={props.changeRequest ?? changeRequest()}
      catalog={catalog}
      canDecide={props.canDecide ?? true}
      canDownload={props.canDownload ?? true}
      onDecide={onDecide}
      onDone={onDone}
      openDocument={openDocument}
      {...(props.onReload ? { onReload: props.onReload } : {})}
    />,
  );
  return { onDecide, onDone, openDocument };
}

function row(field: string) {
  const header = screen.getByRole('rowheader', { name: field });
  const tableRow = header.closest('tr');
  if (!tableRow) throw new Error(`no row ${field}`);
  return tableRow;
}

describe('ChangeRequestCard', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('names the request and lists each field with what it is now and what was asked for', () => {
    mount();
    expect(screen.getByRole('heading', { name: 'Change request #70' })).toBeTruthy();
    expect(screen.getByText(/The customer asked for these changes/)).toBeTruthy();
    const columns = screen.getAllByRole('columnheader').map((header) => header.textContent);
    expect(columns).toEqual(['Field', 'Now', 'Asked for']);
    const phone = row('Phone');
    expect(within(phone).getByText('403 555 0101')).toBeTruthy();
    expect(within(phone).getByText('+1 403 555 0199')).toBeTruthy();
    // Dates read as dates, not as stored.
    const arrival = row('Arrival in Canada');
    const now = formatPropertyValue({ kind: 'date' }, '2026-11-01');
    const asked = formatPropertyValue({ kind: 'date' }, '2026-11-09');
    expect(within(arrival).getByText(now)).toBeTruthy();
    expect(within(arrival).getByText(asked)).toBeTruthy();
    expect(within(arrival).queryByText('2026-11-09')).toBeNull();
    // Only the fields asked about are listed.
    expect(screen.queryByRole('rowheader', { name: 'SIM type' })).toBeNull();
  });

  it('reads the plan by name, delivery by its option label and yes/no answers as words', () => {
    mount({
      changeRequest: changeRequest({
        fields: { planId: PLAN_NEXT, delivery: 'pickup', flightBooked: true, fullName: 'Nadia K' },
      }),
    });
    const plan = row('Plan');
    expect(within(plan).getByText('Unlimited Data')).toBeTruthy();
    expect(within(plan).getByText('Student 20 GB')).toBeTruthy();
    const delivery = row('SIM type');
    expect(within(delivery).getByText('eSIM')).toBeTruthy();
    expect(within(delivery).getByText('Physical SIM (mailed)')).toBeTruthy();
    const flight = row('Flight booked');
    expect(within(flight).getByText('No')).toBeTruthy();
    expect(within(flight).getByText('Yes')).toBeTruthy();
    const name = row('Name');
    expect(within(name).getByText('Nadia Khan')).toBeTruthy();
    expect(within(name).getByText('Nadia K')).toBeTruthy();
  });

  it('shows an address asked to be cleared, and an answer that is not there yet', () => {
    mount({
      changeRequest: changeRequest({
        fields: { canadaAddress: null, shippingAddress: '9 New Road, Calgary' },
      }),
    });
    expect(within(row('Address in Canada / City')).getByText('Cleared')).toBeTruthy();
    expect(within(row('Shipping address')).getByText('—')).toBeTruthy();
    expect(within(row('Shipping address')).getByText('9 New Road, Calgary')).toBeTruthy();
  });

  it('lists the documents sent with it, and opens one only for staff who may download', () => {
    const { openDocument } = mount({
      changeRequest: changeRequest({
        fields: {},
        documents: [
          { fileId: PASSPORT_FILE, documentType: 'passport' },
          { fileId: VISA_FILE, documentType: 'visa' },
        ],
      }),
    });
    expect(screen.getByText('Documents sent with it:')).toBeTruthy();
    const passport = screen.getByRole('listitem', { name: 'Passport' });
    fireEvent.click(within(passport).getByRole('button', { name: 'View Passport' }));
    expect(openDocument).toHaveBeenCalledWith(PASSPORT_FILE);
    expect(screen.getByRole('button', { name: 'View Visa or approval letter' })).toBeTruthy();
  });

  it('offers no View without the download permission, but still names the documents', () => {
    const { openDocument } = mount({
      canDownload: false,
      changeRequest: changeRequest({
        documents: [{ fileId: PASSPORT_FILE, documentType: 'passport' }],
      }),
    });
    expect(screen.getByRole('listitem', { name: 'Passport' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^View/ })).toBeNull();
    expect(openDocument).not.toHaveBeenCalled();
  });

  it('says why a document could not be opened', async () => {
    const openDocument = vi.fn(() => Promise.reject(new Error('This document is not available.')));
    render(
      <ChangeRequestCard
        lead={lead}
        changeRequest={changeRequest({
          documents: [{ fileId: PASSPORT_FILE, documentType: 'passport' }],
        })}
        catalog={catalog}
        canDecide
        canDownload
        onDecide={vi.fn()}
        onDone={vi.fn()}
        openDocument={openDocument}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'View Passport' }));
    expect((await screen.findByRole('alert')).textContent).toBe('This document is not available.');
  });

  it('approves with the version it was loaded at, then says what happens next', async () => {
    const { onDecide, onDone } = mount({
      changeRequest: changeRequest({
        documents: [{ fileId: PASSPORT_FILE, documentType: 'passport' }],
      }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve changes' }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith('approve', 2));
    expect((await screen.findByRole('status')).textContent).toContain(
      'Approved. The documents now wait for an Orders review.',
    );
    expect(onDone).toHaveBeenCalledWith(decided);
    expect(screen.queryByRole('button', { name: 'Approve changes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  });

  it('says when the customer asked: how long ago this week, on which day before that', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    const { unmount } = render(
      <ChangeRequestCard
        lead={lead}
        changeRequest={changeRequest({ updatedAt: '2026-10-30T11:55:00.000Z' })}
        catalog={catalog}
        canDecide
        canDownload
        onDecide={() => Promise.resolve(decided)}
        onDone={() => undefined}
        openDocument={() => Promise.resolve()}
      />,
    );
    expect(screen.getByText(/The customer asked for these changes/).textContent).toBe(
      'The customer asked for these changes 5m ago.',
    );
    unmount();
    mount({ changeRequest: changeRequest({ updatedAt: '2026-10-12T12:00:00.000Z' }) });
    expect(screen.getByText(/The customer asked for these changes/).textContent).toBe(
      'The customer asked for these changes on Oct 12.',
    );
  });

  it('moves focus to the outcome once the decision is saved', async () => {
    mount();
    const approve = screen.getByRole('button', { name: 'Approve changes' });
    approve.focus();
    fireEvent.click(approve);
    const status = await screen.findByRole('status');
    await waitFor(() => expect(document.activeElement).toBe(status));
    expect(status.getAttribute('tabindex')).toBe('-1');
  });

  it('says only "Approved." when no document came with the request', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Approve changes' }));
    const status = await screen.findByRole('status');
    expect(status.textContent).toBe('Approved.');
  });

  it('rejects with the version it was loaded at and says the customer is told by email', async () => {
    const { onDecide, onDone } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith('reject', 2));
    expect((await screen.findByRole('status')).textContent).toBe(
      'Rejected. The customer will be told by email.',
    );
    expect(onDone).toHaveBeenCalledWith(decided);
  });

  it('sends one decision however often the button is pressed', async () => {
    let finish: (value: ResolveChangeRequestResponse) => void = () => undefined;
    const { onDecide } = mount({
      onDecide: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const approve = screen.getByRole('button', { name: 'Approve changes' });
    fireEvent.click(approve);
    fireEvent.click(approve);
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Reject' })).toHaveProperty('disabled', true);
    finish(decided);
    await screen.findByRole('status');
  });

  it('says the customer changed the request on version_conflict and offers a reload', async () => {
    const onReload = vi.fn();
    const { onDone } = mount({
      onReload,
      onDecide: () => Promise.reject(new BackendError('version_conflict', 409, 'req-1')),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve changes' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'The customer changed this request. Reload to see the latest.',
    );
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(onReload).toHaveBeenCalledOnce();
    // The decision can be taken again once the request is reloaded.
    expect(screen.getByRole('button', { name: 'Approve changes' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('names any other refusal by its reason', async () => {
    mount({
      onDecide: () => Promise.reject(new BackendError('change_request_resolved', 409, 'req-2')),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Someone already decided this request. Reload to see the latest.',
    );
  });

  it('shows the generic reason for a failure it has no words for', async () => {
    mount({ onDecide: () => Promise.reject(new BackendError('internal_error', 500, 'req-3')) });
    fireEvent.click(screen.getByRole('button', { name: 'Approve changes' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The decision was not saved. Reason: internal_error.',
    );
  });

  it('shows no buttons without the right to decide, and says who can', () => {
    const { onDecide } = mount({ canDecide: false });
    expect(screen.queryByRole('button', { name: 'Approve changes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    expect(screen.getByText('Only someone with the Leads role can decide this.')).toBeTruthy();
    expect(onDecide).not.toHaveBeenCalled();
    // The request itself is still readable.
    expect(within(row('Phone')).getByText('+1 403 555 0199')).toBeTruthy();
  });

  it('asks to restore an archived lead first, rather than for the Leads role', () => {
    const { onDecide } = mount({ lead: { ...lead, deletedAt: NOW } });
    expect(screen.queryByRole('button', { name: 'Approve changes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    expect(screen.getByText('Restore this lead to decide this request.')).toBeTruthy();
    expect(screen.queryByText(/Leads role/)).toBeNull();
    expect(onDecide).not.toHaveBeenCalled();
  });

  describe('a decision whose email was not sent', () => {
    it('says the site has no sender', async () => {
      mount({
        onDecide: () =>
          Promise.resolve({
            ...decided,
            emailSkipped: { template: 'change_approved', reason: 'no_sender' },
          }),
      });
      fireEvent.click(screen.getByRole('button', { name: 'Approve changes' }));
      expect((await screen.findByRole('alert')).textContent).toBe(
        'The Change approved email was not sent: this site has no sender yet (Settings → Email).',
      );
    });

    it('says the customer has no address, and does not promise an email on a rejection', async () => {
      mount({
        onDecide: () =>
          Promise.resolve({
            ...decided,
            emailSkipped: { template: 'change_rejected', reason: 'no_customer_email' },
          }),
      });
      fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
      expect((await screen.findByRole('alert')).textContent).toBe(
        'The Change rejected email was not sent: the customer has no email address.',
      );
      expect(screen.getByRole('status').textContent).toBe('Rejected.');
    });

    it('lists what the email still needs', async () => {
      mount({
        onDecide: () =>
          Promise.resolve({
            ...decided,
            emailSkipped: {
              template: 'change_approved',
              reason: 'missing_fill_in',
              missing: ['first name', 'tracking link'],
            },
          }),
      });
      fireEvent.click(screen.getByRole('button', { name: 'Approve changes' }));
      expect((await screen.findByRole('alert')).textContent).toBe(
        'The Change approved email was not sent: it needs the first name and tracking link.',
      );
    });
  });
});
