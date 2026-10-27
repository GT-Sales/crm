import { describe, expect, it } from 'vitest';
import { LEGACY_IMPORT_ACTOR_ID, type AssignableMember } from '@gt-sales/contracts';

import {
  countdown,
  dayLabel,
  dueLabel,
  dueSentence,
  dueTone,
  followUpLabel,
  relativeTime,
  todayDay,
} from '../../lib/dates';
import { actorName, assigneeName, initials, memberName } from '../../lib/people';
import { inboxSearch, parseInboxQuery } from './inbox-query';
import { formFields } from './lead-fields';

const SELF = '20000000-0000-4000-8000-000000000001';
const OTHER = '20000000-0000-4000-8000-000000000002';

const self: AssignableMember = {
  membershipId: '30000000-0000-4000-8000-000000000001',
  actorId: SELF,
  displayName: 'Takib',
  roles: ['owner'],
  isSelf: true,
};
const colleague: AssignableMember = {
  membershipId: '30000000-0000-4000-8000-000000000002',
  actorId: OTHER,
  displayName: null,
  roles: ['leads'],
  isSelf: false,
};
const members = [self, colleague];

describe('inbox query', () => {
  it('round-trips through the URL', () => {
    const query = parseInboxQuery(
      new URLSearchParams('type=internet&view=board&assignee=me&q=avery&page=3'),
    );
    expect(query).toEqual({
      type: 'internet',
      trash: false,
      due: false,
      view: 'board',
      stage: undefined,
      assignee: 'me',
      q: 'avery',
      page: 3,
    });
    expect(inboxSearch(query)).toBe('?type=internet&view=board&assignee=me&q=avery&page=3');
  });

  it('keeps the follow-ups due filter in the URL, as a table and never in the trash', () => {
    const due = parseInboxQuery(new URLSearchParams('type=sim_order&view=board&due=1'));
    expect(due).toMatchObject({ type: 'sim_order', due: true, view: 'table' });
    expect(inboxSearch(due)).toBe('?type=sim_order&due=1');
    expect(parseInboxQuery(new URLSearchParams('trash=1&due=1')).due).toBe(false);
    expect(parseInboxQuery(new URLSearchParams('due=yes')).due).toBe(false);
  });

  it('drops values the backend would refuse and keeps the board to one type', () => {
    const query = parseInboxQuery(
      new URLSearchParams('type=Not+A+Type&view=board&assignee=someone&page=-2&stage=won'),
    );
    expect(query).toMatchObject({ type: undefined, view: 'table', assignee: undefined, page: 1 });
    expect(query.stage).toBeUndefined();
    expect(parseInboxQuery(new URLSearchParams('trash=1&type=internet')).type).toBeUndefined();
  });
});

describe('dates', () => {
  const now = new Date(2026, 9, 26, 15, 0, 0);

  it('reads a due date by its calendar day, whatever the time zone', () => {
    expect(todayDay(now)).toBe('2026-10-26');
    expect(dueTone('2026-10-25T12:00:00.000Z', now)).toBe('overdue');
    expect(dueTone('2026-10-26T12:00:00.000Z', now)).toBe('today');
    expect(dueTone('2026-10-27T12:00:00.000Z', now)).toBe('upcoming');
    expect(dueLabel('2026-10-27T12:00:00.000Z', now)).toBe('Tomorrow');
    expect(dueSentence('2026-10-25T12:00:00.000Z', now)).toBe('Due yesterday');
  });

  it('says how long ago in the units staff read at a glance', () => {
    const at = now.getTime();
    expect(relativeTime(new Date(at - 20_000).toISOString(), at)).toBe('just now');
    expect(relativeTime(new Date(at - 5 * 60_000).toISOString(), at)).toBe('5m ago');
    expect(relativeTime(new Date(at - 3 * 3_600_000).toISOString(), at)).toBe('3h ago');
    expect(relativeTime(new Date(at - 2 * 86_400_000).toISOString(), at)).toBe('2d ago');
  });

  it('says a follow-up’s state as Get Canada Sim’s admin does', () => {
    expect(followUpLabel('2026-10-26T12:00:00.000Z', now)).toBe('Due today');
    expect(followUpLabel('2026-10-25T12:00:00.000Z', now)).toBe('Overdue by 1 day');
    expect(followUpLabel('2026-10-20T12:00:00.000Z', now)).toBe('Overdue by 6 days');
    expect(followUpLabel('2026-10-27T12:00:00.000Z', now)).toBe('Due tomorrow');
  });

  it('counts down to a day, and stops once it has passed', () => {
    expect(countdown('2026-10-26', now)).toEqual({ label: 'Today', tone: 'today' });
    expect(countdown('2026-10-27', now)).toEqual({ label: '1 day left', tone: 'soon' });
    expect(countdown('2026-11-02', now)).toEqual({ label: '7 days left', tone: 'soon' });
    expect(countdown('2026-11-03', now)).toEqual({ label: '8 days left', tone: 'upcoming' });
    expect(countdown('2026-10-25', now)).toBeUndefined();
    expect(countdown('soon', now)).toBeUndefined();
    expect(dayLabel('2026-11-02', now)).toMatch(/Nov/);
    expect(dayLabel('2027-01-05', now)).toMatch(/2027/);
  });
});

describe('people', () => {
  it('names a member by the name they chose, or their role', () => {
    expect(memberName(self)).toBe('Takib');
    expect(memberName(colleague)).toBe('Unnamed leads');
    expect(actorName(SELF, members)).toBe('You');
    expect(actorName(LEGACY_IMPORT_ACTOR_ID, members)).toBe('Old admin');
    expect(actorName('20000000-0000-4000-8000-0000000000ff', members)).toBe('Former teammate');
    expect(assigneeName(SELF, members)).toBe('Takib (you)');
    expect(assigneeName(null, members)).toBeUndefined();
    expect(initials('Takib (you)')).toBe('T');
    expect(initials('Avery Jane Example')).toBe('AE');
  });
});

describe('form fields', () => {
  it('shows a modelled type in order, formatted, with unknown keys after', () => {
    expect(
      formFields('mobility', {
        postalCode: 'T2P 1J9',
        planLabel: '100 GB $40',
        keepNumber: false,
        simType: 'esim',
        lineCount: 2,
        aptUnit: '',
        newField: 'kept',
      }),
    ).toEqual([
      { label: 'Plan', value: '100 GB $40' },
      { label: 'Lines', value: '2' },
      { label: 'SIM', value: 'eSIM' },
      { label: 'Keep current number', value: 'No' },
      { label: 'Postal code', value: 'T2P 1J9' },
      { label: 'New field', value: 'kept' },
    ]);
  });

  it('marks the type’s countdown field with the day it counts down to', () => {
    expect(
      formFields('sim_order', { planId: '75gb-fido', arrivalDate: '2026-11-02', gotVisa: true }),
    ).toEqual([
      { label: 'Plan', value: '75GB · $35, Fido' },
      {
        label: 'Arrival in Canada',
        value: expect.stringMatching(/2026/),
        countdownDay: '2026-11-02',
      },
      { label: 'Has the visa', value: 'Yes' },
    ]);
  });

  it('labels an unmodelled type from its keys', () => {
    expect(formFields('contact_message', { message_body: 'Hello', urgent: true })).toEqual([
      { label: 'Message body', value: 'Hello' },
      { label: 'Urgent', value: 'Yes' },
    ]);
  });
});
