'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  BarChart3Icon,
  ClipboardListIcon,
  FileTextIcon,
  SettingsIcon,
  ShieldCheckIcon,
  UsersIcon,
} from 'lucide-react';
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

const NAV_ITEMS = [
  { section: 'orders', label: 'Orders', icon: ClipboardListIcon },
  { section: 'leads', label: 'Leads', icon: UsersIcon },
  { section: 'partners', label: 'Partners', icon: ShieldCheckIcon },
  { section: 'documents', label: 'Documents', icon: FileTextIcon },
  { section: 'reports/sources', label: 'Reports', icon: BarChart3Icon },
  { section: 'settings', label: 'Settings', icon: SettingsIcon },
] as const;

export function AppSidebar({ workspace }: { workspace: string }) {
  const pathname = usePathname();
  const { isMobile, setOpenMobile } = useSidebar();

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
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <nav aria-label="Workspace navigation">
              <SidebarMenu>
                {NAV_ITEMS.map(({ section, label, icon: Icon }) => {
                  const href = `/w/${workspace}/${section}`;
                  const isActive = pathname === href || pathname.startsWith(`${href}/`);

                  return (
                    <SidebarMenuItem key={section}>
                      <SidebarMenuButton asChild isActive={isActive} tooltip={label}>
                        <Link
                          href={href}
                          aria-label={label}
                          aria-current={isActive ? 'page' : undefined}
                          onClick={() => {
                            if (isMobile) setOpenMobile(false);
                          }}
                        >
                          <Icon />
                          <span>{label}</span>
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
