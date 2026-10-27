'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { FileTextIcon, ListTodoIcon, SettingsIcon, UsersIcon } from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@gt-sales/ui';

import { getLeadsSummary } from '../lib/api';
import { useStaffSession } from './staff-session-provider';

/**
 * Only sections that exist. Orders, partners, finance and reports arrive with
 * the phases that port them (docs/PLAN.md §7); a link to a missing page is a
 * 404, not a placeholder.
 */
const NAV_ITEMS = [
  { section: 'leads', label: 'Leads', icon: UsersIcon },
  { section: 'tasks', label: 'My tasks', icon: ListTodoIcon },
  { section: 'documents', label: 'Documents', icon: FileTextIcon },
  { section: 'settings', label: 'Settings', icon: SettingsIcon },
] as const;

/**
 * Leads no one who works leads has opened yet, across the site's types,
 * refreshed on every navigation. Undefined until known or when it fails: the
 * menu then shows no count rather than a wrong one.
 */
function useUnopenedLeads(workspace: string, pathname: string): number | undefined {
  const { accessToken, workspaces } = useStaffSession();
  const workspaceId = workspaces.find((entry) => entry.slug === workspace)?.id;
  const [count, setCount] = useState<number>();
  useEffect(() => {
    if (!accessToken || !workspaceId) return;
    let live = true;
    getLeadsSummary(accessToken, workspaceId)
      .then((summary) => {
        if (live) setCount(summary.types.reduce((sum, entry) => sum + (entry.unopened ?? 0), 0));
      })
      .catch(() => {
        if (live) setCount(undefined);
      });
    return () => {
      live = false;
    };
  }, [accessToken, workspaceId, pathname]);
  return count;
}

export function AppSidebar({ workspace }: { workspace: string }) {
  const pathname = usePathname();
  const { isMobile, setOpenMobile } = useSidebar();
  const unopened = useUnopenedLeads(workspace, pathname);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex h-8 items-center gap-2 overflow-hidden whitespace-nowrap px-2 text-sm font-semibold">
          <span
            aria-hidden="true"
            className="flex size-5 shrink-0 items-center justify-center rounded bg-primary text-[9px] font-bold text-primary-foreground"
          >
            GT
          </span>
          <span className="group-data-[collapsible=icon]:sr-only">GT Sales CRM</span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Site</SidebarGroupLabel>
          <SidebarGroupContent>
            <nav aria-label="Site navigation">
              <SidebarMenu>
                {NAV_ITEMS.map(({ section, label, icon: Icon }) => {
                  const href = `/w/${workspace}/${section}`;
                  const isActive = pathname === href || pathname.startsWith(`${href}/`);

                  return (
                    <SidebarMenuItem key={section}>
                      <SidebarMenuButton asChild isActive={isActive} tooltip={label}>
                        <Link
                          href={href}
                          aria-label={
                            section === 'leads' && unopened ? `${label}, ${unopened} new` : label
                          }
                          aria-current={isActive ? 'page' : undefined}
                          onClick={() => {
                            if (isMobile) setOpenMobile(false);
                          }}
                        >
                          <Icon />
                          <span>{label}</span>
                          {section === 'leads' && unopened ? (
                            <span
                              className="ml-auto rounded-full bg-primary px-1.5 text-[10px] font-semibold leading-4 text-primary-foreground group-data-[collapsible=icon]:hidden"
                              aria-hidden="true"
                            >
                              {unopened}
                            </span>
                          ) : null}
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
