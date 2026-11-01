import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@gt-sales/ui';
import Link from 'next/link';

import { PlansSettings } from '../../../../../components/plans/plans-settings';

export default async function PlansSettingsPage({
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
            <h1>Plans</h1>
          </CardTitle>
          <CardDescription>
            The plans this site sells for each kind of order: price, billing period, payment and the
            documents an order needs.
          </CardDescription>
        </div>
        <nav aria-label="Plan settings">
          <Button variant="outline" size="sm" asChild>
            <Link href={`/w/${workspace}/settings/plans/properties`}>Plan properties</Link>
          </Button>
        </nav>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <PlansSettings workspaceSlug={workspace} />
      </CardContent>
    </Card>
  );
}
