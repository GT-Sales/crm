'use client';

import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { SidebarInset, SidebarProvider } from '@gt-sales/ui';

import { AppSidebar } from './app-sidebar';
import { useStaffSession } from './staff-session-provider';
import { TopBar } from './top-bar';

export function ProtectedWorkspaceShell({
  children,
  workspaceSlug,
}: {
  children: ReactNode;
  workspaceSlug: string;
}) {
  const router = useRouter();
  const staff = useStaffSession();
  const workspace = staff.workspaces.find((item) => item.slug === workspaceSlug);

  useEffect(() => {
    if (staff.status === 'signed_out') router.replace('/login');
    if (staff.status === 'error')
      router.replace(`/denied?reason=${staff.reason ?? 'internal_error'}`);
    if (staff.status === 'signed_in' && !workspace) {
      router.replace('/denied?reason=workspace_not_found');
    }
  }, [router, staff.reason, staff.status, workspace]);

  if (staff.status === 'configuration_missing') {
    return (
      <main id="main-content" tabIndex={-1} className="p-6 outline-none">
        <h1 className="text-2xl font-semibold">Staff authentication unavailable</h1>
        <p className="mt-2 text-muted-foreground">
          This environment is missing the public Supabase Auth configuration.
        </p>
      </main>
    );
  }
  if (staff.status !== 'signed_in' || !workspace) {
    return (
      <main id="main-content" tabIndex={-1} className="p-6 outline-none" aria-busy="true">
        <h1 className="text-2xl font-semibold">Checking workspace access</h1>
      </main>
    );
  }

  return (
    <SidebarProvider>
      <AppSidebar workspace={workspace.slug} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar workspace={workspace} workspaces={staff.workspaces} onSignOut={staff.signOut} />
        <SidebarInset id="main-content" tabIndex={-1} className="flex-1 p-6 outline-none">
          {children}
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
