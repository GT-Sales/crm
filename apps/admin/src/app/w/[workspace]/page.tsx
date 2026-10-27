import { redirect } from 'next/navigation';

/** A site's own address opens its dashboard. */
export default async function WorkspacePage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}): Promise<never> {
  const { workspace } = await params;
  redirect(`/w/${encodeURIComponent(workspace)}/dashboard`);
}
