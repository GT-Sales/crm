import { LeadRecord } from '../../../../../components/leads/lead-record';

export default async function LeadPage({
  params,
}: {
  params: Promise<{ workspace: string; leadId: string }>;
}) {
  const { workspace, leadId } = await params;
  return <LeadRecord workspaceSlug={workspace} leadId={leadId} />;
}
