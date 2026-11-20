import {
  ActivityIcon,
  BotIcon,
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
  /** Only the owner sees the page (AI usage, AI models); the backend refuses anyone else. */
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
/** The owner's choice of Ask AI's models; the backend refuses anyone else (the AI usage page's action). */
const AI_MODELS: SettingsNavItem = {
  path: '/ai-models',
  label: 'AI models',
  icon: BotIcon,
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
  { id: 'ai', label: 'AI', items: [AI_USAGE, AI_MODELS] },
  { id: 'system', label: 'System', items: [INTEGRATIONS, JOBS] },
];

/**
 * The Settings sub-navigation for this person. An item keeps its own rule
 * (today AI usage and AI models, owner only); a group whose items are all hidden is
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
