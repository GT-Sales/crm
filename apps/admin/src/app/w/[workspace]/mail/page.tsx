import { Mailbox } from '../../../../components/mail/mailbox';

export default async function MailPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Mail</h1>
        <p className="text-sm text-muted-foreground">
          The emails this site has sent, by customer. Choose a customer to read them and write back,
          or press New email.
        </p>
      </div>
      <Mailbox workspaceSlug={workspace} />
    </div>
  );
}
