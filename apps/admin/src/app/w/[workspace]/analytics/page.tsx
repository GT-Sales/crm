import { WebAnalytics } from '../../../../components/web-analytics/web-analytics';

export default async function AnalyticsPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
        <p className="text-sm text-muted-foreground">
          Visitors to this site&apos;s website, from Umami: how many came, where from and what they
          looked at.
        </p>
      </div>
      <WebAnalytics workspaceSlug={workspace} />
    </div>
  );
}
