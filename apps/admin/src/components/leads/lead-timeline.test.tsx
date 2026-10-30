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
      within(region).getByText('corrected the plan, quantity, payment status, carrier commission'),
    ).toBeTruthy();
  });
});
