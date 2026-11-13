'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { Button, SidebarInset, SidebarProvider } from '@gt-sales/ui';

import { describeError, isRetryable } from '../lib/error-text';

import { AppSidebar } from './app-sidebar';
import { useStaffSession } from './staff-session-provider';
import { TopBar } from './top-bar';
import { AssistantPanel } from './ai/assistant-panel';
import { AssistantProvider } from './ai/assistant-provider';
import { LoadingSkeleton } from './crm/loading-skeleton';

const LEAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The lead the URL has open — `?lead=` beside the list, or the full lead page.
 * It is the "which lead is this about" chip's only source; a malformed value is
 * ignored rather than sent as request context.
 */
function activeLeadId(
  pathname: string,
  search: { get(name: string): string | null },
): string | undefined {
  const queried = search.get('lead');
  if (queried !== null && LEAD_ID_PATTERN.test(queried)) return queried;
  const parts = pathname.split('/');
  const routed =
    parts.length === 5 && parts[1] === 'w' && parts[3] === 'leads' ? parts[4] : undefined;
  return routed !== undefined && LEAD_ID_PATTERN.test(routed) ? routed : undefined;
}

export function ProtectedWorkspaceShell({
  children,
  workspaceSlug,
}: {
  children: ReactNode;
  workspaceSlug: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const staff = useStaffSession();
  const workspace = staff.workspaces.find((item) => item.slug === workspaceSlug);
  // The CRM did not answer the access check (offline, a timeout, an outage):
  // that says nothing about the person's access, so it is shown here with a
  // retry instead of the "Access denied" page.
  const unreachable =
    staff.status === 'error' && isRetryable(staff.failure ?? staff.reason ?? 'internal_error');

  useEffect(() => {
    if (staff.status === 'signed_out') router.replace('/login');
    if (staff.status === 'error' && !unreachable) {
      router.replace(`/denied?reason=${staff.reason ?? 'internal_error'}`);
    }
    if (staff.status === 'signed_in' && !workspace) {
      router.replace('/denied?reason=workspace_not_found');
    }
  }, [router, staff.reason, staff.status, unreachable, workspace]);

  if (unreachable) {
    return (
      <main
        id="main-content"
        tabIndex={-1}
        className="flex flex-col items-start gap-3 p-6 outline-none"
      >
        <h1 className="text-2xl font-semibold">The CRM is not responding</h1>
        <p role="alert" className="max-w-prose text-muted-foreground">
          {describeError(staff.failure ?? staff.reason, 'check your access to this site')}
        </p>
        <div className="flex gap-2">
          <Button type="button" onClick={() => void staff.retry()}>
            Try again
          </Button>
          <Button type="button" variant="outline" onClick={() => void staff.signOut()}>
            Sign out
          </Button>
        </div>
      </main>
    );
  }

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
      <main id="main-content" tabIndex={-1} className="outline-none" aria-busy="true">
        <LoadingSkeleton label="Checking workspace access" variant="workspace" />
      </main>
    );
  }

  return (
    <SidebarProvider>
      <AssistantProvider
        key={`${workspace.id}:${workspace.membershipId}`}
        actorIdentity={workspace.membershipId}
        workspace={workspace}
        accessToken={staff.accessToken ?? ''}
        activeLeadId={activeLeadId(pathname, searchParams)}
      >
        <AppSidebar workspace={workspace.slug} />
        <div className="crm-workspace flex min-w-0 flex-1 flex-col bg-background">
          <TopBar workspace={workspace} onSignOut={staff.signOut} />
          <SidebarInset
            id="main-content"
            tabIndex={-1}
            className="crm-content flex-1 p-4 outline-none md:p-6"
          >
            {children}
          </SidebarInset>
        </div>
        <AssistantPanel />
      </AssistantProvider>
    </SidebarProvider>
  );
}
