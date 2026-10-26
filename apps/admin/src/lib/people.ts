import { LEGACY_IMPORT_ACTOR_ID, type AssignableMember } from '@gt-sales/contracts';
import type { StaffRoleName } from '@gt-sales/types';

/**
 * How staff appear to each other: the name a member chose for themselves
 * (Settings → Your name), or their role until they choose one. The members
 * list never carries an email, so neither does anything shown here.
 */

export const ROLE_LABELS: Record<StaffRoleName, string> = {
  owner: 'Owner',
  leads: 'Leads',
  orders: 'Orders',
  partners: 'Partners',
  finance: 'Finance',
  content: 'Content',
  viewer: 'Viewer',
};

export function memberName(member: AssignableMember): string {
  if (member.displayName) return member.displayName;
  const role = member.roles[0];
  return role ? `Unnamed ${ROLE_LABELS[role].toLowerCase()}` : 'Unnamed teammate';
}

/** The person behind a timeline entry or a task, as the viewer reads it. */
export function actorName(actorId: string, members: readonly AssignableMember[]): string {
  if (actorId === LEGACY_IMPORT_ACTOR_ID) return 'Old admin';
  const member = members.find((entry) => entry.actorId === actorId);
  if (!member) return 'Former teammate';
  return member.isSelf ? 'You' : memberName(member);
}

/** The assignee column: the member's name, `You` for the viewer, or a former teammate. */
export function assigneeName(
  actorId: string | null,
  members: readonly AssignableMember[],
): string | undefined {
  if (actorId === null) return undefined;
  const member = members.find((entry) => entry.actorId === actorId);
  if (!member) return 'Former teammate';
  return member.isSelf ? `${memberName(member)} (you)` : memberName(member);
}

export function initials(name: string): string {
  const words = name
    .replace(/\(.*?\)/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const letters = (words.length > 1 ? [words[0], words[words.length - 1]] : words.slice(0, 1))
    .map((word) => word?.[0] ?? '')
    .join('');
  return letters.toUpperCase() || '?';
}
