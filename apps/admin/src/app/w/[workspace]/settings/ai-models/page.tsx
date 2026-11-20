import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@gt-sales/ui';

import { AiModelsScreen } from '../../../../../components/ai-models/ai-models-screen';

export default async function AiModelsSettingsPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  return (
    <Card>
      <CardHeader>
        <CardTitle asChild>
          <h1>AI models</h1>
        </CardTitle>
        <CardDescription>
          Choose which AI models people on this site may use in Ask AI, and which one answers when
          nobody picks.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AiModelsScreen workspaceSlug={workspace} />
      </CardContent>
    </Card>
  );
}
