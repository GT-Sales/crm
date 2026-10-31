import { redirect } from 'next/navigation';

/** Reports opens on its one report so far, Sources. */
export default async function ReportsPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}): Promise<never> {
  const { workspace } = await params;
  redirect(`/w/${encodeURIComponent(workspace)}/reports/sources`);
}
