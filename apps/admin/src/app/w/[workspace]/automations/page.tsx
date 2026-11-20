import { Card, CardContent } from '@gt-sales/ui';

import { SiteAutomations } from '../../../../components/automations/automations-list';
import { PageHeader } from '../../../../components/page-header';

export default async function AutomationsPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Automations"
        description="Flows this site runs on its own when leads arrive, move or wait."
      />
      <Card>
        <CardContent>
          <SiteAutomations workspaceSlug={workspace} />
        </CardContent>
      </Card>
    </div>
  );
}
