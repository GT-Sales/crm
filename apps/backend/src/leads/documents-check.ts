import { sql, type SQL } from 'drizzle-orm';
import type { TenantTransaction } from '@gt-sales/db';

/**
 * The documents check of a stage move (`StageGate` `documents`), ported from
 * Canadian Plans' document prerequisite: each document type the order's
 * frozen plan requires needs a current file on the lead whose latest staff
 * review approved it. Derived on every move, never stored.
 */

/**
 * The lead's current documents, as the lead page lists them, for `app.files f`:
 * attached (`available`), on the lead, not replaced by a newer upload of the
 * same type, and not a licence photo given for the credit check (that belongs
 * to the ID check, `app.lead_identities`).
 */
export function currentLeadDocuments(workspaceId: SQL, leadId: SQL): SQL {
  return sql`
    f.workspace_id = ${workspaceId}
    and f.record_type = 'lead'
    and f.record_id = ${leadId}
    and f.status = 'available'
    and f.superseded_by_file_id is null
    and not exists (
      select 1 from app.lead_identities i
      where i.workspace_id = f.workspace_id and i.file_id = f.id
    )
  `;
}

/** A lateral join giving `review.decision` and `review.created_at`: the latest review of `app.files f`, if any. */
export const LATEST_REVIEW = sql`
  left join lateral (
    select r.decision, r.created_at
    from app.file_review_events r
    where r.workspace_id = f.workspace_id and r.file_id = f.id
    order by r.created_at desc, r.id desc
    limit 1
  ) review on true
`;

/**
 * The `required` document types the lead has no approved current file of, in
 * `required` order and each once. Only a file's latest review counts, so an
 * approval followed by a rejection is missing, and so is an approved file a
 * newer, unreviewed upload has replaced.
 */
export async function findMissingDocuments(
  tx: TenantTransaction,
  input: { workspaceId: string; leadId: string; required: readonly string[] },
): Promise<string[]> {
  const required = [...new Set(input.required)];
  if (required.length === 0) return [];
  const rows = await tx.execute<{ documentType: string }>(sql`
    select distinct f.document_type as "documentType"
    from app.files f
    ${LATEST_REVIEW}
    where ${currentLeadDocuments(sql`${input.workspaceId}`, sql`${input.leadId}`)}
      and review.decision = 'approved'
  `);
  const approved = new Set(rows.map((row) => row.documentType));
  return required.filter((documentType) => !approved.has(documentType));
}
