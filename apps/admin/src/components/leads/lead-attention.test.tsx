import { fireEvent, render, screen } from '@testing-library/react';
import type { LeadDocument, LeadTask } from '@gt-sales/contracts';
import { describe, expect, it, vi } from 'vitest';

import { LeadAttentionStrip, leadAttention } from './lead-attention';

const NOW = new Date('2026-11-05T15:00:00Z');
const plan = {
  planId: '11111111-1111-4111-8111-111111111111',
  name: 'Rogers 60GB',
  priceMinor: 4000,
  currency: 'CAD' as const,
  billingPeriod: 'month' as const,
  paymentRequired: true,
  requiredDocuments: ['passport', 'visa'],
  properties: {},
  frozenAt: '2026-11-01T12:00:00.000Z',
};
const doc = (documentType: string, review: LeadDocument['review']): LeadDocument => ({
  id: `20000000-0000-4000-8000-00000000000${documentType.length}`,
  documentType,
  contentType: 'application/pdf',
  sizeBytes: 2048,
  revision: 1,
  createdAt: '2026-11-04T12:00:00.000Z',
  review,
});
const task = (dueAt: string | null, status: LeadTask['status'] = 'open'): LeadTask => ({
  id: '30000000-0000-4000-8000-000000000001',
  leadId: '40000000-0000-4000-8000-000000000001',
  title: 'Call',
  dueAt,
  assignedActorId: null,
  status,
  completedAt: null,
  createdBy: '50000000-0000-4000-8000-000000000001',
  createdAt: '2026-11-01T12:00:00.000Z',
  updatedAt: '2026-11-01T12:00:00.000Z',
});
const noDocuments: LeadDocument[] = [];
const noTasks: LeadTask[] = [];
const base = {
  lead: {
    leadType: 'sim_order',
    stage: 'pending',
    deletedAt: null,
    order: { plan, dispatchedAt: null },
  },
  formPayload: {},
  documents: noDocuments,
  tasks: noTasks,
  contacts: true,
  now: NOW,
};

describe('leadAttention', () => {
  it('lists a waiting change request, then each kind of document problem', () => {
    const items = leadAttention({
      ...base,
      changeRequestNo: 3,
      documents: [
        doc('passport', null),
        doc('work_permit', { decision: 'rejected', at: NOW.toISOString() }),
      ],
    });
    expect(items.map((item) => [item.label, item.target, item.tone])).toEqual([
      ['Change request #3 waiting', 'change-request', 'urgent'],
      ['Missing: visa', 'documents', 'urgent'],
      ['Rejected, needs a new upload: work permit', 'documents', 'warning'],
      ['Passport not reviewed', 'documents', 'warning'],
    ]);
  });

  it('says nothing about approved documents or a lead with no frozen plan', () => {
    expect(
      leadAttention({
        ...base,
        documents: [
          doc('passport', { decision: 'approved', at: NOW.toISOString() }),
          doc('visa', { decision: 'approved', at: NOW.toISOString() }),
        ],
      }),
    ).toEqual([]);
    expect(leadAttention({ ...base, lead: { ...base.lead, order: undefined } })).toEqual([]);
  });

  it('counts only open tasks due before today', () => {
    const items = leadAttention({
      ...base,
      lead: { ...base.lead, order: undefined },
      tasks: [
        task('2026-11-03T12:00:00.000Z'),
        task('2026-11-04T12:00:00.000Z'),
        task('2026-11-05T12:00:00.000Z'),
        task('2026-11-01T12:00:00.000Z', 'done'),
        task(null),
      ],
    });
    expect(items.map((item) => item.label)).toEqual(['2 tasks overdue']);
  });

  it('flags an arrival within a week only while the order is not dispatched', () => {
    const soon = {
      ...base,
      lead: { ...base.lead, order: undefined },
      formPayload: { arrivalDate: '2026-11-08' },
    };
    expect(leadAttention(soon).map((item) => item.label)).toEqual([
      'Arrival in Canada Nov 8 (3 days left), not dispatched',
    ]);
    expect(
      leadAttention({ ...soon, formPayload: { arrivalDate: '2026-11-05' } }).map((i) => i.label),
    ).toEqual(['Arrival in Canada today, not dispatched']);
    expect(
      leadAttention({
        ...soon,
        lead: { ...soon.lead, order: { plan: null, dispatchedAt: '2026-11-04' } },
      }),
    ).toEqual([]);
    expect(leadAttention({ ...soon, lead: { ...soon.lead, stage: 'cancelled' } })).toEqual([]);
    expect(leadAttention({ ...soon, formPayload: { arrivalDate: '2026-11-30' } })).toEqual([]);
  });

  it('hides requests and tasks from a member without contact access, and everything once archived', () => {
    const busy = { ...base, changeRequestNo: 1, tasks: [task('2026-11-01T12:00:00.000Z')] };
    expect(leadAttention({ ...busy, contacts: false }).map((item) => item.target)).toEqual([
      'documents',
    ]);
    expect(
      leadAttention({ ...busy, lead: { ...busy.lead, deletedAt: '2026-11-04T12:00:00.000Z' } }),
    ).toEqual([]);
  });
});

describe('LeadAttentionStrip', () => {
  it('renders nothing when nothing waits, and jumps to the card of the item pressed', () => {
    const { container } = render(<LeadAttentionStrip items={[]} onJump={() => {}} />);
    expect(container.innerHTML).toBe('');
    const onJump = vi.fn();
    render(
      <LeadAttentionStrip
        items={[
          {
            key: 'cr',
            label: 'Change request #1 waiting',
            target: 'change-request',
            tone: 'urgent',
          },
        ]}
        onJump={onJump}
      />,
    );
    const region = screen.getByRole('region', { name: 'Needs attention' });
    fireEvent.click(screen.getByRole('button', { name: 'Change request #1 waiting' }));
    expect(onJump).toHaveBeenCalledWith('change-request');
    expect(region).toBeTruthy();
  });
});
