import { Suspense } from 'react';

import { Dashboard } from '../../../../components/dashboard';
import {
  DashboardFiltersSkeleton,
  LoadingSkeleton,
} from '../../../../components/crm/loading-skeleton';

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  // The dashboard keeps its period and filters in the URL (useSearchParams).
  return (
    <Suspense
      fallback={
        <div className="crm-dashboard flex flex-col gap-6">
          <DashboardFiltersSkeleton />
          <LoadingSkeleton label="Loading the dashboard…" variant="dashboard" />
        </div>
      }
    >
      <Dashboard workspaceSlug={workspace} />
    </Suspense>
  );
}
