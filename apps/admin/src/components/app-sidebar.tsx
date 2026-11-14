'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { LogOutIcon, UserRoundIcon } from 'lucide-react';
import {
  Button,
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

import { getLeadsSummary, listDocumentReviewQueue } from '../lib/api';
import { DOCUMENTS_REVIEWED } from '../lib/lead-work-events';
import { STAFF_DISPLAY_NAME_CHANGED, initials } from '../lib/people';
import { useLeadWorkspace } from './leads/use-lead-workspace';
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

/**
 * Documents waiting for a first review, refreshed on navigation and after any
 * review. Undefined for a role that cannot see customer documents (the queue
 * answers 403) or while unknown: no count rather than a wrong one.
 */
function useDocumentsToReview(workspace: string, pathname: string): number | undefined {
  const { accessToken, workspaces } = useStaffSession();
  const workspaceId = workspaces.find((entry) => entry.slug === workspace)?.id;
  const [count, setCount] = useState<number>();
  const [reviewed, setReviewed] = useState(0);
  useEffect(() => {
    const onReviewed = () => setReviewed((value) => value + 1);
    window.addEventListener(DOCUMENTS_REVIEWED, onReviewed);
    return () => window.removeEventListener(DOCUMENTS_REVIEWED, onReviewed);
  }, []);
  useEffect(() => {
    if (!accessToken || !workspaceId) return;
    let live = true;
    listDocumentReviewQueue(accessToken, workspaceId, { status: 'to_review' })
      .then((queue) => {
        if (live) setCount(queue.counts.toReview);
      })
      .catch(() => {
        if (live) setCount(undefined);
      });
    return () => {
      live = false;
    };
  }, [accessToken, workspaceId, pathname, reviewed]);
  return count;
}

export function AppSidebar({ workspace }: { workspace: string }) {
  const pathname = usePathname();
  const { workspaces, email, signOut } = useStaffSession();
  const currentWorkspace = workspaces.find((site) => site.slug === workspace);
  const { members, reloadMembers } = useLeadWorkspace(workspace);
  const displayName = members.find((member) => member.isSelf)?.displayName;
  const name = displayName || 'Staff account';
  useEffect(() => {
    const refresh = () => void reloadMembers();
    window.addEventListener(STAFF_DISPLAY_NAME_CHANGED, refresh);
    return () => window.removeEventListener(STAFF_DISPLAY_NAME_CHANGED, refresh);
  }, [reloadMembers]);
  const { isMobile, setOpenMobile } = useSidebar();
  const unopened = useUnopenedLeads(workspace, pathname);
  const toReview = useDocumentsToReview(workspace, pathname);
  // What a menu entry is waiting on, said beside it and to screen readers.
  const badgeOf = (section: string) =>
    section === 'leads' && unopened
      ? {
          count: unopened,
          words: `${unopened} new`,
          title: `${unopened} new ${unopened === 1 ? 'lead' : 'leads'} not opened yet`,
        }
      : section === 'documents' && toReview
        ? {
            count: toReview,
            words: `${toReview} to review`,
            title: `${toReview} ${toReview === 1 ? 'document' : 'documents'} to review`,
          }
        : undefined;

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
                      className={section === 'automations' ? 'mt-6' : undefined}
                    >
                      {section === 'automations' ? (
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
                            badgeOf(section) ? `${label}, ${badgeOf(section)?.words}` : label
                          }
                          aria-current={isActive ? 'page' : undefined}
                          onClick={() => {
                            if (isMobile) setOpenMobile(false);
                          }}
                        >
                          <Icon />
                          <span>{label}</span>
                          {badgeOf(section) ? (
                            <span
                              className="ml-auto rounded-full bg-primary px-1.5 text-[10px] font-semibold leading-4 text-primary-foreground group-data-[collapsible=icon]:hidden"
                              aria-hidden="true"
                              title={badgeOf(section)?.title}
                            >
                              {badgeOf(section)?.count}
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
      <SidebarFooter className="p-3 group-data-[collapsible=icon]:p-2">
        <div className="flex min-w-0 items-center gap-2 rounded-lg px-1 py-1 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium group-data-[collapsible=icon]:hidden"
          >
            {displayName ? initials(displayName) : <UserRoundIcon className="size-4" />}
          </span>
          <div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
            <p title={name} className="truncate text-sm font-medium">
              {name}
            </p>
            {email ? (
              <p title={email} className="truncate text-xs text-muted-foreground">
                {email}
              </p>
            ) : null}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 text-muted-foreground"
            aria-label="Sign out"
            title="Sign out"
            onClick={() => void signOut()}
          >
            <LogOutIcon aria-hidden="true" />
          </Button>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
