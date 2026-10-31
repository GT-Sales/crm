import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  leadActivitySchema,
  type AssignableMember,
  type LeadActivity,
  type LeadDetail,
} from '@gt-sales/contracts';

import { changeRequestText, LeadTimeline, pendingChangeRequest } from './lead-timeline';

vi.mock('../../lib/api', () => ({ addLeadNote: vi.fn() }));

const LEGACY = '00000000-0000-4000-8000-00000000a001';

/** A change event as the backend sends it, checked by the contract itself. */
function change(event: string, requestNo: number, extra: Record<string, unknown> = {}) {
  return leadActivitySchema.parse({
    id: `92000000-0000-4000-8000-${event === 'change_requested' ? 'c' : 'd'}${String(requestNo).padStart(11, '0')}`,
    actorId: LEGACY,
    createdAt: `2026-09-0${requestNo}T10:00:00.000Z`,
    kind: 'system',
    event,
    requestNo,
    ...extra,
  });
}

function system(activity: LeadActivity) {
  if (activity.kind !== 'system') throw new Error('expected a system entry');
  return activity;
}

describe('change requests', () => {
  it('finds the newest undecided request, and none once each is decided', () => {
    const newer = change('change_requested', 2);
    const older = change('change_requested', 1);
    expect(pendingChangeRequest([newer, older])?.requestNo).toBe(2);
    const rejected = change('change_rejected', 2);
    expect(pendingChangeRequest([rejected, newer, older])?.requestNo).toBe(1);
    const approved = change('change_approved', 1);
    expect(pendingChangeRequest([rejected, approved, newer, older])).toBeUndefined();
  });

  it('names fields and documents, or the order when it names neither', () => {
    const documentsOnly = system(change('change_requested', 3, { documents: ['passport'] }));
    expect(changeRequestText(documentsOnly, 'sim_order')).toBe('sent a new passport (request #3)');
    const bare = system(change('change_requested', 4));
    expect(changeRequestText(bare, 'sim_order')).toBe('asked to change their order (request #4)');
  });
});

describe('CRM change requests', () => {
  const SITE = '30000000-0000-4000-8000-0000000000aa';
  const crm = (event: string, requestNo: number, extra: Record<string, unknown> = {}) =>
    leadActivitySchema.parse({
      id: `92000000-0000-4000-8000-${event === 'change_requested' ? 'e' : 'f'}${String(requestNo).padStart(11, '0')}`,
      actorId: SITE,
      createdAt: '2026-10-30T10:00:00.000Z',
      kind: 'system',
      event,
      requestNo,
      changeRequestId: 'c0000000-0000-4000-8000-000000000001',
      ...extra,
    });

  it('leaves a request made through the CRM to the change request card', () => {
    // Only a request carried over from the old admin waits there.
    expect(pendingChangeRequest([crm('change_requested', 70)])).toBeUndefined();
    const carried = change('change_requested', 3);
    expect(pendingChangeRequest([crm('change_requested', 70), carried])?.requestNo).toBe(3);
  });

  it('does not count a CRM decision as the old admin deciding an imported request', () => {
    const carried = change('change_requested', 3);
    expect(pendingChangeRequest([crm('change_approved', 3), carried])?.requestNo).toBe(3);
  });
});

describe('LeadTimeline', () => {
  const SELF = '20000000-0000-4000-8000-000000000001';
  const MIGRATION = '00000000-0000-4000-8000-00000000a002';
  const NOW = '2026-10-30T12:00:00.000Z';
  const members: AssignableMember[] = [
    {
      membershipId: '30000000-0000-4000-8000-000000000001',
      actorId: SELF,
      displayName: 'Takib',
      roles: ['owner'],
      isSelf: true,
    },
  ];
  const lead: LeadDetail = {
    id: '90000000-0000-4000-8000-000000000001',
    workspaceId: '10000000-0000-4000-8000-000000000001',
    leadType: 'sim_order',
    status: 'submitted',
    stage: 'pending',
    contact: {},
    contactId: null,
    assignedActorId: null,
    externalRef: null,
    source: 'direct',
    attribution: {},
    consentVersion: null,
    openTaskCount: 0,
    nextTaskDueAt: null,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    form: null,
  };
  const entry = (id: string, rest: Record<string, unknown>) => ({
    id: `92000000-0000-4000-8000-${id.padStart(12, '0')}`,
    actorId: SELF,
    createdAt: NOW,
    kind: 'system' as const,
    event: 'unknown' as const,
    ...rest,
  });

  function timeline(activities: readonly LeadActivity[]) {
    render(
      <LeadTimeline
        lead={lead}
        activities={activities}
        members={members}
        canWrite={false}
        accessToken="staff-token"
        workspaceSlug="getcanadasim"
        onNoteAdded={vi.fn()}
      />,
    );
    return screen.getByRole('region', { name: 'Timeline' });
  }

  it('says archived and restored, never trash', () => {
    const region = timeline([entry('2', { event: 'restored' }), entry('1', { event: 'trashed' })]);
    expect(within(region).getByText('archived this')).toBeTruthy();
    expect(within(region).getByText('restored this')).toBeTruthy();
    expect(region.textContent ?? '').not.toMatch(/trash/i);
  });

  it('shows what a data migration changed, in its own words', () => {
    // The body a migration entry carries (the phase 3 stage clean-up).
    const migrated = leadActivitySchema.parse(
      entry('3', {
        actorId: MIGRATION,
        body: 'Stage Paid became Pending; payment status set to Paid (phase 3 migration)',
      }),
    );
    const region = timeline([migrated]);
    expect(
      within(region).getByText(
        'Stage Paid became Pending; payment status set to Paid (phase 3 migration)',
      ),
    ).toBeTruthy();
  });

  it('names the order fields an edit changed', () => {
    const region = timeline([
      {
        id: '92000000-0000-4000-8000-000000000004',
        actorId: SELF,
        createdAt: NOW,
        kind: 'edit',
        fields: ['plan', 'quantity', 'paymentStatus', 'carrierCommission'],
      },
    ]);
    expect(
      within(region).getByText(
        'corrected the plan, quantity, payment status and carrier commission',
      ),
    ).toBeTruthy();
  });

  it('keeps a label’s capitals after its first letter, and joins three or more with "and"', () => {
    const region = timeline([
      {
        id: '92000000-0000-4000-8000-000000000014',
        actorId: SELF,
        createdAt: NOW,
        kind: 'edit',
        fields: ['arrivalDate', 'simNumber', 'permitType'],
      },
    ]);
    expect(
      within(region).getByText(
        'corrected the arrival in Canada, SIM number and visa / permit type',
      ),
    ).toBeTruthy();
  });

  it('says the website submitted the order and it moved to Pending, with no staff name', () => {
    const region = timeline([
      leadActivitySchema.parse(
        entry('15', { actorId: '30000000-0000-4000-8000-0000000000aa', event: 'submitted' }),
      ),
    ]);
    const [first] = within(region).getAllByRole('listitem');
    expect(first?.textContent).toContain('Submitted on the website and moved to Pending');
    expect(first?.textContent).not.toContain('Former teammate');
  });

  it('names the document a review approved or rejected', () => {
    const region = timeline([
      {
        id: '92000000-0000-4000-8000-000000000005',
        actorId: SELF,
        createdAt: NOW,
        kind: 'document',
        fileId: '50000000-0000-4000-8000-000000000011',
        documentType: 'passport',
        decision: 'approved',
      },
      {
        id: '92000000-0000-4000-8000-000000000006',
        actorId: SELF,
        createdAt: NOW,
        kind: 'document',
        fileId: '50000000-0000-4000-8000-000000000012',
        documentType: 'visa',
        decision: 'rejected',
      },
    ]);
    expect(within(region).getByText('approved the passport')).toBeTruthy();
    expect(within(region).getByText('rejected the visa or approval letter')).toBeTruthy();
  });

  it('says an order moved on without its documents, and why', () => {
    const override = leadActivitySchema.parse(
      entry('7', {
        event: 'documents_override',
        missing: ['passport', 'visa'],
        reason: 'Customer sent them by email',
      }),
    );
    const region = timeline([override]);
    expect(
      within(region).getByText(
        'moved on without approved documents: Passport, Visa. Reason: Customer sent them by email',
      ),
    ).toBeTruthy();
  });

  it('says which email an automation queued, at which version, linked to Automations', () => {
    const queued = leadActivitySchema.parse(
      entry('8', {
        event: 'customer_emailed',
        template: 'dispatched',
        templateVersion: 3,
        automation: 'sim_order_dispatched',
      }),
    );
    const byHand = leadActivitySchema.parse(
      entry('9', { event: 'customer_emailed', template: 'sim_number_ready' }),
    );
    const region = timeline([queued, byHand]);
    const [first, second] = within(region).getAllByRole('listitem');
    expect(first?.textContent).toContain('Dispatched email queued by an automation (version 3)');
    expect(first?.textContent).not.toContain('You');
    expect(within(first!).getByRole('link', { name: 'an automation' }).getAttribute('href')).toBe(
      '/w/getcanadasim/automations',
    );
    expect(second?.textContent).toContain('You emailed the customer their SIM number');
  });

  describe('change requests made through the CRM', () => {
    const SITE = '30000000-0000-4000-8000-0000000000aa';
    const crm = (event: string, requestNo: number, extra: Record<string, unknown> = {}) =>
      leadActivitySchema.parse(
        entry(`${event === 'change_requested' ? 'e' : 'f'}${requestNo}`, {
          actorId: SITE,
          event,
          requestNo,
          changeRequestId: 'c0000000-0000-4000-8000-000000000001',
          ...extra,
        }),
      );

    it('says the customer asked, naming the fields, without a staff name', () => {
      const region = timeline([
        crm('change_requested', 70, { fields: ['phone', 'arrivalDate'], documents: [] }),
      ]);
      const [first] = within(region).getAllByRole('listitem');
      expect(first?.textContent).toContain(
        'The customer asked to change the phone and arrival in Canada (request #70)',
      );
      expect(first?.textContent).not.toContain('Former teammate');
    });

    it('names a plan and a new document', () => {
      const region = timeline([
        crm('change_requested', 71, { fields: ['planId', 'fullName'], documents: ['passport'] }),
      ]);
      expect(within(region).getAllByRole('listitem')[0]?.textContent).toContain(
        'The customer asked to change the plan and name, and sent a new passport (request #71)',
      );
    });

    it('says who approved or rejected it', () => {
      const region = timeline([
        crm('change_rejected', 71, { actorId: SELF }),
        crm('change_approved', 70, { actorId: SELF }),
      ]);
      const [rejected, approved] = within(region).getAllByRole('listitem');
      expect(rejected?.textContent).toContain("You rejected the customer's change request #71");
      expect(approved?.textContent).toContain("You approved the customer's change request #70");
    });
  });
});
