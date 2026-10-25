import { and, eq } from 'drizzle-orm';
import { leads, type TenantTransaction } from '@gt-sales/db';

/**
 * Whether the lead behind a send is still an active customer subject — not
 * restricted or erased since the job was queued. Takes a share lock on the lead
 * so a concurrent restriction cannot slip between the check and the enqueue;
 * the lock ends with this short transaction, before any provider call.
 */
export async function customerSubjectActive(
  tx: TenantTransaction,
  workspaceId: string,
  subject: { leadId?: string },
): Promise<boolean> {
  if (!subject.leadId) return true;
  const [lead] = await tx
    .select({ restrictedAt: leads.customerDataRestrictedAt })
    .from(leads)
    .where(and(eq(leads.workspaceId, workspaceId), eq(leads.id, subject.leadId)))
    .limit(1)
    .for('share');
  return lead !== undefined && lead.restrictedAt === null;
}
