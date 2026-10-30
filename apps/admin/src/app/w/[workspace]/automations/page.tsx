import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@gt-sales/ui';

import { SiteAutomations } from '../../../../components/automations/automations-list';

export default async function AutomationsPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  return (
    <Card>
      <CardHeader>
        <CardTitle asChild>
          <h1>Automations</h1>
        </CardTitle>
        <CardDescription>
          The emails this site sends its customers on its own when an order arrives or moves stage.
          Each rule stays off until the site owner switches it on.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <SiteAutomations workspaceSlug={workspace} />
      </CardContent>
    </Card>
  );
}
