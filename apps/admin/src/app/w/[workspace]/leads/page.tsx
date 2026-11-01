import { Suspense } from 'react';

import { LeadsInbox } from '../../../../components/leads/leads-inbox';
import { LoadingSkeleton } from '../../../../components/crm/loading-skeleton';

export default async function LeadsPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params;
  // The inbox reads its filters from the URL, so it renders on the client.
  return (
    <Suspense fallback={<LoadingSkeleton label="Loading leads…" variant="list" />}>
      <LeadsInbox workspaceSlug={workspace} />
    </Suspense>
  );
}
