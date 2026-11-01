import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@gt-sales/ui';

import { ServiceCredentialsManager } from '../../../../../components/service-credentials-manager';

export default async function IntegrationsSettingsPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  return (
    <Card>
      <CardHeader>
        <CardTitle asChild>
          <h1>Integrations</h1>
        </CardTitle>
        <CardDescription>Manage this website’s connection to your CRM.</CardDescription>
      </CardHeader>
      <CardContent className="crm-settings-sections flex flex-col gap-10">
        <ServiceCredentialsManager workspaceSlug={workspace} />
      </CardContent>
    </Card>
  );
}
