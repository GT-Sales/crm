import { and, eq, isNull } from 'drizzle-orm';
import { leads, withTenantTx } from '@gt-sales/db';
import type { DocumentParentType } from '@gt-sales/contracts';

import type { DocumentContextResolver } from './service.js';

type DocumentDatabase = Pick<import('@gt-sales/db').DatabaseClient, 'withTenantTx'>;

/**
 * Document kinds a lead may attach until the lead-type registry (phase 1)
 * supplies a per-type checklist. Kept deliberately narrow: identity and
 * immigration documents the current intake forms actually collect.
 */
export const DEFAULT_LEAD_DOCUMENT_TYPES: readonly string[] = [
  'passport',
  'visa',
  'study_permit',
  'work_permit',
  'drivers_licence',
  'provincial_id',
];

/**
 * Reads the document context from the tenant DB. Everything runs under tenant
 * RLS, so a parent belonging to another workspace simply returns nothing
 * (`found: false`). Only leads carry documents today; orders arrive in phase 3
 * and will resolve through the lead they belong to.
 */
export class DatabaseDocumentContextResolver implements DocumentContextResolver {
  constructor(private readonly database: DocumentDatabase = { withTenantTx }) {}

  async resolveChecklist(input: {
    workspaceId: string;
    actorId: string;
    recordType: DocumentParentType;
    recordId: string;
  }): Promise<{ found: false } | { found: true; allowed: readonly string[] }> {
    if (input.recordType !== 'lead') return { found: false };
    return this.database.withTenantTx(
      { workspaceId: input.workspaceId, actorId: input.actorId },
      async (tx) => {
        const [lead] = await tx
          .select({ id: leads.id })
          .from(leads)
          .where(
            and(
              eq(leads.workspaceId, input.workspaceId),
              isNull(leads.customerDataRestrictedAt),
              eq(leads.id, input.recordId),
            ),
          )
          .limit(1);
        if (!lead) return { found: false };
        return { found: true, allowed: DEFAULT_LEAD_DOCUMENT_TYPES };
      },
    );
  }

  /** No order records exist yet; an order-scoped lookup resolves to nothing. */
  async resolveOrderLeadId(_input: {
    workspaceId: string;
    actorId: string;
    orderId: string;
  }): Promise<string | undefined> {
    return undefined;
  }
}
