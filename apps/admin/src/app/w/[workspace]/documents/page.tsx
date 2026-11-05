import { DocumentReviewQueue } from '../../../../components/documents/review-queue';

export default async function DocumentsPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Documents</h1>
        <p className="text-sm text-muted-foreground">
          Customer files waiting on staff. Documents an order&apos;s plan requires come first;
          approve them here or open the lead.
        </p>
      </div>
      <DocumentReviewQueue workspaceSlug={workspace} />
    </div>
  );
}
