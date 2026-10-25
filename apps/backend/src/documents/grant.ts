import { and, eq, isNull } from 'drizzle-orm';
import { draftGrants, leads, withTenantTx } from '@gt-sales/db';

import { hashDraftGrantToken } from '../leads/token.js';

type DocumentDatabase = Pick<import('@gt-sales/db').DatabaseClient, 'withTenantTx'>;

/**
 * Resolves a storefront draft grant to the lead it authorises, inside the
 * already-established website tenant context. Uploads/downloads made by a
 * customer must prove ownership of the parent lead this way — a service
 * credential alone is not proof of which draft the caller owns (invariant 2).
 */
export interface DraftGrantVerifier {
  verifyLead(input: {
    workspaceId: string;
    actorId: string;
    grantToken: string;
    now: Date;
  }): Promise<string | undefined>;
}

export class DatabaseDraftGrantVerifier implements DraftGrantVerifier {
  constructor(private readonly database: DocumentDatabase = { withTenantTx }) {}

  async verifyLead(input: {
    workspaceId: string;
    actorId: string;
    grantToken: string;
    now: Date;
  }): Promise<string | undefined> {
    const tokenHash = hashDraftGrantToken(input.grantToken);
    return this.database.withTenantTx(
      { workspaceId: input.workspaceId, actorId: input.actorId },
      async (tx) => {
        const [grant] = await tx
          .select({
            leadId: draftGrants.leadId,
            expiresAt: draftGrants.expiresAt,
            revokedAt: draftGrants.revokedAt,
          })
          .from(draftGrants)
          .innerJoin(
            leads,
            and(eq(leads.workspaceId, draftGrants.workspaceId), eq(leads.id, draftGrants.leadId)),
          )
          .where(
            and(
              eq(draftGrants.workspaceId, input.workspaceId),
              isNull(leads.customerDataRestrictedAt),
              eq(draftGrants.tokenHash, tokenHash),
            ),
          )
          .limit(1);
        if (!grant) return undefined;
        if (grant.revokedAt !== null || grant.expiresAt.getTime() <= input.now.getTime()) {
          return undefined;
        }
        return grant.leadId;
      },
    );
  }
}
