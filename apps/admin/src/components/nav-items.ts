import {
  FileTextIcon,
  LayoutDashboardIcon,
  ListTodoIcon,
  SettingsIcon,
  UsersIcon,
  ZapIcon,
} from 'lucide-react';

/**
 * Only sections that exist. Orders, partners, finance and reports arrive with
 * the phases that port them (docs/PLAN.md §7); a link to a missing page is a
 * 404, not a placeholder. The sidebar links to these and the top bar names the
 * current one.
 */
export const NAV_ITEMS = [
  { section: 'dashboard', label: 'Dashboard', icon: LayoutDashboardIcon },
  { section: 'leads', label: 'Leads', icon: UsersIcon },
  { section: 'tasks', label: 'My tasks', icon: ListTodoIcon },
  { section: 'documents', label: 'Documents', icon: FileTextIcon },
  { section: 'automations', label: 'Automations', icon: ZapIcon },
  { section: 'settings', label: 'Settings', icon: SettingsIcon },
] as const;
