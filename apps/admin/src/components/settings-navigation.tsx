'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { NativeSelect } from '@gt-sales/ui';

import { useStaffSession } from './staff-session-provider';
import { settingsItemActive, settingsNavGroups } from './settings-nav-items';

/**
 * Settings sub-navigation: grouped links in a narrow column from the `lg`
 * breakpoint, a select with the same groups above that (a phone has no room
 * for a column). One landmark holds both; the one not shown is display:none.
 */
export function SettingsNavigation({ workspaceSlug }: { workspaceSlug: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const staff = useStaffSession();
  const isOwner =
    staff.workspaces.find((entry) => entry.slug === workspaceSlug)?.roles.includes('owner') ??
    false;
  const base = `/w/${workspaceSlug}/settings`;
  const groups = settingsNavGroups({ isOwner });
  const current = groups
    .flatMap((group) => group.items)
    .find((item) => settingsItemActive(base, pathname, item));

  return (
    <nav aria-label="Settings sections" className="lg:w-44 lg:shrink-0">
      <div className="lg:hidden">
        <label htmlFor="settings-section" className="sr-only">
          Settings section
        </label>
        <NativeSelect
          id="settings-section"
          value={current ? `${base}${current.path}` : ''}
          onChange={(event) => router.push(event.target.value)}
        >
          {current ? null : (
            <option value="" disabled>
              Choose a section
            </option>
          )}
          {groups.map((group) => (
            <optgroup key={group.id} label={group.label}>
              {group.items.map((item) => (
                <option key={item.path} value={`${base}${item.path}`}>
                  {item.label}
                </option>
              ))}
            </optgroup>
          ))}
        </NativeSelect>
      </div>
      <div className="hidden flex-col gap-4 lg:flex">
        {groups.map((group) => {
          const headingId = `settings-nav-${group.id}`;
          return (
            <div key={group.id} role="group" aria-labelledby={headingId}>
              <p
                id={headingId}
                className="flex h-8 items-center px-2 text-xs font-medium text-sidebar-foreground/70"
              >
                {group.label}
              </p>
              <ul className="flex flex-col gap-1">
                {group.items.map((item) => {
                  const active = settingsItemActive(base, pathname, item);
                  const Icon = item.icon;
                  return (
                    <li key={item.path}>
                      <Link
                        href={`${base}${item.path}`}
                        aria-current={active ? 'page' : undefined}
                        data-active={active}
                        className="flex h-8 w-full items-center gap-2 whitespace-nowrap rounded-md p-2 text-sm outline-hidden ring-sidebar-ring transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground [&>svg]:size-4 [&>svg]:shrink-0"
                      >
                        <Icon aria-hidden="true" />
                        <span className="truncate">{item.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </nav>
  );
}
