import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@gt-sales/ui';

import { PropertiesSettings } from '../../../../../components/properties/properties-settings';

export default async function PropertiesSettingsPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  return (
    <Card>
      <CardHeader>
        <CardTitle asChild>
          <h1>Properties</h1>
        </CardTitle>
        <CardDescription>
          The details this site keeps on its leads, and how each lead type groups them on the record
          page.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <PropertiesSettings workspaceSlug={workspace} />
      </CardContent>
    </Card>
  );
}
