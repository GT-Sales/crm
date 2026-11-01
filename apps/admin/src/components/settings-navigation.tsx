'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  SlidersHorizontalIcon,
  ShapesIcon,
  MailIcon,
  LayersIcon,
  ActivityIcon,
} from 'lucide-react';
import { cn } from '@gt-sales/ui';

const sections = [
  { path: '', label: 'General', icon: SlidersHorizontalIcon },
  { path: '/properties', label: 'Properties and record layouts', icon: ShapesIcon },
  { path: '/plans', label: 'Plans', icon: LayersIcon },
  { path: '/email', label: 'Email', icon: MailIcon },
  { path: '/jobs', label: 'Background jobs', icon: ActivityIcon },
];

export function SettingsNavigation({ workspaceSlug }: { workspaceSlug: string }) {
  const pathname = usePathname();
  const base = `/w/${workspaceSlug}/settings`;
  return (
    <nav
      aria-label="Settings sections"
      className="flex gap-1 overflow-x-auto border-b pb-3 lg:w-52 lg:shrink-0 lg:flex-col lg:overflow-visible lg:border-0 lg:pb-0"
    >
      {sections.map(({ path, label, icon: Icon }) => {
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
