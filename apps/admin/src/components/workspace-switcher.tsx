'use client';

import { useRouter } from 'next/navigation';
import { ChevronsUpDownIcon, Globe2Icon } from 'lucide-react';
import type { StaffWorkspace } from '@gt-sales/contracts';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@gt-sales/ui';

export function WorkspaceSwitcher({
  currentWorkspace,
  currentSection,
  workspaces,
  onSelect,
}: {
  currentWorkspace: StaffWorkspace;
  currentSection: string;
  workspaces: readonly StaffWorkspace[];
  onSelect?(): void;
}) {
  const router = useRouter();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          aria-label="Switch site"
          title={currentWorkspace.name}
          className="h-10 w-full min-w-0 justify-start gap-2 px-2 group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:p-0"
        >
          <Globe2Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1 text-left group-data-[collapsible=icon]:hidden">
            <span className="block truncate text-sm font-medium">{currentWorkspace.name}</span>
            <span className="block text-xs font-normal text-muted-foreground">Switch website</span>
          </span>
          <ChevronsUpDownIcon
            className="size-4 shrink-0 text-muted-foreground group-data-[collapsible=icon]:hidden"
            aria-hidden="true"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        {workspaces.map((workspace) => (
          <DropdownMenuItem
            key={workspace.slug}
            onSelect={() => {
              router.push(`/w/${workspace.slug}/${currentSection}`);
              onSelect?.();
            }}
          >
            {workspace.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
