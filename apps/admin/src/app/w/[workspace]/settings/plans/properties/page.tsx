import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@gt-sales/ui';
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
      <CardHeader>
        <CardTitle asChild>
          <h1>Plan properties</h1>
        </CardTitle>
        <CardDescription>
          The extra details this site keeps on each plan, and which of them the website shows.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <nav aria-label="Plan settings">
          <Link className="text-sm font-medium underline" href={`/w/${workspace}/settings/plans`}>
            Back to plans
          </Link>
        </nav>
        <PropertiesSettings workspaceSlug={workspace} object="plan" />
      </CardContent>
    </Card>
  );
}
