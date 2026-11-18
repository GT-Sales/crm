'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  SlidersHorizontalIcon,
  ShapesIcon,
  MailIcon,
  LayersIcon,
  ActivityIcon,
  UsersIcon,
  PlugIcon,
  SparklesIcon,
} from 'lucide-react';
import { cn } from '@gt-sales/ui';

import { useStaffSession } from './staff-session-provider';

const sections = [
  { path: '', label: 'General', icon: SlidersHorizontalIcon },
  { path: '/team', label: 'Team', icon: UsersIcon },
  { path: '/properties', label: 'Properties and record layouts', icon: ShapesIcon },
  { path: '/plans', label: 'Plans', icon: LayersIcon },
  { path: '/email', label: 'Email', icon: MailIcon },
  { path: '/integrations', label: 'Integrations', icon: PlugIcon },
  { path: '/jobs', label: 'Background jobs', icon: ActivityIcon },
  // Owner only: the page shows every member's usage, and the backend refuses anyone else.
  { path: '/ai-usage', label: 'AI usage', icon: SparklesIcon, ownerOnly: true },
];

export function SettingsNavigation({ workspaceSlug }: { workspaceSlug: string }) {
  const pathname = usePathname();
  const staff = useStaffSession();
  const isOwner =
    staff.workspaces.find((entry) => entry.slug === workspaceSlug)?.roles.includes('owner') ??
    false;
  const base = `/w/${workspaceSlug}/settings`;
  return (
    <nav
      aria-label="Settings sections"
      className="flex gap-1 overflow-x-auto border-b pb-3 lg:w-52 lg:shrink-0 lg:flex-col lg:overflow-visible lg:border-0 lg:pb-0"
    >
      {sections
        .filter((section) => !('ownerOnly' in section) || isOwner)
        .map(({ path, label, icon: Icon }) => {
          const active = path === '' ? pathname === base : pathname.startsWith(`${base}${path}`);
          return (
            <Link
              key={path}
              href={`${base}${path}`}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
                active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground',
              )}
            >
              <Icon className="size-4" />
              {label}
            </Link>
          );
        })}
    </nav>
  );
}
