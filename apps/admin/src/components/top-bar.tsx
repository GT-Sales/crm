'use client';

import { usePathname } from 'next/navigation';
import type { StaffWorkspace } from '@gt-sales/contracts';
import { SidebarTrigger } from '@gt-sales/ui';

import { NAV_ITEMS } from './nav-items';
import { ThemeToggle } from './theme-toggle';
import { QuickNavigation } from './quick-navigation';
import { AssistantTrigger } from './ai/assistant-trigger';

export function TopBar({ workspace }: { workspace: StaffWorkspace }) {
  const pathname = usePathname();
  const section = pathname.split('/')[3] ?? 'leads';
  const page = NAV_ITEMS.find((item) => item.section === section);
  const PageIcon = page?.icon;
  const isLeadsInbox = section === 'leads' && pathname.split('/').length === 4;

  return (
    <header className="crm-topbar flex h-14 shrink-0 items-center gap-2 border-b bg-background px-3">
      <SidebarTrigger />
      <div className="h-6 w-px bg-border" aria-hidden="true" />
      {PageIcon ? (
        <PageIcon
          aria-hidden="true"
          className="hidden size-4 shrink-0 text-muted-foreground md:block"
        />
      ) : null}
      {section === 'dashboard' || isLeadsInbox ? (
        <h1
          className={
            isLeadsInbox
              ? 'sr-only text-sm font-normal md:not-sr-only'
              : 'min-w-0 truncate text-sm font-normal'
          }
        >
          {isLeadsInbox ? 'Leads' : 'Dashboard'}
        </h1>
      ) : (
        <span className="hidden text-sm text-foreground md:inline">
          {page?.label ?? 'Workspace'}
        </span>
      )}
      <div className="ml-auto flex min-w-0 items-center gap-2">
        <AssistantTrigger />
        <QuickNavigation workspaceSlug={workspace.slug} workspaceId={workspace.id} />
        <ThemeToggle />
      </div>
    </header>
  );
}
