import { sql, type SQL } from 'drizzle-orm';
import type { TenantTransaction } from '@gt-sales/db';
import {
  CHANGE_REQUEST_DOCUMENTS,
  changeRequestFieldsSchema,
  type ChangeRequestFields,
  type StaffChangeRequest,
  type TrackingPendingChange,
} from '@gt-sales/contracts';
import { z } from 'zod';

/**
 * A customer's change request as stored (`app.change_requests`) and the
 * reads of it the website and the lead page share: its staged documents in
 * the order they joined, and the two ways it is shown.
 */

export type ChangeRequestDocumentType = (typeof CHANGE_REQUEST_DOCUMENTS)[number];

export interface ChangeRequestRow {
  id: string;
  leadId: string;
  requestNo: number;
  status: 'pending' | 'approved' | 'rejected';
  requested: ChangeRequestFields;
  stagedFiles: Array<{ fileId: string; documentType: ChangeRequestDocumentType }>;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const statusSchema = z.enum(['pending', 'approved', 'rejected']);
const documentTypeSchema = z.enum(CHANGE_REQUEST_DOCUMENTS);

interface RequestDbRow extends Record<string, unknown> {
  id: string;
  leadId: string;
  requestNo: number;
  status: string;
  requested: unknown;
  version: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  staged: unknown;
}

const stagedSchema = z.array(
  z.object({ fileId: z.uuid(), documentType: z.string(), objectKey: z.string().nullable() }),
);

/** A stored request; a value that no longer parses reads as not asked for. */
function toRow(row: RequestDbRow): ChangeRequestRow {
  const requested = changeRequestFieldsSchema.safeParse(row.requested);
  const staged = stagedSchema.safeParse(row.staged);
  return {
    id: row.id,
    leadId: row.leadId,
    requestNo: row.requestNo,
    status: statusSchema.parse(row.status),
    requested: requested.success ? requested.data : {},
    stagedFiles: (staged.success ? staged.data : []).flatMap((file) => {
      const documentType = documentTypeSchema.safeParse(file.documentType);
      return documentType.success ? [{ fileId: file.fileId, documentType: documentType.data }] : [];
    }),
    version: row.version,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

/** For `app.change_requests r`: its staged files, in the order they joined, as a JSON array. */
const STAGED_FILES = sql`(
  select coalesce(json_agg(json_build_object(
    'fileId', f.id, 'documentType', f.document_type, 'objectKey', f.object_key
  ) order by s.position), '[]'::json)
  from unnest(r.staged_file_ids) with ordinality as s(file_id, position)
  join app.files f on f.workspace_id = r.workspace_id and f.id = s.file_id
)`;

/** Requests matching `where` (on `app.change_requests r`), locked when `lock` is set. */
async function selectRows(
  tx: TenantTransaction,
  where: SQL,
  lock: boolean,
): Promise<ChangeRequestRow[]> {
  const rows = await tx.execute<RequestDbRow>(sql`
    select
      r.id,
      r.lead_id as "leadId",
      r.request_no as "requestNo",
      r.status,
      r.requested,
      r.version,
      r.created_at as "createdAt",
      r.updated_at as "updatedAt",
      ${STAGED_FILES} as staged
    from app.change_requests r
    where ${where}
    ${lock ? sql`for update of r` : sql``}
  `);
  return rows.map(toRow);
}

/** One request of the lead, whatever its status, locked (the lead must be locked first). */
export async function lockRequest(
  tx: TenantTransaction,
  workspaceId: string,
  leadId: string,
  changeRequestId: string,
): Promise<ChangeRequestRow | undefined> {
  const [row] = await selectRows(
    tx,
    sql`r.workspace_id = ${workspaceId} and r.lead_id = ${leadId} and r.id = ${changeRequestId}`,
    true,
  );
  return row;
}

/** The lead's pending request, locked when `lock` is set (the lead must be locked first). */
export async function selectPending(
  tx: TenantTransaction,
  workspaceId: string,
  leadId: string,
  lock: boolean,
): Promise<ChangeRequestRow | undefined> {
  const [row] = await selectRows(
    tx,
    sql`r.workspace_id = ${workspaceId} and r.lead_id = ${leadId} and r.status = 'pending'`,
    lock,
  );
  return row;
}

/** The pending request of each of `leadIds` that has one, by lead id (one read). */
export async function pendingForLeads(
  tx: TenantTransaction,
  workspaceId: string,
  leadIds: readonly string[],
): Promise<Map<string, ChangeRequestRow>> {
  if (leadIds.length === 0) return new Map();
  const ids = sql.join(
    leadIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = await selectRows(
    tx,
    sql`r.workspace_id = ${workspaceId} and r.lead_id in (${ids}) and r.status = 'pending'`,
    false,
  );
  return new Map(rows.map((row) => [row.leadId, row]));
}

const requestJsonSchema = z.object({
  id: z.uuid(),
  leadId: z.uuid(),
  requestNo: z.int(),
  status: z.string(),
  requested: z.unknown(),
  version: z.int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  staged: z.unknown(),
});

/** For `app.leads l`: the lead's pending request as one JSON value, or null (read with `pendingRequestFromJson`). */
export const PENDING_REQUEST_JSON = sql`(
  select json_build_object(
    'id', r.id, 'leadId', r.lead_id, 'requestNo', r.request_no, 'status', r.status,
    'requested', r.requested, 'version', r.version,
    'createdAt', r.created_at, 'updatedAt', r.updated_at,
    'staged', ${STAGED_FILES}
  )
  from app.change_requests r
  where r.workspace_id = l.workspace_id and r.lead_id = l.id and r.status = 'pending'
  limit 1
)`;

export function pendingRequestFromJson(value: unknown): ChangeRequestRow | undefined {
  const parsed = requestJsonSchema.safeParse(value);
  return parsed.success ? toRow(parsed.data) : undefined;
}

/** The pending request as `/track` shows it: the values asked for and the document types sent. */
export function toTrackingPendingChange(row: ChangeRequestRow): TrackingPendingChange {
  return {
    requestNo: row.requestNo,
    fields: row.requested,
    documents: row.stagedFiles.map((file) => file.documentType),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The request as the lead page shows it to staff who decide it. */
export function toStaffChangeRequest(row: ChangeRequestRow): StaffChangeRequest {
  return {
    id: row.id,
    requestNo: row.requestNo,
    status: row.status,
    fields: row.requested,
    documents: row.stagedFiles,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
