'use client';

import { usePathname } from 'next/navigation';
import type { StaffWorkspace } from '@gt-sales/contracts';
import { Button, SidebarTrigger } from '@gt-sales/ui';

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

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background px-4">
      <SidebarTrigger />
      <div className="h-6 w-px bg-border" aria-hidden="true" />
      <WorkspaceSwitcher
        currentWorkspace={workspace}
        currentSection={section}
        workspaces={workspaces}
      />
      <Button variant="ghost" className="ml-auto" onClick={() => void onSignOut()}>
        Sign out
      </Button>
    </header>
  );
}
