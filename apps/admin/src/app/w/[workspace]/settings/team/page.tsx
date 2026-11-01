import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@gt-sales/ui';

import { StaffInviteForm } from '../../../../../components/staff-invite-form';
import { TeamList } from '../../../../../components/team-list';

export default async function TeamSettingsPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  return (
    <Card>
      <CardHeader>
        <CardTitle asChild>
          <h1>Team settings</h1>
        </CardTitle>
        <CardDescription>Manage teammates and their access to this site.</CardDescription>
      </CardHeader>
      <CardContent className="crm-settings-sections flex flex-col gap-8">
        <StaffInviteForm workspaceSlug={workspace} />
        <TeamList workspaceSlug={workspace} />
      </CardContent>
    </Card>
  );
}
