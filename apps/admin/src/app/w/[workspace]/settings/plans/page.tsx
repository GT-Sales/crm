import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@gt-sales/ui';
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
      <CardHeader>
        <CardTitle asChild>
          <h1>Plans</h1>
        </CardTitle>
        <CardDescription>
          The plans this site sells for each kind of order: price, billing period, payment and the
          documents an order needs.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <nav aria-label="Plan settings">
          <Link
            className="text-sm font-medium underline"
            href={`/w/${workspace}/settings/plans/properties`}
          >
            Plan properties
          </Link>
        </nav>
        <PlansSettings workspaceSlug={workspace} />
      </CardContent>
    </Card>
  );
}
