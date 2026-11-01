import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@gt-sales/ui';

import { DisplayNameForm } from '../../../../components/display-name-form';

export default async function SettingsPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params;
  return (
    <Card>
      <CardHeader>
        <CardTitle asChild>
          <h1>General settings</h1>
        </CardTitle>
        <CardDescription>Manage your profile for this site.</CardDescription>
      </CardHeader>
      <CardContent className="crm-settings-sections flex flex-col gap-10">
        <DisplayNameForm workspaceSlug={workspace} />
      </CardContent>
    </Card>
  );
}
