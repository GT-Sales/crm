import type { AiConversation } from '@gt-sales/contracts';

export type ConversationGroupLabel = 'Today' | 'Yesterday' | 'Previous 7 days' | 'Older';

export interface ConversationGroup {
  label: ConversationGroupLabel;
  items: readonly AiConversation[];
}

/** Local midnight `days` days before `now`'s day (a calendar step, so a DST change is no hour off). */
function startOfDay(now: Date, days: number): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - days).getTime();
}

/**
 * The list's groups by each conversation's last message, in the viewer's own
 * time zone: today, yesterday, the seven days before that, and older. Order
 * within a group is kept (the server's newest first); empty groups are left
 * out. A time in the future (a skewed clock) counts as today.
 */
export function groupConversations(
  items: readonly AiConversation[],
  now: Date = new Date(),
): ConversationGroup[] {
  const today = startOfDay(now, 0);
  const yesterday = startOfDay(now, 1);
  const week = startOfDay(now, 8);
  const groups: Record<ConversationGroupLabel, AiConversation[]> = {
    Today: [],
    Yesterday: [],
    'Previous 7 days': [],
    Older: [],
  };
  for (const item of items) {
    const at = Date.parse(item.lastMessageAt);
    const label: ConversationGroupLabel = !Number.isFinite(at)
      ? 'Older'
      : at >= today
        ? 'Today'
        : at >= yesterday
          ? 'Yesterday'
          : at >= week
            ? 'Previous 7 days'
            : 'Older';
    groups[label].push(item);
  }
  return (['Today', 'Yesterday', 'Previous 7 days', 'Older'] as const)
    .map((label) => ({ label, items: groups[label] }))
    .filter((group) => group.items.length > 0);
}
