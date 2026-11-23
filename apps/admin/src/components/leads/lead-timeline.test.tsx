import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  leadActivitySchema,
  type AssignableMember,
  type LeadActivity,
  type LeadDetail,
} from '@gt-sales/contracts';

import { dateTimeLabel } from '../../lib/dates';
import {
  changeRequestText,
  groupByDay,
  LeadTimeline,
  pendingChangeRequest,
  timelineDayLabel,
} from './lead-timeline';

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

  it('labels confirmed AI changes with the approving member, including other staff', () => {
    const other = '20000000-0000-4000-8000-000000000002';
    render(
      <LeadTimeline
        lead={lead}
        activities={[
          leadActivitySchema.parse(entry('30', { kind: 'edit', fields: ['phone'], viaAi: true })),
          leadActivitySchema.parse(
            entry('31', { kind: 'assignment', from: null, to: SELF, actorId: other, viaAi: true }),
          ),
        ]}
        members={[
          ...members,
          {
            membershipId: '30000000-0000-4000-8000-000000000002',
            actorId: other,
            displayName: 'Sam',
            roles: ['leads'],
            isSelf: false,
          },
        ]}
        canWrite={false}
        accessToken="staff-token"
        workspaceSlug="canadawide"
        onNoteAdded={vi.fn()}
      />,
    );
    const items = screen.getByRole('region', { name: 'Timeline' }).querySelectorAll('li');
    expect(items[0]?.textContent).toContain('Takib · via Ask AI');
    expect(items[1]?.textContent).toContain('Sam · via Ask AI');
  });

  it('keeps ordinary and automation-written changes separate from AI assistance', () => {
    const region = timeline([
      leadActivitySchema.parse(entry('32', { kind: 'edit', fields: ['phone'] })),
      leadActivitySchema.parse(
        entry('33', {
          kind: 'edit',
          fields: ['phone'],
          automation: 'flow_0123456789abcdef',
          automationName: 'Follow-up flow',
        }),
      ),
    ]);
    expect(within(region).queryByText(/via Ask AI/)).toBeNull();
    expect(within(region).getByText('Follow-up flow')).toBeTruthy();
  });

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

  // Issue #87: the customer's own changes to an unfinished checkout, with what they filled in.
  describe('a customer’s draft save', () => {
    const WEBSITE = '30000000-0000-4000-8000-0000000000aa';
    const saved = (rest: Record<string, unknown>) =>
      leadActivitySchema.parse(entry('40', { actorId: WEBSITE, event: 'draft_saved', ...rest }));

    it('says the customer changed the fields, with no staff name, and lists each new value', () => {
      const region = timeline([
        saved({
          fields: ['phone', 'delivery', 'shippingAddress', 'flightBooked', 'plan'],
          values: [
            { key: 'phone', value: '+1 403 555 0100' },
            { key: 'delivery', value: 'pickup' },
            { key: 'shippingAddress', value: '22 Second Avenue\nCalgary AB' },
            { key: 'flightBooked', value: 'Yes' },
            { key: 'plan', value: 'Rogers 60GB' },
          ],
        }),
      ]);
      const [first] = within(region).getAllByRole('listitem');
      if (!first) throw new Error('expected an entry');
      expect(first.textContent).toContain(
        'The customer changed the phone, SIM type, shipping address, flight booked and plan on their unfinished checkout',
      );
      expect(first.textContent).not.toContain('Former teammate');
      const values = within(first).getByRole('group', { name: 'What the customer entered' });
      const rows = within(values)
        .getAllByRole('term')
        .map((term) => [term.textContent, term.nextElementSibling?.textContent]);
      expect(rows).toEqual([
        ['Phone', '+1 403 555 0100'],
        // A choice reads by its label, as the record shows it.
        ['SIM type', 'Physical SIM (mailed)'],
        ['Shipping address', '22 Second Avenue\nCalgary AB'],
        ['Flight booked', 'Yes'],
        ['Plan', 'Rogers 60GB'],
      ]);
      // A long or many-line value wraps inside the entry rather than widening the page.
      const address = within(values).getByText(/22 Second Avenue/);
      expect(address.className).toContain('whitespace-pre-wrap');
      expect(address.className).toContain('break-words');
    });

    it('marks a value that was cut short and one the customer cleared', () => {
      const region = timeline([
        saved({
          fields: ['canadaAddress', 'reference'],
          values: [
            { key: 'canadaAddress', value: 'x'.repeat(300), cut: true },
            { key: 'reference', value: '' },
          ],
        }),
      ]);
      const values = within(region).getByRole('group', { name: 'What the customer entered' });
      const [long, cleared] = within(values).getAllByRole('definition');
      expect(long?.textContent).toBe(`${'x'.repeat(300)}…`);
      expect(long?.getAttribute('title')).toBe(
        'Cut short: only the first 300 characters are kept.',
      );
      expect(cleared?.textContent).toBe('Cleared');
    });

    it('names the fields alone when no value is kept (a sensitive field, or erased data)', () => {
      const region = timeline([saved({ fields: ['dateOfBirth', 'email'] })]);
      const [first] = within(region).getAllByRole('listitem');
      expect(first?.textContent).toContain(
        'The customer changed the date of birth and email on their unfinished checkout',
      );
      expect(within(region).queryByRole('group', { name: 'What the customer entered' })).toBeNull();
    });
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
      '/w/getcanadasim/automations/sim_order_dispatched',
    );
    expect(second?.textContent).toContain('You emailed the customer their SIM number');
  });

  it('says a staff move submitted a checkout the customer never finished', () => {
    const rescued = leadActivitySchema.parse(entry('c', { event: 'submitted' }));
    const region = timeline([rescued]);
    const [first] = within(region).getAllByRole('listitem');
    expect(first?.textContent).toContain('You submitted this checkout for the customer');
    expect(first?.textContent).not.toContain('on the website');
  });

  it('names a site-made template a flow sent by its name', () => {
    const queued = leadActivitySchema.parse(
      entry('a', {
        event: 'customer_emailed',
        template: 'tpl_abcdefghij012345',
        templateName: 'Welcome note',
        templateVersion: 2,
        automation: 'flow_abcdefghij012345',
        automationName: 'Follow up new orders',
      }),
    );
    const region = timeline([queued]);
    const [first] = within(region).getAllByRole('listitem');
    expect(first?.textContent).toContain('Welcome note email queued by an automation (version 2)');
    expect(within(first!).getByRole('link', { name: 'an automation' }).getAttribute('href')).toBe(
      '/w/getcanadasim/automations/flow_abcdefghij012345',
    );
  });

  it('says a flow made a move, by its name, linked to the flow', () => {
    const moved = leadActivitySchema.parse({
      id: '92000000-0000-4000-8000-00000000000b',
      actorId: SELF,
      createdAt: NOW,
      kind: 'status_change',
      from: 'pending',
      to: 'verified',
      automation: 'flow_abcdefghij012345',
      automationName: 'Follow up new orders',
    });
    const region = timeline([moved]);
    const [first] = within(region).getAllByRole('listitem');
    expect(first?.textContent).toContain(
      'moved this from Pending to Verified by automation Follow up new orders',
    );
    // The member who activated the flow is not named as having made the move.
    expect(first?.textContent).not.toContain('You');
    expect(
      within(first!).getByRole('link', { name: 'Follow up new orders' }).getAttribute('href'),
    ).toBe('/w/getcanadasim/automations/flow_abcdefghij012345');
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

describe('timeline days', () => {
  // Local noon, so the day never depends on the machine's time zone.
  const now = new Date(2026, 10, 20, 12, 0);
  const at = (month: number, day: number, hour = 12, year = 2026) =>
    new Date(year, month, day, hour).toISOString();

  it('names a day Today, Yesterday, or by its date with the year only when it is another year', () => {
    expect(timelineDayLabel(at(10, 20, 0), now)).toBe('Today');
    expect(timelineDayLabel(at(10, 20, 23), now)).toBe('Today');
    expect(timelineDayLabel(at(10, 19, 23), now)).toBe('Yesterday');
    const older = timelineDayLabel(at(9, 26), now);
    expect(older).toBe(
      new Date(at(9, 26)).toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      }),
    );
    expect(older).not.toMatch(/2026/);
    expect(timelineDayLabel(at(11, 31, 12, 2025), now)).toMatch(/2025/);
  });

  it('cuts entries into runs of one day, keeping their order', () => {
    const entries = [
      { id: 'a', createdAt: at(10, 20, 11) },
      { id: 'b', createdAt: at(10, 20, 9) },
      { id: 'c', createdAt: at(10, 19, 18) },
      { id: 'd', createdAt: at(9, 2) },
      { id: 'e', createdAt: at(9, 1) },
    ];
    const groups = groupByDay(entries, now);
    expect(groups.map((group) => group.label)).toEqual([
      'Today',
      'Yesterday',
      timelineDayLabel(at(9, 2), now),
      timelineDayLabel(at(9, 1), now),
    ]);
    expect(groups.flatMap((group) => group.entries.map((entry) => entry.id))).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
  });
});

describe('the timeline grouped by day', () => {
  const SELF = '20000000-0000-4000-8000-000000000001';
  const today = new Date();
  const todayAt = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 30);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, 15);
  const lead: LeadDetail = {
    id: '90000000-0000-4000-8000-000000000001',
    workspaceId: '10000000-0000-4000-8000-000000000001',
    leadType: 'internet',
    status: 'submitted',
    stage: 'new',
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
    createdAt: '2025-03-04T12:00:00.000Z',
    updatedAt: '2025-03-04T12:00:00.000Z',
    form: null,
  };
  const note = (id: string, createdAt: Date, body: string) =>
    leadActivitySchema.parse({
      id: `92000000-0000-4000-8000-${id.padStart(12, '0')}`,
      actorId: SELF,
      createdAt: createdAt.toISOString(),
      kind: 'note',
      body,
    });

  function renderTimeline() {
    render(
      <LeadTimeline
        lead={lead}
        activities={[note('1', todayAt, 'Called back'), note('2', yesterday, 'Left a voicemail')]}
        members={[
          {
            membershipId: '30000000-0000-4000-8000-000000000001',
            actorId: SELF,
            displayName: 'Takib',
            roles: ['owner'],
            isSelf: true,
          },
        ]}
        canWrite={false}
        accessToken="staff-token"
        workspaceSlug="canadawide"
        onNoteAdded={vi.fn()}
      />,
    );
    return screen.getByRole('region', { name: 'Timeline' });
  }

  it('puts the entries under Today, Yesterday and the date, newest first as before', () => {
    const region = renderTimeline();
    const days = within(region).getAllByRole('heading', { level: 3 });
    expect(days.map((day) => day.textContent)).toEqual([
      'Today',
      'Yesterday',
      timelineDayLabel(lead.createdAt),
    ]);
    expect(within(region).getByRole('list', { name: 'Today' }).textContent).toContain(
      'Called back',
    );
    expect(within(region).getByRole('list', { name: 'Yesterday' }).textContent).toContain(
      'Left a voicemail',
    );
    const items = within(region).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Called back'),
      expect.stringContaining('Left a voicemail'),
      expect.stringContaining('Website sent this lead'),
    ]);
  });

  it('shows the time of day on entries before today, as the day heading already names the date', () => {
    const region = renderTimeline();
    const older = [...region.querySelectorAll('time')].find(
      (time) => time.getAttribute('datetime') === yesterday.toISOString(),
    );
    if (!older) throw new Error('expected yesterday’s entry');
    expect(older.textContent).toBe(
      yesterday.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
    );
  });

  it('shows how long ago only, with the full date and time on focus and in the markup', async () => {
    const region = renderTimeline();
    const times = region.querySelectorAll('time');
    expect(times).toHaveLength(3);
    const first = times[0];
    if (!first) throw new Error('expected a time');
    expect(first.getAttribute('datetime')).toBe(todayAt.toISOString());
    // The relative time alone: the absolute date is no longer repeated on every entry.
    expect(first.textContent).not.toContain(dateTimeLabel(todayAt.toISOString()));
    expect(first.textContent).toMatch(/ago|just now/);
    expect(first.tabIndex).toBe(0);
    fireEvent.focus(first);
    expect((await screen.findByRole('tooltip')).textContent).toContain(
      dateTimeLabel(todayAt.toISOString()),
    );
  });
});
