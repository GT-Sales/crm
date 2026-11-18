import { describe, expect, it } from 'vitest';
import type { AiConversation } from '@gt-sales/contracts';

import { groupConversations } from './conversation-groups';

function conversation(id: number, lastMessageAt: Date): AiConversation {
  const at = lastMessageAt.toISOString();
  return {
    id: `c0000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    title: `Conversation ${id}`,
    createdAt: at,
    updatedAt: at,
    lastMessageAt: at,
  };
}

describe('groupConversations', () => {
  // Wednesday 18 November 2026, 09:30 in the viewer's own time zone.
  const now = new Date(2026, 10, 18, 9, 30);
  const local = (day: number, hour: number) => new Date(2026, 10, day, hour, 0);

  it('groups by the viewer’s calendar days: today, yesterday, the 7 days before, older', () => {
    const items = [
      conversation(1, local(18, 8)),
      conversation(2, local(18, 0)),
      conversation(3, local(17, 23)),
      conversation(4, local(17, 0)),
      conversation(5, local(16, 22)),
      conversation(6, local(10, 0)),
      conversation(7, local(9, 23)),
      conversation(8, new Date(2025, 0, 1)),
    ];
    expect(
      groupConversations(items, now).map((group) => [
        group.label,
        group.items.map((item) => item.title),
      ]),
    ).toEqual([
      ['Today', ['Conversation 1', 'Conversation 2']],
      ['Yesterday', ['Conversation 3', 'Conversation 4']],
      ['Previous 7 days', ['Conversation 5', 'Conversation 6']],
      ['Older', ['Conversation 7', 'Conversation 8']],
    ]);
  });

  it('leaves out empty groups and keeps the server’s order inside a group', () => {
    const groups = groupConversations(
      [conversation(2, local(15, 9)), conversation(1, local(16, 9))],
      now,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe('Previous 7 days');
    expect(groups[0]?.items.map((item) => item.title)).toEqual([
      'Conversation 2',
      'Conversation 1',
    ]);
  });

  it('counts a time ahead of the clock as today and an unreadable one as older', () => {
    const ahead = conversation(1, new Date(2026, 10, 18, 23, 59));
    const unreadable = { ...conversation(2, now), lastMessageAt: 'not a date' };
    expect(groupConversations([ahead, unreadable], now).map((group) => group.label)).toEqual([
      'Today',
      'Older',
    ]);
  });

  it('is empty for no conversations', () => {
    expect(groupConversations([], now)).toEqual([]);
  });
});
