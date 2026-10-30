import { and, eq, sql, type SQL } from 'drizzle-orm';
import {
  auditEvents,
  changeRequests,
  files,
  leadActivities,
  withTenantTx,
  type DatabaseClient,
  type TenantTransaction,
} from '@gt-sales/db';
import {
  CHANGEABLE_FIELD_KEYS,
  CHANGE_REQUEST_DOCUMENTS,
  CHANGE_REQUEST_STAGES,
  changeRequestFieldsSchema,
  type ChangeRequestFields,
  type StaffChangeRequest,
  type TrackingPendingChange,
} from '@gt-sales/contracts';
import { z } from 'zod';

import { isPlanAvailable } from '../leads/order.js';
import { nextSiteNumber } from '../leads/site-counter.js';
import { lockLead, type LockedLead } from '../leads/work-store.js';
import { loadPlanForFreeze } from '../plans/store.js';
import type { WebsiteScope } from './store.js';

/**
 * A customer's change requests from `/track` (spec ruling 3 and 4, plan T5–T7).
 * The requested values live only in `app.change_requests.requested`; the
 * timeline and the audit trail name the field keys and document types, never
 * a value. Every write locks the lead row first, then its request (always in
 * that order), so two tabs, or a customer and staff, serialize on the lead.
 * At most one request per lead is pending: a new one replaces it in place,
 * keeping its number and documents.
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

export type CustomerChangeOutcome =
  | { status: 'saved'; changeRequest: ChangeRequestRow; removedObjectKeys: string[] }
  | { status: 'not_found' }
  | { status: 'not_allowed' }
  | { status: 'invalid_field'; field: string };

export interface ChangeRequestStore {
  requestChange(
    input: WebsiteScope & {
      requestId: string;
      leadId: string;
      fields: ChangeRequestFields;
      now: Date;
    },
  ): Promise<CustomerChangeOutcome>;
  /** A finalized held file joins the lead's pending request (made if none); an earlier held file of its type is tombstoned. */
  attachDocument(
    input: WebsiteScope & { requestId: string; leadId: string; fileId: string; now: Date },
  ): Promise<CustomerChangeOutcome>;
  pendingForLead(
    tx: TenantTransaction,
    workspaceId: string,
    leadId: string,
  ): Promise<ChangeRequestRow | undefined>;
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

/** Pending requests matching `where` (on `app.change_requests r`), staged files in the order they joined. */
async function selectPendingRows(
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
      (
        select coalesce(json_agg(json_build_object(
          'fileId', f.id, 'documentType', f.document_type, 'objectKey', f.object_key
        ) order by s.position), '[]'::json)
        from unnest(r.staged_file_ids) with ordinality as s(file_id, position)
        join app.files f on f.workspace_id = r.workspace_id and f.id = s.file_id
      ) as staged
    from app.change_requests r
    where ${where} and r.status = 'pending'
    ${lock ? sql`for update of r` : sql``}
  `);
  return rows.map(toRow);
}

/** The lead's pending request, locked when `lock` is set (the lead must be locked first). */
async function selectPending(
  tx: TenantTransaction,
  workspaceId: string,
  leadId: string,
  lock: boolean,
): Promise<ChangeRequestRow | undefined> {
  const [row] = await selectPendingRows(
    tx,
    sql`r.workspace_id = ${workspaceId} and r.lead_id = ${leadId}`,
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
  const rows = await selectPendingRows(
    tx,
    sql`r.workspace_id = ${workspaceId} and r.lead_id in ${sql`(${sql.join(
      leadIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`}`,
    false,
  );
  return new Map(rows.map((row) => [row.leadId, row]));
}

/** The field keys asked for, in `CHANGEABLE_FIELD_KEYS` order. */
function fieldKeys(fields: ChangeRequestFields): string[] {
  return CHANGEABLE_FIELD_KEYS.filter((key) => fields[key] !== undefined);
}

const storedFormSchema = z.object({ payload: z.record(z.string(), z.unknown()) });

/** A form value as stored, read on its own: a stored payload is never strict-parsed. */
function storedFormValue(lead: LockedLead, key: string): unknown {
  const parsed = storedFormSchema.safeParse(lead.payload);
  return parsed.success ? parsed.data.payload[key] : undefined;
}

const isChangeStage = (stage: string) => CHANGE_REQUEST_STAGES.some((value) => value === stage);

/** The lead, locked, when the customer may still change it; else why not. */
async function lockChangeableLead(
  tx: TenantTransaction,
  workspaceId: string,
  leadId: string,
): Promise<{ lead: LockedLead } | { status: 'not_found' | 'not_allowed' }> {
  const lead = await lockLead(tx, workspaceId, leadId);
  if (!lead) return { status: 'not_found' };
  if (
    lead.trashed ||
    lead.status !== 'submitted' ||
    lead.leadType !== 'sim_order' ||
    !isChangeStage(lead.stage)
  ) {
    return { status: 'not_allowed' };
  }
  return { lead };
}

/** Why a change cannot be asked for: a plan the site does not sell, or a pickup with no address. */
async function refusedField(
  tx: TenantTransaction,
  workspaceId: string,
  lead: LockedLead,
  fields: ChangeRequestFields,
): Promise<string | undefined> {
  if (fields.planId !== undefined) {
    const found = await loadPlanForFreeze(tx, workspaceId, fields.planId);
    if (!isPlanAvailable(found, lead.leadType)) return 'planId';
  }
  const delivery = fields.delivery ?? storedFormValue(lead, 'delivery');
  if (delivery === 'pickup') {
    const address =
      fields.shippingAddress !== undefined
        ? fields.shippingAddress
        : storedFormValue(lead, 'shippingAddress');
    if (typeof address !== 'string' || address.trim() === '') return 'shippingAddress';
  }
  return undefined;
}

async function record(
  tx: TenantTransaction,
  input: WebsiteScope & { requestId: string; leadId: string },
  request: { id: string; requestNo: number },
  fields: string[],
  documents: string[],
): Promise<void> {
  const keys = { requestNo: request.requestNo, changeRequestId: request.id, fields, documents };
  await tx.insert(leadActivities).values({
    workspaceId: input.workspaceId,
    leadId: input.leadId,
    actorId: input.actorId,
    kind: 'system',
    data: { event: 'change_requested', ...keys },
  });
  await tx.insert(auditEvents).values({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    actorLabel: 'website credential',
    action: 'lead.change_requested',
    entity: 'lead',
    entityId: input.leadId,
    requestId: input.requestId,
    after: {
      changeRequestId: request.id,
      requestNo: request.requestNo,
      fields,
      documents,
    },
  });
}

type ChangeDatabase = Pick<DatabaseClient, 'withTenantTx'>;

export class DatabaseChangeRequestStore implements ChangeRequestStore {
  constructor(private readonly database: ChangeDatabase = { withTenantTx }) {}

  private tx<T>(scope: WebsiteScope, body: (tx: TenantTransaction) => Promise<T>): Promise<T> {
    return this.database.withTenantTx(
      { workspaceId: scope.workspaceId, actorId: scope.actorId },
      body,
    );
  }

  requestChange(
    input: WebsiteScope & {
      requestId: string;
      leadId: string;
      fields: ChangeRequestFields;
      now: Date;
    },
  ): Promise<CustomerChangeOutcome> {
    return this.tx(input, async (tx) => {
      const locked = await lockChangeableLead(tx, input.workspaceId, input.leadId);
      if (!('lead' in locked)) return locked;
      const field = await refusedField(tx, input.workspaceId, locked.lead, input.fields);
      if (field) return { status: 'invalid_field', field };

      const pending = await selectPending(tx, input.workspaceId, input.leadId, true);
      let request: { id: string; requestNo: number };
      if (pending) {
        // The customer's new values replace the old ones wholesale; documents stay.
        await tx
          .update(changeRequests)
          .set({
            requested: input.fields,
            version: sql`${changeRequests.version} + 1`,
            updatedAt: input.now,
          })
          .where(
            and(
              eq(changeRequests.workspaceId, input.workspaceId),
              eq(changeRequests.id, pending.id),
            ),
          );
        request = pending;
      } else {
        const requestNo = await nextSiteNumber(tx, input.workspaceId, 'change_request_no');
        const [inserted] = await tx
          .insert(changeRequests)
          .values({
            workspaceId: input.workspaceId,
            leadId: input.leadId,
            requestNo,
            requested: input.fields,
            createdBy: input.actorId,
            createdAt: input.now,
            updatedAt: input.now,
          })
          .returning({ id: changeRequests.id });
        if (!inserted) throw new Error('change request insert returned no row');
        request = { id: inserted.id, requestNo };
      }
      await record(tx, input, request, fieldKeys(input.fields), []);
      const saved = await selectPending(tx, input.workspaceId, input.leadId, false);
      if (!saved) throw new Error('change request vanished inside its own transaction');
      return { status: 'saved', changeRequest: saved, removedObjectKeys: [] };
    });
  }

  attachDocument(
    input: WebsiteScope & { requestId: string; leadId: string; fileId: string; now: Date },
  ): Promise<CustomerChangeOutcome> {
    return this.tx(input, async (tx) => {
      const locked = await lockChangeableLead(tx, input.workspaceId, input.leadId);
      if (!('lead' in locked)) return locked;

      // Only this lead's finalized held passport or visa joins its request.
      const [file] = await tx
        .select({ id: files.id, documentType: files.documentType })
        .from(files)
        .where(
          and(
            eq(files.workspaceId, input.workspaceId),
            eq(files.id, input.fileId),
            eq(files.recordType, 'lead'),
            eq(files.recordId, input.leadId),
            eq(files.status, 'available'),
            eq(files.heldForChangeRequest, true),
          ),
        )
        .limit(1);
      const documentType = documentTypeSchema.safeParse(file?.documentType);
      if (!file || !documentType.success) return { status: 'not_found' };

      const pending = await selectPending(tx, input.workspaceId, input.leadId, true);
      if (pending?.stagedFiles.some((staged) => staged.fileId === file.id)) {
        // Already joined (a repeated finalize): nothing changes.
        return { status: 'saved', changeRequest: pending, removedObjectKeys: [] };
      }

      const removedObjectKeys: string[] = [];
      let request: { id: string; requestNo: number };
      if (pending) {
        // An earlier held file of the same type is replaced: tombstoned, its object deleted after commit.
        const replaced = pending.stagedFiles.filter(
          (staged) => staged.documentType === documentType.data,
        );
        for (const staged of replaced) {
          const [gone] = await tx
            .update(files)
            .set({ status: 'deleted', deletedAt: input.now, updatedAt: input.now })
            .where(
              and(
                eq(files.workspaceId, input.workspaceId),
                eq(files.id, staged.fileId),
                eq(files.heldForChangeRequest, true),
                sql`${files.status} <> 'deleted'`,
              ),
            )
            .returning({ objectKey: files.objectKey });
          if (gone?.objectKey) removedObjectKeys.push(gone.objectKey);
          await tx.insert(auditEvents).values({
            workspaceId: input.workspaceId,
            actorId: input.actorId,
            actorLabel: 'website credential',
            action: 'file.deleted',
            entity: 'file',
            entityId: staged.fileId,
            requestId: input.requestId,
            after: { status: 'deleted', reason: 'replaced_in_change_request' },
          });
        }
        const kept = pending.stagedFiles
          .filter((staged) => staged.documentType !== documentType.data)
          .map((staged) => staged.fileId);
        await tx
          .update(changeRequests)
          .set({
            stagedFileIds: [...kept, file.id],
            version: sql`${changeRequests.version} + 1`,
            updatedAt: input.now,
          })
          .where(
            and(
              eq(changeRequests.workspaceId, input.workspaceId),
              eq(changeRequests.id, pending.id),
            ),
          );
        request = pending;
      } else {
        const requestNo = await nextSiteNumber(tx, input.workspaceId, 'change_request_no');
        const [inserted] = await tx
          .insert(changeRequests)
          .values({
            workspaceId: input.workspaceId,
            leadId: input.leadId,
            requestNo,
            requested: {},
            stagedFileIds: [file.id],
            createdBy: input.actorId,
            createdAt: input.now,
            updatedAt: input.now,
          })
          .returning({ id: changeRequests.id });
        if (!inserted) throw new Error('change request insert returned no row');
        request = { id: inserted.id, requestNo };
      }
      await record(tx, input, request, [], [documentType.data]);
      const saved = await selectPending(tx, input.workspaceId, input.leadId, false);
      if (!saved) throw new Error('change request vanished inside its own transaction');
      return { status: 'saved', changeRequest: saved, removedObjectKeys };
    });
  }

  pendingForLead(
    tx: TenantTransaction,
    workspaceId: string,
    leadId: string,
  ): Promise<ChangeRequestRow | undefined> {
    return selectPending(tx, workspaceId, leadId, false);
  }
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
