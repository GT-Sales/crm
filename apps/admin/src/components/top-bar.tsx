'use client';

import { usePathname } from 'next/navigation';
import { LogOutIcon } from 'lucide-react';
import type { StaffWorkspace } from '@gt-sales/contracts';
import { Button, SidebarTrigger } from '@gt-sales/ui';

import { WorkspaceSwitcher } from './workspace-switcher';
import { NAV_ITEMS } from './nav-items';
import { ThemeToggle } from './theme-toggle';
import { QuickNavigation } from './quick-navigation';

export function TopBar({
  workspace,
  workspaces,
  onSignOut,
}: {
  workspace: StaffWorkspace;
  workspaces: readonly StaffWorkspace[];
  onSignOut(): Promise<void>;
}) {
  const pathname = usePathname();
  const section = pathname.split('/')[3] ?? 'leads';

  return (
    <header className="crm-topbar flex h-14 shrink-0 items-center gap-2 border-b bg-background px-3">
      <SidebarTrigger />
      <div className="h-6 w-px bg-border" aria-hidden="true" />
      {section === 'dashboard' ? (
        <h1 className="min-w-0 truncate text-sm font-normal">Dashboard</h1>
      ) : (
        <span className="hidden text-sm text-foreground md:inline">
          {NAV_ITEMS.find((item) => item.section === section)?.label ?? 'Workspace'}
        </span>
      )}
      <div className="ml-auto flex min-w-0 items-center gap-2">
        <QuickNavigation workspaceSlug={workspace.slug} />
        <ThemeToggle />
        <WorkspaceSwitcher
          currentWorkspace={workspace}
          currentSection={section}
          workspaces={workspaces}
        />
        <Button variant="ghost" size="sm" onClick={() => void onSignOut()}>
          <LogOutIcon className="size-4 sm:hidden" aria-hidden="true" />
          <span className="sr-only sm:not-sr-only">Sign out</span>
        </Button>
      </div>
    </header>
  );
}
