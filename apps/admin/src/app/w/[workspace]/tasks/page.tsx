import { MyTasks } from '../../../../components/leads/my-tasks';

export default async function TasksPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params;
  return <MyTasks workspaceSlug={workspace} />;
}
