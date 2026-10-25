'use client';

import { useRouter } from 'next/navigation';
import { ChevronsUpDownIcon } from 'lucide-react';
import type { StaffWorkspace } from '@gt-sales/contracts';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@gt-sales/ui';

export function WorkspaceSwitcher({
  currentWorkspace,
  currentSection,
  workspaces,
}: {
  currentWorkspace: StaffWorkspace;
  currentSection: string;
  workspaces: readonly StaffWorkspace[];
}) {
  const router = useRouter();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" aria-label="Switch site" className="min-w-0 max-w-64">
          <span className="truncate">{currentWorkspace.name}</span>
          <ChevronsUpDownIcon className="size-4 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuLabel>Sites</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {workspaces.map((workspace) => (
          <DropdownMenuItem
            key={workspace.slug}
            onSelect={() => router.push(`/w/${workspace.slug}/${currentSection}`)}
          >
            {workspace.name}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {/* The cross-site inbox is phase 2 (docs/PLAN.md §5.2); shown disabled so
            the shape of the menu is settled now. */}
        <DropdownMenuItem disabled>All sites — coming soon</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
