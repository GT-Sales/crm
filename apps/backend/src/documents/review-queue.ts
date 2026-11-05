import { contextWorkspaceId, withTenantTx, type DatabaseClient } from '@gt-sales/db';
import {
  DOCUMENT_REVIEW_PAGE_SIZE,
  documentReviewQueueItemSchema,
  type DocumentReviewQueueItem,
  type DocumentReviewQueueStatus,
} from '@gt-sales/contracts';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import { LATEST_REVIEW, currentLeadDocuments } from '../leads/documents-check.js';
import type { Scope } from '../tenant-scope.js';

/**
 * Documents → the review queue. One page of the site's current documents (the
 * lead page's own `currentLeadDocuments` rule, with each file's latest review)
 * on active, unrestricted leads, filtered to those never reviewed or last
 * rejected. Documents a lead's frozen plan requires come first, then the
 * oldest upload, so the files that hold an order up are reviewed first.
 * Reads only; the review itself is the existing `files/:fileId/review` route.
 */
export interface DocumentReviewQueuePage {
  readonly items: readonly DocumentReviewQueueItem[];
  readonly total: number;
  readonly counts: { readonly toReview: number; readonly rejected: number };
}

export interface DocumentReviewQueueStore {
  list(
    scope: Scope,
    input: { status: DocumentReviewQueueStatus; page: number },
  ): Promise<DocumentReviewQueuePage>;
}

const iso = (column: string) =>
  sql.raw(`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);

/** The queue's rows before the status filter: current documents on active leads. */
const QUEUE_ROWS = sql`
  select
    f.id, f.document_type, f.detected_mime, f.size_bytes, f.revision, f.created_at,
    review.decision, review.created_at as reviewed_at,
    l.id as lead_id, l.lead_type, l.stage, l.external_ref,
    coalesce(l.full_name, l.email) as lead_name,
    coalesce(l.order_details -> 'plan' -> 'requiredDocuments' ? f.document_type, false) as required
  from app.leads l
  join app.files f on ${currentLeadDocuments(sql`l.workspace_id`, sql`l.id`)}
  ${LATEST_REVIEW}
  where l.workspace_id = ${contextWorkspaceId}
    and l.deleted_at is null
    and l.customer_data_restricted_at is null
`;

function statusFilter(status: DocumentReviewQueueStatus): SQL {
  return status === 'to_review' ? sql`q.decision is null` : sql`q.decision = 'rejected'`;
}

const rowSchema = z.object({
  id: z.uuid(),
  document_type: z.string(),
  detected_mime: z.string(),
  size_bytes: z.coerce.number().int().nonnegative(),
  revision: z.coerce.number().int().positive(),
  created_at: z.string(),
  decision: z.enum(['approved', 'rejected']).nullable(),
  reviewed_at: z.string().nullable(),
  lead_id: z.uuid(),
  lead_type: z.string(),
  stage: z.string(),
  external_ref: z.string().nullable(),
  lead_name: z.string().nullable(),
  required: z.boolean(),
  total: z.coerce.number().int().nonnegative(),
});

const countsSchema = z.object({
  to_review: z.coerce.number().int().nonnegative(),
  rejected: z.coerce.number().int().nonnegative(),
});

export class DatabaseDocumentReviewQueue implements DocumentReviewQueueStore {
  constructor(private readonly database: Pick<DatabaseClient, 'withTenantTx'> = { withTenantTx }) {}

  list(
    scope: Scope,
    input: { status: DocumentReviewQueueStatus; page: number },
  ): Promise<DocumentReviewQueuePage> {
    const offset = (input.page - 1) * DOCUMENT_REVIEW_PAGE_SIZE;
    return this.database.withTenantTx(scope, async (tx) => {
      await tx.execute(sql`set transaction read only`);
      await tx.execute(sql`select set_config('statement_timeout', '5000', true)`);
      const rows = await tx.execute<{ [key: string]: unknown }>(sql`
        select
          q.id, q.document_type, q.detected_mime, q.size_bytes, q.revision,
          ${iso('q.created_at')} as created_at,
          q.decision,
          case when q.reviewed_at is null then null else ${iso('q.reviewed_at')} end as reviewed_at,
          q.lead_id, q.lead_type, q.stage, q.external_ref, q.lead_name, q.required,
          count(*) over () as total
        from (${QUEUE_ROWS}) q
        where ${statusFilter(input.status)}
        order by q.required desc, q.created_at asc, q.id
        limit ${DOCUMENT_REVIEW_PAGE_SIZE} offset ${offset}
      `);
      const [counted] = await tx.execute<{ [key: string]: unknown }>(sql`
        select
          count(*) filter (where q.decision is null) as to_review,
          count(*) filter (where q.decision = 'rejected') as rejected
        from (${QUEUE_ROWS}) q
      `);
      const counts = countsSchema.parse(counted);
      const parsed = rows.map((row) => rowSchema.parse(row));
      const items = parsed.flatMap((row) => {
        // A row this version cannot show (say, a newer lead type) is left out
        // rather than failing the queue.
        const item = documentReviewQueueItemSchema.safeParse({
          document: {
            id: row.id,
            documentType: row.document_type,
            contentType: row.detected_mime,
            sizeBytes: row.size_bytes,
            revision: row.revision,
            createdAt: row.created_at,
            review:
              row.decision === null || row.reviewed_at === null
                ? null
                : { decision: row.decision, at: row.reviewed_at },
          },
          lead: {
            id: row.lead_id,
            leadType: row.lead_type,
            stage: row.stage,
            externalRef: row.external_ref,
            name: row.lead_name,
          },
          required: row.required,
        });
        return item.success ? [item.data] : [];
      });
      const total =
        parsed[0]?.total ?? (input.status === 'to_review' ? counts.to_review : counts.rejected);
      return {
        items,
        total,
        counts: { toReview: counts.to_review, rejected: counts.rejected },
      };
    });
  }
}
