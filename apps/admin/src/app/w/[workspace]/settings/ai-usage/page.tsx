import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@gt-sales/ui';

import { AiUsageScreen } from '../../../../../components/ai-usage/ai-usage-screen';

export default async function AiUsageSettingsPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  return (
    <Card>
      <CardHeader>
        <CardTitle asChild>
          <h1>AI usage</h1>
        </CardTitle>
        <CardDescription>
          Conversations with Ask AI are private to each person. This page shows only how much each
          person has used it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AiUsageScreen workspaceSlug={workspace} />
      </CardContent>
    </Card>
  );
}
