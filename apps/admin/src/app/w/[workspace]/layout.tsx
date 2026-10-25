import type { ReactNode } from 'react';

import { ProtectedWorkspaceShell } from '../../../components/protected-workspace-shell';

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;

  return <ProtectedWorkspaceShell workspaceSlug={workspace}>{children}</ProtectedWorkspaceShell>;
}
