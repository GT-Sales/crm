import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AssignableMember,
  GetWorkspaceLeadResponse,
  LeadActivity,
  LeadDetail,
} from '@gt-sales/contracts';

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
