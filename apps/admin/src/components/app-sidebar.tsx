'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Globe2Icon, ShieldCheckIcon } from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@gt-sales/ui';

import { getLeadsSummary } from '../lib/api';
import { NAV_ITEMS } from './nav-items';
import { useStaffSession } from './staff-session-provider';
import { WorkspaceSwitcher } from './workspace-switcher';

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
  const { workspaces } = useStaffSession();
  const currentWorkspace = workspaces.find((site) => site.slug === workspace);
  const workspaceName = currentWorkspace?.name ?? workspace;
  const { isMobile, setOpenMobile } = useSidebar();
  const unopened = useUnopenedLeads(workspace, pathname);

  return (
    <Sidebar collapsible="icon" className="crm-sidebar">
      <SidebarHeader>
        {currentWorkspace ? (
          <WorkspaceSwitcher
            currentWorkspace={currentWorkspace}
            currentSection={pathname.split('/')[3] ?? 'leads'}
            workspaces={workspaces}
            onSelect={() => {
              if (isMobile) setOpenMobile(false);
            }}
          />
        ) : null}
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <nav aria-label="Site navigation">
              <SidebarMenu>
                {NAV_ITEMS.map(({ section, label, icon: Icon }) => {
                  const href = `/w/${workspace}/${section}`;
                  const isActive = pathname === href || pathname.startsWith(`${href}/`);

                  return (
                    <SidebarMenuItem
                      key={section}
                      className={section === 'reports' ? 'mt-6' : undefined}
                    >
                      {section === 'reports' ? (
                        <p className="mb-2 px-2 text-xs font-medium text-muted-foreground group-data-[collapsible=icon]:hidden">
                          Manage
                        </p>
                      ) : null}
                      <SidebarMenuButton
                        className="h-8"
                        asChild
                        isActive={isActive}
                        tooltip={label}
                      >
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
                              title={`${unopened} new ${unopened === 1 ? 'lead' : 'leads'} not opened yet`}
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
      <SidebarFooter className="p-3">
        <div className="flex items-center gap-2.5 rounded-lg p-2 group-data-[collapsible=icon]:hidden">
          <Globe2Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {workspaceName}
            <span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">
              Site workspace
            </span>
          </span>
          <ShieldCheckIcon
            className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
            aria-hidden="true"
          />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
