import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@gt-sales/ui';
import { customerEmailTemplateSchema } from '@gt-sales/contracts';

import { EmailSettingsScreen } from '../../../../../components/email/email-settings';

export default async function EmailSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ template?: string | string[] }>;
}) {
  const { workspace } = await params;
  // `?template=<key>` (the Automations page links with it) opens that email's editor.
  const template = customerEmailTemplateSchema.safeParse((await searchParams).template);
  return (
    <Card>
      <CardHeader>
        <CardTitle asChild>
          <h1>Email</h1>
        </CardTitle>
        <CardDescription>
          Who this site’s customer emails come from, how they look and what each one says.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <EmailSettingsScreen
          key={template.success ? template.data : ''}
          workspaceSlug={workspace}
          {...(template.success ? { initialTemplate: template.data } : {})}
        />
      </CardContent>
    </Card>
  );
}
