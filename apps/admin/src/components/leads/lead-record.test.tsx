import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildPropertyCatalog,
  codePropertyCatalog,
  type AssignableMember,
  type GetWorkspaceLeadResponse,
  type LeadDocument,
  type LeadIdentity,
  type LeadActivity,
  type LeadDetail,
  type LeadOrder,
  type PlanSnapshot,
  type PropertyLayout,
  type SiteProperty,
} from '@gt-sales/contracts';

import { downloadNavigation } from '../../lib/file-links';
import { catalogFromModel } from '../properties/use-property-model';
import { REVEAL_SECONDS } from './identity-check';
import { PropertySections } from '../properties/property-sections';
import { LeadRecord } from './lead-record';

const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const LEAD = '90000000-0000-4000-8000-000000000001';
const SELF = '20000000-0000-4000-8000-000000000001';
const COLLEAGUE = '20000000-0000-4000-8000-000000000002';
const NOW = '2026-10-26T12:00:00.000Z';

const mocks = vi.hoisted(() => ({
  getStaffLead: vi.fn(),
  updateStaffLead: vi.fn(),
  setLeadArchived: vi.fn(),
  addLeadNote: vi.fn(),
  createLeadTask: vi.fn(),
  updateLeadTask: vi.fn(),
  listWorkspaceMembers: vi.fn(),
  revealLeadIdentity: vi.fn(),
  createFileDownloadLink: vi.fn(),
  markLeadOpened: vi.fn(),
  emailLeadCustomer: vi.fn(),
  getPropertyModel: vi.fn(),
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
    documents: [],
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
    expect(within(links[1] ?? list).getByText('In archive')).toBeTruthy();
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
    expect(screen.queryByRole('button', { name: /archive/i })).toBeNull();
    expect(screen.getByText('New')).toBeTruthy();
  });

  it('archives the lead from the header and says so', async () => {
    mocks.setLeadArchived.mockResolvedValue({
      lead: { ...lead, deletedAt: NOW },
      activity: {
        id: '92000000-0000-4000-8000-000000000004',
        actorId: SELF,
        createdAt: NOW,
        kind: 'system',
        event: 'trashed',
      },
      requestId: NOW,
    });
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));
    expect(await screen.findByText(/This lead is archived \(since/)).toBeTruthy();
    expect(mocks.setLeadArchived).toHaveBeenCalledWith('staff-token', WORKSPACE, LEAD, true);
    const timeline = screen.getByRole('region', { name: 'Timeline' });
    expect(within(timeline).getByText('archived this')).toBeTruthy();
    expect(document.body.textContent ?? '').not.toMatch(/trash/i);
  });

  it('shows an archived lead read-only with a way back', async () => {
    mocks.getStaffLead.mockResolvedValue(response({ lead: { ...lead, deletedAt: NOW } }));
    mocks.setLeadArchived.mockResolvedValue({
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
    expect(await screen.findByText(/This lead is archived \(since/)).toBeTruthy();
    expect(screen.queryByLabelText('Stage')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(screen.queryByText(/This lead is archived/)).toBeNull());
    expect(mocks.setLeadArchived).toHaveBeenCalledWith('staff-token', WORKSPACE, LEAD, false);
    expect(await screen.findByLabelText('Stage')).toBeTruthy();
    const timeline = screen.getByRole('region', { name: 'Timeline' });
    expect(within(timeline).getByText('restored this')).toBeTruthy();
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

describe('LeadRecord documents', () => {
  const PASSPORT = '50000000-0000-4000-8000-000000000011';
  const passport: LeadDocument = {
    id: PASSPORT,
    documentType: 'passport',
    contentType: 'application/pdf',
    sizeBytes: 1_258_291,
    revision: 1,
    createdAt: NOW,
  };
  const simPhoto: LeadDocument = {
    id: '50000000-0000-4000-8000-000000000012',
    documentType: 'sim_photo',
    contentType: 'image/jpeg',
    sizeBytes: 84_000,
    revision: 2,
    createdAt: NOW,
  };
  const owner = { contacts: true, manage: true, downloadDocuments: true };

  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.listWorkspaceMembers.mockResolvedValue({ members, requestId: NOW });
  });

  it('lists each document by name, format and size, and nothing when there are none', async () => {
    mocks.getStaffLead.mockResolvedValue(response());
    const { unmount } = render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    await screen.findByRole('heading', { level: 1, name: 'Avery Example' });
    expect(screen.queryByRole('heading', { name: 'Documents' })).toBeNull();
    unmount();

    mocks.getStaffLead.mockResolvedValue(
      response({ documents: [simPhoto, passport], access: owner }),
    );
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    const list = await screen.findByRole('list', { name: 'Documents' });
    const rows = within(list).getAllByRole('listitem');
    // Passport first, whatever order they arrive in.
    expect(rows[0]?.textContent).toContain('Passport');
    expect(rows[0]?.textContent).toContain('PDF · 1.2 MB');
    expect(rows[1]?.textContent).toContain('SIM card photo');
    expect(rows[1]?.textContent).toContain('JPEG · 82 KB');
  });

  it('views a document in a tab of its own, through an inline link', async () => {
    mocks.getStaffLead.mockResolvedValue(response({ documents: [passport], access: owner }));
    mocks.createFileDownloadLink.mockResolvedValueOnce({
      url: 'https://storage.example.test/view',
      expiresAt: NOW,
      requestId: NOW,
    });
    const tab = { show: vi.fn(), close: vi.fn() };
    const openTab = vi.spyOn(downloadNavigation, 'openTab').mockReturnValue(tab);
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    fireEvent.click(await screen.findByRole('button', { name: 'View Passport' }));
    await waitFor(() => expect(tab.show).toHaveBeenCalledWith('https://storage.example.test/view'));
    expect(openTab).toHaveBeenCalledTimes(1);
    expect(mocks.createFileDownloadLink).toHaveBeenCalledWith(
      'staff-token',
      WORKSPACE,
      PASSPORT,
      'inline',
    );

    // A refused link closes the tab again and says why.
    const { BackendError } = await import('../../lib/api');
    mocks.createFileDownloadLink.mockRejectedValueOnce(
      new BackendError('file_not_available', 409, NOW),
    );
    fireEvent.click(screen.getByRole('button', { name: 'View Passport' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This document is not available yet.',
    );
    expect(tab.close).toHaveBeenCalledTimes(1);

    // A blocked tab asks for nothing from the backend.
    openTab.mockReturnValueOnce(undefined);
    const calls = mocks.createFileDownloadLink.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'View Passport' }));
    expect((await screen.findByRole('alert')).textContent).toContain('blocked the new tab');
    expect(mocks.createFileDownloadLink.mock.calls.length).toBe(calls);
    openTab.mockRestore();
  });

  it('downloads a document through a signed link', async () => {
    mocks.getStaffLead.mockResolvedValue(response({ documents: [passport], access: owner }));
    mocks.createFileDownloadLink.mockResolvedValueOnce({
      url: 'https://storage.example.test/download',
      expiresAt: NOW,
      requestId: NOW,
    });
    const open = vi.spyOn(downloadNavigation, 'open').mockImplementation(() => undefined);
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download Passport' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://storage.example.test/download'));
    expect(mocks.createFileDownloadLink).toHaveBeenCalledWith('staff-token', WORKSPACE, PASSPORT);
    open.mockRestore();
  });

  it('offers no View or Download without the permission, and says who can grant it', async () => {
    mocks.getStaffLead.mockResolvedValue(response({ documents: [passport] }));
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    await screen.findByRole('list', { name: 'Documents' });
    expect(screen.queryByRole('button', { name: 'View Passport' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Download Passport' })).toBeNull();
    expect(screen.getByText(/an owner can grant/)).toBeTruthy();
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

  it('copies the order as text, and links its delivery letter', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy info' }));
    await screen.findByRole('button', { name: 'Copied' });
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('Plan (as submitted): Unlimited Data · $40, Rogers'),
    );

    const letter = screen.getByRole('link', { name: 'Print delivery letter' });
    expect(letter.getAttribute('target')).toBe('_blank');
    expect(letter.getAttribute('rel')).toContain('noreferrer');
    expect(letter.getAttribute('href')).toMatch(
      /^https:\/\/getcanadasim\.com\/delivery-letter\.html\?first_name=Avery&/,
    );
  });

  it('shows the customer’s change requests, and says where a waiting one is decided', async () => {
    const legacy = '00000000-0000-4000-8000-00000000a001';
    const changeRequest = (requestNo: number, createdAt: string, extra = {}) => ({
      id: `92000000-0000-4000-8000-00000000c00${requestNo}`,
      actorId: legacy,
      createdAt,
      kind: 'system' as const,
      event: 'change_requested' as const,
      requestNo,
      ...extra,
    });
    mocks.getStaffLead.mockResolvedValue(
      response({
        lead: order,
        activities: [
          changeRequest(2, '2026-09-04T10:00:00.000Z', { fields: ['phone'], documents: [] }),
          {
            id: '92000000-0000-4000-8000-00000000d001',
            actorId: legacy,
            createdAt: '2026-09-03T10:00:00.000Z',
            kind: 'system',
            event: 'change_approved',
            requestNo: 1,
          },
          changeRequest(1, '2026-09-02T10:00:00.000Z', {
            fields: ['arrivalDate'],
            documents: ['passport', 'visa'],
          }),
        ],
      }),
    );
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    const timeline = await screen.findByRole('heading', { name: 'Timeline' });
    const entries = within(timeline.parentElement!).getAllByRole('listitem');
    expect(entries[0]?.textContent).toContain('Customer asked to change the phone (request #2)');
    expect(entries[1]?.textContent).toContain(
      'Old admin approved the customer’s change request #1',
    );
    expect(entries[2]?.textContent).toContain(
      'Customer asked to change the arrival in canada and sent a new passport and visa or approval letter (request #1)',
    );
    // #2 is still undecided: the page says where it is decided.
    const waiting = screen.getByText(/Waiting in the old admin/);
    expect(waiting.textContent).toContain('asked to change the phone (request #2)');
  });

  it('offers no delivery letter for a lead type without one', async () => {
    mocks.getStaffLead.mockResolvedValue(response());
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    expect(await screen.findByRole('button', { name: 'Copy info' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Print delivery letter' })).toBeNull();
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
    fireEvent.change(screen.getByLabelText('Has the visa'), { target: { value: 'true' } });
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
        // Checked against the property before it is sent, so it goes trimmed.
        form: { simNumber: '4165550104' },
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
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      'The order needs the customer’s email address and a SIM number first.',
    );
    // The theme's error colour, readable on the light panel and the dark page alike.
    expect(alert.className).toContain('text-destructive');
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

describe('LeadRecord from the site layout', () => {
  function customProperty(
    overrides: Partial<SiteProperty> & Pick<SiteProperty, 'key' | 'label' | 'kind'>,
  ): SiteProperty {
    return {
      origin: 'custom',
      storage: 'custom',
      sensitive: false,
      staffOnly: false,
      hidden: false,
      websiteVisible: false,
      leadTypes: [],
      editable: true,
      version: 1,
      ...overrides,
    };
  }
  const referral = customProperty({
    key: 'custom_referral_code',
    label: 'Referral code',
    kind: 'text',
  });
  const vip = customProperty({ key: 'custom_vip', label: 'VIP', kind: 'yesNo' });
  const passport = customProperty({
    key: 'custom_passport_number',
    label: 'Passport number',
    kind: 'text',
    sensitive: true,
  });

  /** `GET /properties`: the code catalogue with the site's changes, and its saved layouts. */
  function model(
    options: {
      properties?: readonly SiteProperty[];
      layouts?: Record<string, PropertyLayout>;
    } = {},
  ) {
    return {
      properties: [...(options.properties ?? [...codePropertyCatalog.all, referral, vip])],
      layouts: Object.fromEntries(
        Object.entries(options.layouts ?? {}).map(([leadType, layout]) => [
          leadType,
          { object: 'lead' as const, leadType, layout, version: 1, updatedAt: NOW },
        ]),
      ),
      capabilities: { canManage: true },
      requestId: NOW,
    };
  }

  const headings = () =>
    screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);

  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.listWorkspaceMembers.mockResolvedValue({ members, requestId: NOW });
  });

  it('lays the record out in the sections the site saved, with what they leave out last', async () => {
    mocks.getPropertyModel.mockResolvedValue(
      model({
        layouts: {
          internet: {
            sections: [
              { id: 'address', label: 'Address', keys: ['streetAddress', 'city'] },
              { id: 'plan', label: 'Plan details', keys: ['planLabel'] },
            ],
          },
        },
      }),
    );
    mocks.getStaffLead.mockResolvedValue(
      response({ lead: { ...lead, customValues: { custom_referral_code: 'FRIEND' } } }),
    );
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    const address = await screen.findByRole('region', { name: 'Address' });
    expect(within(address).getByText('12 Example Street')).toBeTruthy();
    expect(within(address).getByText('Calgary')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Plan details' })).getByText('1Gbps'));
    // Nothing the site adds is unreachable: unplaced properties close the record.
    const other = screen.getByRole('region', { name: 'Other' });
    expect(within(other).getByText('Referral code')).toBeTruthy();
    expect(within(other).getByText('FRIEND')).toBeTruthy();
    const order = headings();
    expect(order.indexOf('Address')).toBeLessThan(order.indexOf('Plan details'));
    expect(order.indexOf('Plan details')).toBeLessThan(order.indexOf('Other'));
    expect(order.indexOf('Other')).toBeLessThan(order.indexOf('Source'));
    expect(screen.queryByRole('heading', { name: 'Request' })).toBeNull();
  });

  it('uses the default sections while the site has saved no layout for the type', async () => {
    mocks.getPropertyModel.mockResolvedValue(model());
    mocks.getStaffLead.mockResolvedValue(
      response({ lead: { ...lead, customValues: { custom_referral_code: 'FRIEND' } } }),
    );
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    const custom = await screen.findByRole('region', { name: 'Custom' });
    expect(within(custom).getByText('FRIEND')).toBeTruthy();
    expect(
      within(screen.getByRole('region', { name: 'Request' })).getByText('12 Example Street'),
    ).toBeTruthy();
  });

  it('leaves out a built-in property the site hid', async () => {
    mocks.getPropertyModel.mockResolvedValue(
      model({
        properties: codePropertyCatalog.all.map((entry) =>
          entry.key === 'city' ? { ...entry, hidden: true, version: 2 } : entry,
        ),
      }),
    );
    mocks.getStaffLead.mockResolvedValue(response());
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    // The address shows once the site's catalogue is in; its hidden city never does.
    await waitFor(() => expect(mocks.getPropertyModel).toHaveBeenCalled());
    expect(await screen.findByText('12 Example Street')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Calgary')).toBeNull());
  });

  it('saves a custom value as customValues in the same change as the form', async () => {
    const order: LeadDetail = {
      ...lead,
      leadType: 'sim_order',
      stage: 'pending',
      form: { schemaVersion: 1, payload: { arrivalDate: '2026-11-02', delivery: 'esim' } },
      customValues: { custom_referral_code: 'FRIEND', custom_vip: true },
    };
    mocks.getPropertyModel.mockResolvedValue(
      model({
        layouts: {
          sim_order: {
            sections: [
              {
                id: 'trip',
                label: 'Trip',
                keys: ['arrivalDate', 'custom_referral_code', 'custom_vip'],
              },
            ],
          },
        },
      }),
    );
    mocks.getStaffLead.mockResolvedValue(response({ lead: order }));
    mocks.updateStaffLead.mockResolvedValue({
      lead: {
        ...order,
        form: { schemaVersion: 1, payload: { arrivalDate: '2026-11-09', delivery: 'esim' } },
        customValues: { custom_referral_code: 'SPRING' },
      },
      activities: [
        {
          id: '92000000-0000-4000-8000-000000000020',
          actorId: SELF,
          createdAt: NOW,
          kind: 'edit',
          fields: ['arrivalDate', 'custom_referral_code', 'custom_vip'],
        },
      ],
      requestId: NOW,
    });
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    const trip = await screen.findByRole('region', { name: 'Trip' });
    await within(trip).findByText('FRIEND');
    fireEvent.click(within(trip).getByRole('button', { name: 'Edit' }));
    fireEvent.change(within(trip).getByLabelText('Arrival in Canada'), {
      target: { value: '2026-11-09' },
    });
    fireEvent.change(within(trip).getByLabelText('Referral code'), {
      target: { value: 'SPRING' },
    });
    fireEvent.change(within(trip).getByLabelText('VIP'), { target: { value: '' } });
    fireEvent.click(within(trip).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mocks.updateStaffLead).toHaveBeenCalledWith('staff-token', WORKSPACE, LEAD, {
        form: { arrivalDate: '2026-11-09' },
        customValues: { custom_referral_code: 'SPRING', custom_vip: null },
      }),
    );
    expect(mocks.updateStaffLead).toHaveBeenCalledTimes(1);
    expect(await within(trip).findByText('SPRING')).toBeTruthy();
    // The timeline names custom keys by their label.
    const timeline = screen.getByRole('region', { name: 'Timeline' });
    expect(
      within(timeline).getByText('corrected the arrival in canada, referral code, vip'),
    ).toBeTruthy();
  });

  it('says why a change was not saved and keeps the edit open', async () => {
    mocks.getPropertyModel.mockResolvedValue(model());
    mocks.getStaffLead.mockResolvedValue(
      response({ lead: { ...lead, customValues: { custom_referral_code: 'FRIEND' } } }),
    );
    const { BackendError } = await import('../../lib/api');
    mocks.updateStaffLead.mockRejectedValue(new BackendError('validation_error', 400, NOW));
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    const custom = await screen.findByRole('region', { name: 'Custom' });
    fireEvent.click(within(custom).getByRole('button', { name: 'Edit' }));
    fireEvent.change(within(custom).getByLabelText('Referral code'), {
      target: { value: 'SPRING' },
    });
    fireEvent.click(within(custom).getByRole('button', { name: 'Save' }));
    const alert = await within(custom).findByRole('alert');
    expect(alert.textContent).toBe('The change was not saved. Reason: validation_error.');
    expect(alert.className).toContain('text-destructive');
    expect(within(custom).getByLabelText('Referral code')).toBeTruthy();
  });

  it('shows sensitive properties to everyone who sees the customer’s details', async () => {
    const withSecrets: LeadDetail = {
      ...lead,
      form: {
        schemaVersion: 1,
        payload: { ...lead.form?.payload, dateOfBirth: '1990-01-31' },
      },
      customValues: { custom_passport_number: 'X1234567' },
    };
    mocks.getPropertyModel.mockResolvedValue(
      model({ properties: [...codePropertyCatalog.all, passport] }),
    );
    // Contact access without the owner's SIN reveal.
    mocks.getStaffLead.mockResolvedValue(response({ lead: withSecrets }));
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    const custom = await screen.findByRole('region', { name: 'Custom' });
    expect(within(custom).getByText('X1234567')).toBeTruthy();
    const request = screen.getByRole('region', { name: 'Request' });
    expect(within(request).getByText('Date of birth')).toBeTruthy();
    expect(within(request).getByText('Jan 31, 1990')).toBeTruthy();
    expect(screen.queryByText('••••')).toBeNull();
    expect(within(custom).getByRole('button', { name: 'Edit' })).toBeTruthy();
  });

  it('names an unknown key on the timeline as it is', async () => {
    mocks.getPropertyModel.mockResolvedValue(model());
    mocks.getStaffLead.mockResolvedValue(
      response({
        activities: [
          {
            id: '92000000-0000-4000-8000-000000000021',
            actorId: SELF,
            createdAt: NOW,
            kind: 'edit',
            fields: ['custom_referral_code', 'custom_gone'],
          },
        ],
      }),
    );
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    const timeline = await screen.findByRole('region', { name: 'Timeline' });
    expect(
      await within(timeline).findByText('corrected the referral code, custom_gone'),
    ).toBeTruthy();
  });

  it('drops the page chrome in the side panel and keeps the content', async () => {
    mocks.getPropertyModel.mockResolvedValue(model());
    mocks.getStaffLead.mockResolvedValue(response());
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} variant="panel" />);
    expect(await screen.findByRole('heading', { level: 2, name: 'Avery Example' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.queryByRole('link', { name: /Internet leads/ })).toBeNull();
    expect(screen.getByLabelText('Stage')).toBeTruthy();
    expect(screen.getByText('12 Example Street')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Timeline' })).toBeTruthy();
  });
});

describe('PropertySections', () => {
  const passport: SiteProperty = {
    key: 'custom_passport_number',
    label: 'Passport number',
    kind: 'text',
    origin: 'custom',
    storage: 'custom',
    sensitive: true,
    staffOnly: false,
    hidden: false,
    websiteVisible: false,
    leadTypes: [],
    editable: true,
    version: 1,
  };
  const catalog = catalogFromModel([...codePropertyCatalog.all, passport]);
  const layout: PropertyLayout = {
    sections: [{ id: 'id', label: 'Identity', keys: ['dateOfBirth', 'custom_passport_number'] }],
  };

  function sections(canRevealSensitive: boolean) {
    return (
      <PropertySections
        leadType="internet"
        layout={layout}
        catalog={catalog}
        form={{ dateOfBirth: '1990-01-31' }}
        customValues={{ custom_passport_number: 'X1234567' }}
        canEdit
        canRevealSensitive={canRevealSensitive}
        onSave={vi.fn(async () => undefined)}
      />
    );
  }

  it('masks sensitive values without contact access, and offers no edit of them', () => {
    render(sections(false));
    const identity = screen.getByRole('region', { name: 'Identity' });
    expect(within(identity).getAllByText('••••')).toHaveLength(2);
    expect(within(identity).queryByText('X1234567')).toBeNull();
    expect(within(identity).queryByText(/1990/)).toBeNull();
    expect(within(identity).queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('shows them with contact access', () => {
    render(sections(true));
    const identity = screen.getByRole('region', { name: 'Identity' });
    expect(within(identity).getByText('X1234567')).toBeTruthy();
    expect(within(identity).getByText('Jan 31, 1990')).toBeTruthy();
    expect(within(identity).queryByText('••••')).toBeNull();
  });
});

describe('LeadRecord order section', () => {
  const ACTIVE_PLAN = '70000000-0000-4000-8000-000000000001';
  const OLD_PLAN = '70000000-0000-4000-8000-000000000002';
  const FROZEN_AT = '2026-10-20T15:00:00.000Z';
  const MOBILITY_PLAN = '70000000-0000-4000-8000-000000000003';
  const plans = [
    { id: ACTIVE_PLAN, name: 'Unlimited 50', active: true, leadType: 'sim_order' },
    { id: OLD_PLAN, name: 'Legacy 10', active: false, leadType: 'sim_order' },
    // Another type's plan: a SIM order never offers it.
    { id: MOBILITY_PLAN, name: 'Talk and text', active: true, leadType: 'mobility' },
  ];
  /** `GET /properties` as the backend answers it: the site's plans, each with its lead type. */
  const model = {
    properties: [...buildPropertyCatalog([], 'lead', { plans }).all],
    plans,
    layouts: {},
    capabilities: { canManage: true },
    requestId: NOW,
  };
  const frozenPlan: PlanSnapshot = {
    planId: OLD_PLAN,
    name: 'Legacy 10',
    priceMinor: 2500,
    currency: 'CAD',
    billingPeriod: 'month',
    paymentRequired: true,
    requiredDocuments: [],
    properties: {},
    frozenAt: FROZEN_AT,
  };
  const frozenOrder: LeadOrder = {
    planId: OLD_PLAN,
    plan: frozenPlan,
    quantity: 2,
    paymentStatus: 'pending',
    carrierCommission: 'not_yet',
  };
  const simOrder = (order: LeadOrder): LeadDetail => ({
    ...lead,
    leadType: 'sim_order',
    stage: 'pending',
    // The form's own plan field (as submitted) is not the order's plan.
    form: { schemaVersion: 1, payload: { planId: 'website-plan-7', delivery: 'esim' } },
    order,
  });

  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.listWorkspaceMembers.mockResolvedValue({ members, requestId: NOW });
    mocks.getPropertyModel.mockResolvedValue(model);
  });

  it('shows the four order fields and the copy frozen on the lead', async () => {
    mocks.getStaffLead.mockResolvedValue(response({ lead: simOrder(frozenOrder) }));
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    const order = await screen.findByRole('region', { name: 'Order' });
    await within(order).findByText('Legacy 10');
    const rows = Array.from(order.querySelectorAll('dt')).map((term) => term.textContent);
    expect(rows).toEqual(['Plan', 'Quantity', 'Payment status', 'Carrier commission']);
    expect(within(order).getByText('2')).toBeTruthy();
    expect(within(order).getByText('Pending')).toBeTruthy();
    expect(within(order).getByText('Not yet')).toBeTruthy();
    const frozen = within(order).getByText(/^Frozen /);
    expect(frozen.textContent).toMatch(/^Frozen Oct 20, 2026: Legacy 10, \$25\.00 \/ Monthly$/);
  });

  it('says when no plan is frozen yet', async () => {
    mocks.getStaffLead.mockResolvedValue(
      response({ lead: simOrder({ ...frozenOrder, planId: null, plan: null }) }),
    );
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    const order = await screen.findByRole('region', { name: 'Order' });
    expect(await within(order).findByText('No plan frozen yet')).toBeTruthy();
  });

  it('offers the active plans, marks the current inactive one, and sends order edits', async () => {
    mocks.getStaffLead.mockResolvedValue(response({ lead: simOrder(frozenOrder) }));
    mocks.updateStaffLead.mockResolvedValue({
      lead: simOrder({
        ...frozenOrder,
        planId: ACTIVE_PLAN,
        plan: { ...frozenPlan, planId: ACTIVE_PLAN, name: 'Unlimited 50', priceMinor: 5000 },
        paymentStatus: 'paid',
      }),
      activities: [
        {
          id: '92000000-0000-4000-8000-000000000030',
          actorId: SELF,
          createdAt: NOW,
          kind: 'edit',
          fields: ['plan', 'paymentStatus'],
        },
      ],
      requestId: NOW,
    });
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    const order = await screen.findByRole('region', { name: 'Order' });
    await within(order).findByText('Legacy 10');
    fireEvent.click(within(order).getByRole('button', { name: 'Edit' }));
    const plan = within(order).getByLabelText('Plan');
    // Only the SIM order's own plans: the mobility plan is not offered.
    expect(Array.from(plan.querySelectorAll('option')).map((option) => option.textContent)).toEqual(
      ['—', 'Unlimited 50', 'Legacy 10 (inactive)'],
    );
    expect(within(order).getByText(/^Frozen /).textContent).toMatch(
      /^Frozen Oct 20, 2026: Legacy 10/,
    );
    fireEvent.change(plan, { target: { value: ACTIVE_PLAN } });
    fireEvent.change(within(order).getByLabelText('Payment status'), {
      target: { value: 'paid' },
    });
    fireEvent.click(within(order).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mocks.updateStaffLead).toHaveBeenCalledWith('staff-token', WORKSPACE, LEAD, {
        order: { planId: ACTIVE_PLAN, paymentStatus: 'paid' },
      }),
    );
    await within(order).findByText('Unlimited 50');
    expect(within(order).getByText(/^Frozen /).textContent).toMatch(
      /^Frozen Oct 20, 2026: Unlimited 50, \$50\.00 \/ Monthly$/,
    );
    const timeline = screen.getByRole('region', { name: 'Timeline' });
    expect(within(timeline).getByText('corrected the plan, payment status')).toBeTruthy();
  });

  it('leaves the order out of a lead the backend sent no order details for', async () => {
    mocks.getStaffLead.mockResolvedValue(
      response({ lead: { ...lead, leadType: 'sim_order', stage: 'pending' } }),
    );
    render(<LeadRecord workspaceSlug="canadawide" leadId={LEAD} />);
    await screen.findByRole('heading', { level: 1, name: 'Avery Example' });
    await waitFor(() => expect(mocks.getPropertyModel).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'Order' })).toBeNull();
  });
});
