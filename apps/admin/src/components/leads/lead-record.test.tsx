import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AssignableMember,
  GetWorkspaceLeadResponse,
  LeadIdentity,
  LeadActivity,
  LeadDetail,
} from '@gt-sales/contracts';

import { downloadNavigation, REVEAL_SECONDS } from './identity-check';
import { LeadRecord } from './lead-record';

const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const LEAD = '90000000-0000-4000-8000-000000000001';
const SELF = '20000000-0000-4000-8000-000000000001';
const COLLEAGUE = '20000000-0000-4000-8000-000000000002';
const NOW = '2026-10-26T12:00:00.000Z';

const mocks = vi.hoisted(() => ({
  getStaffLead: vi.fn(),
  updateStaffLead: vi.fn(),
  setLeadTrashed: vi.fn(),
  addLeadNote: vi.fn(),
  createLeadTask: vi.fn(),
  updateLeadTask: vi.fn(),
  listWorkspaceMembers: vi.fn(),
  revealLeadIdentity: vi.fn(),
  createFileDownloadLink: vi.fn(),
  markLeadOpened: vi.fn(),
  emailLeadCustomer: vi.fn(),
}));

vi.mock('../../lib/api', () => ({
  ...mocks,
  BackendError: class extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
}));

vi.mock('../staff-session-provider', () => ({
  useStaffSession: () => ({
    accessToken: 'staff-token',
    workspaces: [{ id: WORKSPACE, slug: 'canadawide', roles: ['owner'] }],
  }),
}));

const members: AssignableMember[] = [
  {
    membershipId: '30000000-0000-4000-8000-000000000001',
    actorId: SELF,
    displayName: 'Takib',
    roles: ['owner'],
    isSelf: true,
  },
  {
    membershipId: '30000000-0000-4000-8000-000000000002',
    actorId: COLLEAGUE,
    displayName: 'Sam',
    roles: ['leads'],
    isSelf: false,
  },
];

const lead: LeadDetail = {
  id: LEAD,
  workspaceId: WORKSPACE,
  leadType: 'internet',
  status: 'submitted',
  stage: 'new',
  contact: { fullName: 'Avery Example', email: 'avery@example.test', phone: '403 555 0101' },
  contactId: null,
  assignedActorId: null,
  externalRef: null,
  source: 'utm:google/cpc',
  attribution: { utmSource: 'google', utmMedium: 'cpc' },
  consentVersion: 'cw-internet-contact-2026-10',
  openTaskCount: 0,
  nextTaskDueAt: null,
  deletedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  form: {
    schemaVersion: 1,
    payload: { planLabel: '1Gbps', streetAddress: '12 Example Street', city: 'Calgary' },
  },
};

function response(overrides: Partial<GetWorkspaceLeadResponse> = {}): GetWorkspaceLeadResponse {
  return {
    lead,
    activities: [],
    tasks: [],
    related: [],
    identities: [],
    access: { contacts: true, manage: true },
    requestId: '00000000-0000-4000-8000-000000000001',
    ...overrides,
  };
}

describe('LeadRecord', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.listWorkspaceMembers.mockResolvedValue({ members, requestId: NOW });
    mocks.getStaffLead.mockResolvedValue(response());
  });

  it('shows the contact, the request and the source', async () => {
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Avery Example' })).toBeTruthy();
    expect(screen.getByText('avery@example.test')).toBeTruthy();
    expect(screen.getByText('12 Example Street')).toBeTruthy();
    expect(screen.getByText('utm:google/cpc')).toBeTruthy();
    expect(mocks.getStaffLead).toHaveBeenCalledWith('staff-token', WORKSPACE, LEAD);
  });

  it('lists the person’s other requests, each linked, and nothing when there are none', async () => {
    const { unmount } = render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    await screen.findByRole('heading', { level: 1, name: 'Avery Example' });
    expect(screen.queryByRole('heading', { name: 'Other requests from this person' })).toBeNull();
    unmount();

    mocks.getStaffLead.mockResolvedValue(
      response({
        related: [
          {
            id: '90000000-0000-4000-8000-000000000002',
            leadType: 'mobility',
            status: 'submitted',
            stage: 'contacted',
            deletedAt: null,
            createdAt: NOW,
            updatedAt: NOW,
          },
          {
            id: '90000000-0000-4000-8000-000000000003',
            leadType: 'internet',
            status: 'submitted',
            stage: 'new',
            deletedAt: NOW,
            createdAt: '2026-10-01T12:00:00.000Z',
            updatedAt: NOW,
          },
        ],
      }),
    );
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    const list = await screen.findByRole('list', { name: 'Other requests from this person' });
    const links = within(list).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/w/canadawide/leads/90000000-0000-4000-8000-000000000002',
      '/w/canadawide/leads/90000000-0000-4000-8000-000000000003',
    ]);
    expect(within(links[0] ?? list).getByText('Contacted')).toBeTruthy();
    expect(within(links[1] ?? list).getByText('In trash')).toBeTruthy();
  });

  it('changes the stage and shows the new timeline entry', async () => {
    const entry: LeadActivity = {
      id: '92000000-0000-4000-8000-000000000001',
      actorId: SELF,
      createdAt: NOW,
      kind: 'status_change',
      from: 'new',
      to: 'qualified',
    };
    mocks.updateStaffLead.mockResolvedValue({
      lead: { ...lead, stage: 'qualified' },
      activities: [entry],
      requestId: NOW,
    });
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    const stage = await screen.findByLabelText('Stage');
    fireEvent.change(stage, { target: { value: 'qualified' } });

    await waitFor(() =>
      expect(mocks.updateStaffLead).toHaveBeenCalledWith('staff-token', WORKSPACE, LEAD, {
        stage: 'qualified',
      }),
    );
    const timeline = screen.getByRole('region', { name: 'Timeline' });
    expect(await within(timeline).findByText('Qualified')).toBeTruthy();
    expect(within(timeline).getByText('You')).toBeTruthy();
  });

  it('assigns the lead to a colleague by name', async () => {
    mocks.updateStaffLead.mockResolvedValue({
      lead: { ...lead, assignedActorId: COLLEAGUE },
      activities: [],
      requestId: NOW,
    });
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    const assignee = await screen.findByLabelText('Assignee');
    await within(assignee).findByRole('option', { name: 'Sam' });
    fireEvent.change(assignee, { target: { value: COLLEAGUE } });
    await waitFor(() =>
      expect(mocks.updateStaffLead).toHaveBeenCalledWith('staff-token', WORKSPACE, LEAD, {
        assignedActorId: COLLEAGUE,
      }),
    );
  });

  it('adds a note to the top of the timeline', async () => {
    const note: LeadActivity = {
      id: '92000000-0000-4000-8000-000000000002',
      actorId: SELF,
      createdAt: NOW,
      kind: 'note',
      body: 'Called, booked the install.',
    };
    mocks.addLeadNote.mockResolvedValue({ activity: note, requestId: NOW });
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    fireEvent.change(await screen.findByLabelText('Add a note'), {
      target: { value: '  Called, booked the install.  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    expect(await screen.findByText('Called, booked the install.')).toBeTruthy();
    expect(mocks.addLeadNote).toHaveBeenCalledWith(
      'staff-token',
      WORKSPACE,
      LEAD,
      'Called, booked the install.',
    );
  });

  it('keeps the customer’s details, notes and tasks from a read-only role', async () => {
    mocks.getStaffLead.mockResolvedValue(
      response({
        lead: { ...lead, contact: {}, form: null },
        access: { contacts: false, manage: false },
      }),
    );
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    expect(await screen.findByText(/not the customer’s details/)).toBeTruthy();
    expect(screen.queryByLabelText('Stage')).toBeNull();
    expect(screen.queryByLabelText('Add a note')).toBeNull();
    expect(screen.queryByRole('button', { name: /trash/i })).toBeNull();
    expect(screen.getByText('New')).toBeTruthy();
  });

  it('shows a trashed lead read-only with a way back', async () => {
    mocks.getStaffLead.mockResolvedValue(response({ lead: { ...lead, deletedAt: NOW } }));
    mocks.setLeadTrashed.mockResolvedValue({
      lead,
      activity: {
        id: '92000000-0000-4000-8000-000000000003',
        actorId: SELF,
        createdAt: NOW,
        kind: 'system',
        event: 'restored',
      },
      requestId: NOW,
    });
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    expect(await screen.findByText(/This lead is in the trash/)).toBeTruthy();
    expect(screen.queryByLabelText('Stage')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(screen.queryByText(/This lead is in the trash/)).toBeNull());
    expect(mocks.setLeadTrashed).toHaveBeenCalledWith('staff-token', WORKSPACE, LEAD, false);
    expect(await screen.findByLabelText('Stage')).toBeTruthy();
  });

  it('says plainly when the lead does not exist', async () => {
    const { BackendError } = await import('../../lib/api');
    mocks.getStaffLead.mockRejectedValue(new BackendError('lead_not_found', 404, NOW));
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    expect(await screen.findByRole('heading', { name: 'Lead not found' })).toBeTruthy();
  });
});

describe('LeadRecord ID check', () => {
  const IDENTITY = '60000000-0000-4000-8000-000000000001';
  const FILE = '50000000-0000-4000-8000-000000000001';
  // A made-up number that passes the Luhn check, never a real person's.
  const sin: LeadIdentity = {
    id: IDENTITY,
    idType: 'sin',
    sinMasked: '*** *** 286',
    dateOfBirth: '1990-01-31',
    fileId: null,
    createdAt: NOW,
  };
  const licence: LeadIdentity = {
    id: '60000000-0000-4000-8000-000000000002',
    idType: 'drivers_licence',
    sinMasked: null,
    dateOfBirth: null,
    fileId: FILE,
    createdAt: NOW,
  };

  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.listWorkspaceMembers.mockResolvedValue({ members, requestId: NOW });
  });

  it('shows nothing when the customer gave no ID', async () => {
    mocks.getStaffLead.mockResolvedValue(response());
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    await screen.findByRole('heading', { level: 1, name: 'Avery Example' });
    expect(screen.queryByRole('heading', { name: 'ID check' })).toBeNull();
  });

  it('shows a SIN masked, and only an owner may reveal it, for a minute', async () => {
    mocks.getStaffLead.mockResolvedValue(
      response({
        identities: [sin],
        access: { contacts: true, manage: true, revealSensitive: true },
      }),
    );
    mocks.revealLeadIdentity.mockResolvedValue({ sin: '046454286', requestId: NOW });
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    expect(await screen.findByText('*** *** 286')).toBeTruthy();
    expect(screen.getByText('Born 1990-01-31')).toBeTruthy();

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Reveal' }));
      expect(await screen.findByText('046 454 286')).toBeTruthy();
      expect(mocks.revealLeadIdentity).toHaveBeenCalledWith(
        'staff-token',
        WORKSPACE,
        LEAD,
        IDENTITY,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
      expect(screen.getByText('*** *** 286')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Reveal' }));
      await screen.findByText('046 454 286');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REVEAL_SECONDS * 1000);
      });
      expect(screen.queryByText('046 454 286')).toBeNull();
      expect(screen.getByText('*** *** 286')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers no reveal to anyone else', async () => {
    mocks.getStaffLead.mockResolvedValue(response({ identities: [sin] }));
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    expect(await screen.findByText('*** *** 286')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reveal' })).toBeNull();
  });

  it('downloads a licence photo through a signed link, and says why it cannot', async () => {
    mocks.getStaffLead.mockResolvedValue(response({ identities: [licence] }));
    mocks.createFileDownloadLink.mockResolvedValueOnce({
      url: 'https://storage.example.test/signed',
      expiresAt: NOW,
      requestId: NOW,
    });
    const open = vi.spyOn(downloadNavigation, 'open').mockImplementation(() => undefined);
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download photo' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://storage.example.test/signed'));
    expect(mocks.createFileDownloadLink).toHaveBeenCalledWith('staff-token', WORKSPACE, FILE);

    const { BackendError } = await import('../../lib/api');
    mocks.createFileDownloadLink.mockRejectedValueOnce(
      new BackendError('permission_denied', 403, NOW),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Download photo' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'You need the document download permission for this.',
    );
    open.mockRestore();
  });
});

describe('LeadRecord order details', () => {
  const orderPayload = {
    planId: 'unlimited-data-rogers',
    planLabel: 'Unlimited Data · $40, Rogers',
    delivery: 'esim',
    arrivalDate: '2026-11-02',
    customerNotes: 'Call after 6pm',
  };
  const order: LeadDetail = {
    ...lead,
    leadType: 'sim_order',
    stage: 'pending',
    form: { schemaVersion: 1, payload: orderPayload },
  };

  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.listWorkspaceMembers.mockResolvedValue({ members, requestId: NOW });
    mocks.getStaffLead.mockResolvedValue(response({ lead: order }));
  });

  it('shows the order as staff read it, with the staff-only SIM number apart', async () => {
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    expect(await screen.findByText('Unlimited Data · $40, Rogers')).toBeTruthy();
    expect(screen.getByText('eSIM')).toBeTruthy();
    expect(screen.getByText('Call after 6pm')).toBeTruthy();
    const staff = screen.getByRole('heading', { name: 'Staff details' }).closest('div');
    expect(staff?.parentElement?.textContent).toContain('SIM number');
  });

  it('corrects only the changed order fields', async () => {
    mocks.updateStaffLead.mockResolvedValue({
      lead: {
        ...order,
        form: { schemaVersion: 1, payload: { ...orderPayload, arrivalDate: '2026-11-09' } },
      },
      activities: [
        {
          id: '92000000-0000-4000-8000-000000000003',
          actorId: SELF,
          createdAt: NOW,
          kind: 'edit',
          fields: ['arrivalDate'],
        },
      ],
      requestId: NOW,
    });
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    const request = (await screen.findByRole('heading', { name: 'Request' })).closest('div');
    fireEvent.click(within(request!).getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Arrival in Canada'), {
      target: { value: '2026-11-09' },
    });
    fireEvent.change(screen.getByLabelText('Has the visa'), { target: { value: 'yes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mocks.updateStaffLead).toHaveBeenCalledWith('staff-token', WORKSPACE, LEAD, {
        form: { arrivalDate: '2026-11-09', gotVisa: true },
      }),
    );
    const timeline = screen.getByRole('region', { name: 'Timeline' });
    expect(await within(timeline).findByText(/corrected the arrival in canada/)).toBeTruthy();
  });

  it('saves a SIM number from the staff card', async () => {
    mocks.updateStaffLead.mockResolvedValue({
      lead: {
        ...order,
        form: { schemaVersion: 1, payload: { ...orderPayload, simNumber: '4165550104' } },
      },
      activities: [],
      requestId: NOW,
    });
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    const staff = (await screen.findByRole('heading', { name: 'Staff details' })).closest('div');
    fireEvent.click(within(staff!).getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('SIM number'), { target: { value: ' 4165550104 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mocks.updateStaffLead).toHaveBeenCalledWith('staff-token', WORKSPACE, LEAD, {
        form: { simNumber: ' 4165550104 ' },
      }),
    );
    expect(await screen.findByText('4165550104')).toBeTruthy();
  });

  it('asks to email the customer a newly saved SIM number, and sends it on yes', async () => {
    mocks.getStaffLead.mockResolvedValue(
      response({ lead: order, access: { contacts: true, manage: true, emailCustomer: true } }),
    );
    mocks.updateStaffLead.mockResolvedValue({
      lead: {
        ...order,
        form: { schemaVersion: 1, payload: { ...orderPayload, simNumber: '4165550104' } },
      },
      activities: [],
      requestId: NOW,
    });
    mocks.emailLeadCustomer.mockResolvedValue({
      activity: {
        id: '92000000-0000-4000-8000-000000000010',
        actorId: SELF,
        createdAt: NOW,
        kind: 'system',
        event: 'customer_emailed',
        template: 'sim_number_ready',
      },
      requestId: NOW,
    });
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    const staff = (await screen.findByRole('heading', { name: 'Staff details' })).closest('div');
    fireEvent.click(within(staff!).getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('SIM number'), { target: { value: '4165550104' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const ask = await screen.findByRole('group', { name: 'Email the customer this number?' });
    fireEvent.click(within(ask).getByRole('button', { name: 'Email the customer' }));
    await waitFor(() =>
      expect(mocks.emailLeadCustomer).toHaveBeenCalledWith(
        'staff-token',
        WORKSPACE,
        LEAD,
        'sim_number_ready',
      ),
    );
    expect((await screen.findByRole('status')).textContent).toContain('within a minute');
    const timeline = screen.getByRole('region', { name: 'Timeline' });
    expect(within(timeline).getByText('emailed the customer their SIM number')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Email the customer this number?' })).toBeNull();
  });

  it('lets staff decline, resend later, and hear why a mail could not go', async () => {
    const withNumber = {
      ...order,
      form: { schemaVersion: 1 as const, payload: { ...orderPayload, simNumber: '4165550104' } },
    };
    mocks.getStaffLead.mockResolvedValue(
      response({ lead: withNumber, access: { contacts: true, manage: true, emailCustomer: true } }),
    );
    const { BackendError } = await import('../../lib/api');
    mocks.emailLeadCustomer.mockRejectedValue(new BackendError('conflict', 409, NOW));
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Email it to the customer' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The order needs the customer’s email address and a SIM number first.',
    );
  });

  it('says when this site cannot email its customers yet', async () => {
    mocks.getStaffLead.mockResolvedValue(
      response({
        lead: {
          ...order,
          form: { schemaVersion: 1, payload: { ...orderPayload, simNumber: '4165550104' } },
        },
        access: { contacts: true, manage: true, emailCustomer: false },
      }),
    );
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    expect(
      await screen.findByText('Emailing the customer is not set up for this site yet.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Email it to the customer' })).toBeNull();
  });

  it('offers no edits to someone who may only read', async () => {
    mocks.getStaffLead.mockResolvedValue(
      response({ lead: order, access: { contacts: true, manage: false } }),
    );
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    await screen.findByRole('heading', { name: 'Request' });
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });
});

describe('LeadRecord New badge', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.listWorkspaceMembers.mockResolvedValue({ members, requestId: NOW });
  });

  it('clears the badge once when someone who works leads opens it', async () => {
    mocks.getStaffLead.mockResolvedValue(response({ lead: { ...lead, isNew: true } }));
    mocks.markLeadOpened.mockResolvedValue({
      activity: {
        id: '92000000-0000-4000-8000-000000000009',
        actorId: SELF,
        createdAt: NOW,
        kind: 'system',
        event: 'opened',
      },
      requestId: NOW,
    });
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    const timeline = await screen.findByRole('region', { name: 'Timeline' });
    expect(await within(timeline).findByText('opened this')).toBeTruthy();
    expect(mocks.markLeadOpened).toHaveBeenCalledTimes(1);
    expect(mocks.markLeadOpened).toHaveBeenCalledWith('staff-token', WORKSPACE, LEAD);
  });

  it('leaves it for a reader, and never reports an opened lead again', async () => {
    mocks.getStaffLead.mockResolvedValue(
      response({ lead: { ...lead, isNew: true }, access: { contacts: true, manage: false } }),
    );
    const { unmount } = render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    await screen.findByRole('heading', { level: 1, name: 'Avery Example' });
    unmount();

    mocks.getStaffLead.mockResolvedValue(response({ lead: { ...lead, isNew: false } }));
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    await screen.findByRole('heading', { level: 1, name: 'Avery Example' });
    expect(mocks.markLeadOpened).not.toHaveBeenCalled();
  });

  it('hides an open carried over from the old admin', async () => {
    mocks.getStaffLead.mockResolvedValue(
      response({
        activities: [
          {
            id: '92000000-0000-4000-8000-00000000000a',
            actorId: '00000000-0000-4000-8000-00000000a001',
            createdAt: NOW,
            kind: 'system',
            event: 'opened',
          },
        ],
      }),
    );
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    const timeline = await screen.findByRole('region', { name: 'Timeline' });
    expect(within(timeline).queryByText('opened this')).toBeNull();
  });
});
