import { Mailbox } from '../../../../components/mail/mailbox';

export default async function MailPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Mail</h1>
        <p className="text-sm text-muted-foreground">
          Every email this site has sent its customers, newest first. Write a new one here or from a
          lead&apos;s Mail tab.
        </p>
      </div>
      <Mailbox workspaceSlug={workspace} />
    </div>
  );
}
