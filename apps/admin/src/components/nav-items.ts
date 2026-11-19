import {
  ChartNoAxesColumnIcon,
  LayoutDashboardIcon,
  ListTodoIcon,
  MailIcon,
  SettingsIcon,
  UsersIcon,
  ZapIcon,
  type LucideIcon,
} from 'lucide-react';

import { ASK_AI_NAV_ITEM } from './ai/chat-nav';

/** A page entry, as the sidebar, the top bar and Ctrl/Cmd K list them. */
export interface NavEntry {
  readonly section: string;
  readonly label: string;
  readonly icon: LucideIcon;
}

/**
 * Only sections that exist. Orders, partners and finance arrive with
 * the phases that port them (docs/PLAN.md §7); a link to a missing page is a
 * 404, not a placeholder. The sidebar links to these and the top bar names the
 * current one. Ask AI is not here: it appears only when the backend stores
 * conversations (`ASK_AI_NAV_ITEM`, placed by `mainNavGroups`).
 */
export const NAV_ITEMS = [
  { section: 'dashboard', label: 'Dashboard', icon: LayoutDashboardIcon },
  { section: 'leads', label: 'Leads', icon: UsersIcon },
  { section: 'tasks', label: 'My tasks', icon: ListTodoIcon },
  { section: 'mail', label: 'Mail', icon: MailIcon },
  { section: 'analytics', label: 'Analytics', icon: ChartNoAxesColumnIcon },
  { section: 'automations', label: 'Automations', icon: ZapIcon },
  { section: 'settings', label: 'Settings', icon: SettingsIcon },
] as const satisfies readonly NavEntry[];

export interface NavGroup<Item> {
  readonly id: string;
  /** Absent for the first group, which has no heading. */
  readonly label?: string;
  readonly items: readonly Item[];
}

/** The sections of each main-sidebar group, in order ('chat' is Ask AI). */
const MAIN_LAYOUT: readonly { id: string; label?: string; sections: readonly string[] }[] = [
  { id: 'home', sections: ['dashboard', 'chat'] },
  { id: 'work', label: 'Work', sections: ['leads', 'tasks', 'mail'] },
  { id: 'insights', label: 'Insights', sections: ['analytics'] },
  { id: 'setup', label: 'Setup', sections: ['automations', 'settings'] },
];

/**
 * The main sidebar's groups. Ask AI keeps its rule (`askAi`: shown only when
 * the backend stores conversations); a group with nothing to show is dropped,
 * so no heading is left over an empty list.
 */
export function mainNavGroups(askAi: boolean): readonly NavGroup<NavEntry>[] {
  const entries: readonly NavEntry[] = askAi ? [...NAV_ITEMS, ASK_AI_NAV_ITEM] : NAV_ITEMS;
  return MAIN_LAYOUT.map(({ id, label, sections }) => ({
    id,
    label,
    items: sections.flatMap((section) => entries.filter((entry) => entry.section === section)),
  })).filter((group) => group.items.length > 0);
}

/** The pages in menu order: what Ctrl/Cmd K lists. */
export function mainNavEntries(askAi: boolean): readonly NavEntry[] {
  return mainNavGroups(askAi).flatMap((group) => group.items);
}
