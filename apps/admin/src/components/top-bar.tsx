'use client';

import { usePathname } from 'next/navigation';
import type { StaffWorkspace } from '@gt-sales/contracts';
import { Button, SidebarTrigger } from '@gt-sales/ui';

import { NAV_ITEMS } from './nav-items';
import { WorkspaceSwitcher } from './workspace-switcher';

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
  const sectionLabel = NAV_ITEMS.find((item) => item.section === section)?.label;

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-background px-4">
      <SidebarTrigger />
      <div className="h-6 w-px bg-border" aria-hidden="true" />
      <WorkspaceSwitcher
        currentWorkspace={workspace}
        currentSection={section}
        workspaces={workspaces}
      />
      {sectionLabel ? (
        <nav aria-label="Breadcrumb" className="min-w-0">
          <ol className="flex items-center gap-2 text-sm">
            <li aria-hidden="true" className="text-muted-foreground">
              /
            </li>
            <li aria-current="page" className="truncate font-medium">
              {sectionLabel}
            </li>
          </ol>
        </nav>
      ) : null}
      <Button variant="ghost" className="ml-auto" onClick={() => void onSignOut()}>
        Sign out
      </Button>
    </header>
  );
}
