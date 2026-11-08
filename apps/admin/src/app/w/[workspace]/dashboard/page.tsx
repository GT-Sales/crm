import { Suspense } from 'react';

import { Dashboard } from '../../../../components/dashboard';
import { LoadingSkeleton } from '../../../../components/crm/loading-skeleton';

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  // The dashboard keeps its period and filters in the URL (useSearchParams).
  return (
    <Suspense fallback={<LoadingSkeleton label="Loading the dashboard…" variant="dashboard" />}>
      <Dashboard workspaceSlug={workspace} />
    </Suspense>
  );
}
