import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@gt-sales/ui';
import Link from 'next/link';

import { PropertiesSettings } from '../../../../../../components/properties/properties-settings';

export default async function PlanPropertiesSettingsPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <CardTitle asChild>
            <h1>Plan properties</h1>
          </CardTitle>
          <CardDescription>
            The extra details this site keeps on each plan, and which of them the website shows.
          </CardDescription>
        </div>
        <nav aria-label="Plan settings">
          <Button variant="outline" size="sm" asChild>
            <Link href={`/w/${workspace}/settings/plans`}>Back to plans</Link>
          </Button>
        </nav>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <PropertiesSettings workspaceSlug={workspace} object="plan" />
      </CardContent>
    </Card>
  );
}
