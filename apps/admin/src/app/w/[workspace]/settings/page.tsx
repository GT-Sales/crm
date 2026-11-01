import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@gt-sales/ui';

import { DisplayNameForm } from '../../../../components/display-name-form';
import { ServiceCredentialsManager } from '../../../../components/service-credentials-manager';
import { StaffInviteForm } from '../../../../components/staff-invite-form';
import { TeamList } from '../../../../components/team-list';

export default async function SettingsPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params;
  return (
    <Card>
      <CardHeader>
        <CardTitle asChild>
          <h1>Settings</h1>
        </CardTitle>
        <CardDescription>
          Manage your profile, team and website access for this site.
        </CardDescription>
      </CardHeader>
      <CardContent className="crm-settings-sections flex flex-col gap-10">
        <DisplayNameForm workspaceSlug={workspace} />
        <TeamList workspaceSlug={workspace} />
        <section className="flex flex-col gap-4">
          <div>
            <h2 className="font-semibold">Invite a teammate</h2>
            <p className="text-sm text-muted-foreground">
              Choose the roles they need to work on this site.
            </p>
          </div>
          <StaffInviteForm workspaceSlug={workspace} />
        </section>
        <ServiceCredentialsManager workspaceSlug={workspace} />
      </CardContent>
    </Card>
  );
}
