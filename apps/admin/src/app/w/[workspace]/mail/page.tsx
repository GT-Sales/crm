import { PageHeader } from '../../../../components/page-header';
import { Mailbox } from '../../../../components/mail/mailbox';

export default async function MailPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Mail"
        description="The emails this site has sent, by customer. Choose a customer to read them and write back, or press New email."
      />
      <Mailbox workspaceSlug={workspace} />
    </div>
  );
}
