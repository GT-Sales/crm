import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, lt } from 'drizzle-orm';
import { auditEvents, draftGrants, leads, withTenantTx } from '@gt-sales/db';

/**
 * SEC-12, owner decision (22 Oct 2026, docs/OPEN_INPUTS.md): an order form
 * that is still `incomplete` 90 days after its last change has the visitor's
 * name, email, phone, country and answers erased and its resume links revoked.
 * The row stays, restricted, as an anonymous count (source and offer kept).
 * Submitted leads are never touched; they belong to an order.
 */
export const ABANDONED_LEAD_RETENTION_DAYS = 90;
/** Bounded per run so one daily tick never holds a long lock. */
export const ABANDONED_LEAD_BATCH_SIZE = 1000;

type RetentionDatabase = Pick<import('@gt-sales/db').DatabaseClient, 'withTenantTx'>;

export class DatabaseAbandonedLeadPruner {
  constructor(private readonly database: RetentionDatabase = { withTenantTx }) {}

  async restrictAbandoned(input: {
    workspaceId: string;
    actorId: string;
    now: Date;
  }): Promise<{ restrictedLeads: number }> {
    const cutoff = new Date(
      input.now.getTime() - ABANDONED_LEAD_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    return this.database.withTenantTx(
      { workspaceId: input.workspaceId, actorId: input.actorId },
      async (tx) => {
        const abandoned = and(
          eq(leads.workspaceId, input.workspaceId),
          eq(leads.status, 'incomplete'),
          isNull(leads.customerDataRestrictedAt),
          lt(leads.updatedAt, cutoff),
        );
        const candidates = await tx
          .select({ id: leads.id })
          .from(leads)
          .where(abandoned)
          .limit(ABANDONED_LEAD_BATCH_SIZE);
        if (candidates.length === 0) return { restrictedLeads: 0 };
        const ids = candidates.map((row) => row.id);

        // Revoked, not deleted: a grant holds only a token hash, and deleting
        // one is reserved for an acknowledged customer erasure (migration 0023's
        // guard_customer_erasure).
        await tx
          .update(draftGrants)
          .set({ revokedAt: input.now })
          .where(
            and(
              eq(draftGrants.workspaceId, input.workspaceId),
              inArray(draftGrants.leadId, ids),
              isNull(draftGrants.revokedAt),
            ),
          );
        // The same conditions again: a lead submitted since the select is skipped.
        const restricted = await tx
          .update(leads)
          .set({
            fullName: null,
            email: null,
            phone: null,
            countryCode: null,
            payload: null,
            customerDataRestrictedAt: input.now,
            updatedAt: input.now,
          })
          .where(and(abandoned, inArray(leads.id, ids)))
          .returning({ id: leads.id });

        if (restricted.length > 0) {
          const requestId = randomUUID();
          await tx.insert(auditEvents).values(
            restricted.map(({ id }) => ({
              workspaceId: input.workspaceId,
              actorId: input.actorId,
              actorLabel: 'scheduler',
              action: 'lead.abandoned_draft_restricted',
              entity: 'lead',
              entityId: id,
              before: { status: 'incomplete' },
              after: { restricted: true, retentionDays: ABANDONED_LEAD_RETENTION_DAYS },
              requestId,
            })),
          );
        }
        return { restrictedLeads: restricted.length };
      },
    );
  }
}
