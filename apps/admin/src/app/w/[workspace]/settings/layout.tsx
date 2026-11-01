import type { ReactNode } from 'react';
import { SettingsNavigation } from '../../../../components/settings-navigation';

export default async function SettingsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      <SettingsNavigation workspaceSlug={workspace} />
      <div className="crm-settings-content min-w-0 flex-1">{children}</div>
    </div>
  );
}
