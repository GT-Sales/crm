import { Suspense } from 'react';

import { LeadsInbox } from '../../../../components/leads/leads-inbox';

export default async function LeadsPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params;
  // The inbox reads its filters from the URL, so it renders on the client.
  return (
    <Suspense
      fallback={
        <p className="text-sm text-muted-foreground" aria-busy="true">
          Loading leads…
        </p>
      }
    >
      <LeadsInbox workspaceSlug={workspace} />
    </Suspense>
  );
}
