import { Dashboard } from '../../../../components/dashboard';

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  return <Dashboard workspaceSlug={workspace} />;
}
