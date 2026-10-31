import { SourceReport } from '../../../../../components/reports/source-report';

export default async function SourceReportPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  return <SourceReport workspaceSlug={workspace} />;
}
