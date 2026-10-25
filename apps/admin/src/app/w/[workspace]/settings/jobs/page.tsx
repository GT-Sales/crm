import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@gt-sales/ui';

import { JobsStatus } from '../../../../../components/jobs-status';

export default async function JobsSettingsPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  return (
    <Card>
      <CardHeader>
        <CardTitle asChild>
          <h1>Background jobs</h1>
        </CardTitle>
        <CardDescription>
          Pending deliveries and failures for this workspace. Uncertain deliveries require
          reconciliation.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <JobsStatus workspaceSlug={workspace} />
      </CardContent>
    </Card>
  );
}
