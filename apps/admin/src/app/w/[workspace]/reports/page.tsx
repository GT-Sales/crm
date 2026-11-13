import { redirect } from 'next/navigation';

/** The source report moved into the Dashboard's sources card; old links open it there. */
export default async function ReportsPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}): Promise<never> {
  const { workspace } = await params;
  redirect(`/w/${encodeURIComponent(workspace)}/dashboard?report=sources`);
}
