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
          The flows this site runs on its own when a lead is submitted, moves stage or waits too
          long: emails to the customer, tasks and notes to staff. Each flow stays off until someone
          with the Integrations permission switches it on.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <SiteAutomations workspaceSlug={workspace} />
      </CardContent>
    </Card>
  );
}
