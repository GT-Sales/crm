import { PageHeader } from '../../../../components/page-header';
import { WebAnalytics } from '../../../../components/web-analytics/web-analytics';

export default async function AnalyticsPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Analytics"
        description="Visitors to this site's website, from Umami: how many came, where from and what they looked at."
      />
      <WebAnalytics workspaceSlug={workspace} />
    </div>
  );
}
