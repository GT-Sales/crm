import {
  ActivityIcon,
  LayersIcon,
  MailIcon,
  PlugIcon,
  ShapesIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  UsersIcon,
  type LucideIcon,
} from 'lucide-react';

import type { NavGroup } from './nav-items';

export interface SettingsNavItem {
  /** Appended to /w/<workspace>/settings. */
  readonly path: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** The page shows every member's usage and the backend refuses anyone else. */
  readonly ownerOnly?: true;
}

const GENERAL: SettingsNavItem = { path: '', label: 'General', icon: SlidersHorizontalIcon };
const TEAM: SettingsNavItem = { path: '/team', label: 'Team', icon: UsersIcon };
const FIELDS: SettingsNavItem = {
  path: '/properties',
  label: 'Fields and layouts',
  icon: ShapesIcon,
};
const PLANS: SettingsNavItem = { path: '/plans', label: 'Plans', icon: LayersIcon };
const EMAIL: SettingsNavItem = { path: '/email', label: 'Email', icon: MailIcon };
const AI_USAGE: SettingsNavItem = {
  path: '/ai-usage',
  label: 'AI usage',
  icon: SparklesIcon,
  ownerOnly: true,
};
const INTEGRATIONS: SettingsNavItem = {
  path: '/integrations',
  label: 'Integrations',
  icon: PlugIcon,
};
const JOBS: SettingsNavItem = { path: '/jobs', label: 'Background jobs', icon: ActivityIcon };

const SETTINGS_LAYOUT: readonly NavGroup<SettingsNavItem>[] = [
  { id: 'workspace', label: 'Workspace', items: [GENERAL, TEAM] },
  { id: 'sales', label: 'Sales', items: [PLANS, FIELDS] },
  { id: 'communication', label: 'Communication', items: [EMAIL] },
  { id: 'ai', label: 'AI', items: [AI_USAGE] },
  { id: 'system', label: 'System', items: [INTEGRATIONS, JOBS] },
];

/**
 * The Settings sub-navigation for this person. An item keeps its own rule
 * (today only AI usage, owner only); a group whose items are all hidden is
 * dropped, so no heading is left over an empty list.
 */
export function settingsNavGroups({
  isOwner,
}: {
  isOwner: boolean;
}): readonly NavGroup<SettingsNavItem>[] {
  return SETTINGS_LAYOUT.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.ownerOnly || isOwner),
  })).filter((group) => group.items.length > 0);
}

/** Whether `pathname` is on this item's page (General is only the settings root). */
export function settingsItemActive(base: string, pathname: string, item: SettingsNavItem) {
  return item.path === '' ? pathname === base : pathname.startsWith(`${base}${item.path}`);
}
