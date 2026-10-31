import { and, eq, sql } from 'drizzle-orm';
import {
  auditEvents,
  changeRequests,
  files,
  leadActivities,
  withTenantTx,
  type DatabaseClient,
  type TenantTransaction,
} from '@gt-sales/db';
import type { R2DocumentStore } from '@gt-sales/adapters';
import {
  CHANGEABLE_FIELD_KEYS,
  CHANGE_REQUEST_DOCUMENTS,
  CHANGE_REQUEST_STAGES,
  isEmailFillInKey,
  type ChangeDecisionEmailSkipped,
  type ChangeRequestFields,
  type LeadActivity,
  type LeadContactEdit,
  type LeadDetail,
  type PropertyCatalog,
} from '@gt-sales/contracts';
import { z } from 'zod';

import { readAutomationLead } from '../automations/run.js';
import { documentBucket } from '../documents/config.js';
import { releaseHeldFiles, tombstoneHeldFiles } from '../documents/store.js';
import { composeCustomerEmail } from '../email/compose.js';
import { queueComposedEmail } from '../email/queue.js';
import { isPlanAvailable } from '../leads/order.js';
import { nextSiteNumber } from '../leads/site-counter.js';
import { selectLeadDetail, toLeadActivity } from '../leads/staff-queries.js';
import {
  applyLeadUpdate,
  lockLead,
  type LeadUpdateContext,
  type LockedLead,
  type UpdateLeadWorkInput,
} from '../leads/work-store.js';
import { loadPlanForFreeze } from '../plans/store.js';
import type { WriteScope } from '../tenant-scope.js';
import { lockRequest, selectPending, type ChangeRequestRow } from './change-request-rows.js';
import type { WebsiteScope } from './store.js';

export {
  toStaffChangeRequest,
  toTrackingPendingChange,
  type ChangeRequestDocumentType,
  type ChangeRequestRow,
} from './change-request-rows.js';

/**
 * A customer's change requests from `/track` (spec ruling 3 and 4, plan T5–T7).
 * The requested values live only in `app.change_requests.requested`; the
 * timeline and the audit trail name the field keys and document types, never
 * a value. Every write locks the lead row first, then its request (always in
 * that order), so two tabs, or a customer and staff, serialize on the lead.
 * At most one request per lead is pending: a new one replaces it in place,
 * keeping its number and documents.
 */

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
  /** The file is the lead's held upload (an intent or a finalized file), not deleted. */
  isHeldUpload(input: WebsiteScope & { leadId: string; fileId: string }): Promise<boolean>;
  /**
   * A finalized held upload that joined no request (the order can no longer
   * change): tombstoned, unless a pending request holds it; its object key,
   * for deletion after commit.
   */
  discardUnjoinedHeldFile(
    input: WebsiteScope & { requestId: string; leadId: string; fileId: string; now: Date },
  ): Promise<string[]>;
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

const documentTypeSchema = z.enum(CHANGE_REQUEST_DOCUMENTS);

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
          // Already gone (staff removed it): nothing to delete, nothing to audit.
          if (!gone) continue;
          if (gone.objectKey) removedObjectKeys.push(gone.objectKey);
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

  discardUnjoinedHeldFile(
    input: WebsiteScope & { requestId: string; leadId: string; fileId: string; now: Date },
  ): Promise<string[]> {
    return this.tx(input, async (tx) => {
      // The lead first, as every change request write locks it.
      await lockLead(tx, input.workspaceId, input.leadId);
      const [gone] = await tx
        .update(files)
        .set({ status: 'deleted', deletedAt: input.now, updatedAt: input.now })
        .where(
          and(
            eq(files.workspaceId, input.workspaceId),
            eq(files.id, input.fileId),
            eq(files.recordType, 'lead'),
            eq(files.recordId, input.leadId),
            eq(files.heldForChangeRequest, true),
            sql`${files.status} <> 'deleted'`,
            sql`not exists (
              select 1 from app.change_requests r
              where r.workspace_id = ${input.workspaceId} and r.status = 'pending'
                and ${input.fileId}::uuid = any(r.staged_file_ids))`,
          ),
        )
        .returning({ objectKey: files.objectKey });
      if (!gone) return [];
      await tx.insert(auditEvents).values({
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        actorLabel: 'website credential',
        action: 'file.deleted',
        entity: 'file',
        entityId: input.fileId,
        requestId: input.requestId,
        after: { status: 'deleted', reason: 'change_request_not_allowed' },
      });
      return gone.objectKey ? [gone.objectKey] : [];
    });
  }

  isHeldUpload(input: WebsiteScope & { leadId: string; fileId: string }): Promise<boolean> {
    return this.tx(input, async (tx) => {
      const [file] = await tx
        .select({ id: files.id })
        .from(files)
        .where(
          and(
            eq(files.workspaceId, input.workspaceId),
            eq(files.id, input.fileId),
            eq(files.recordType, 'lead'),
            eq(files.recordId, input.leadId),
            eq(files.heldForChangeRequest, true),
            sql`${files.status} <> 'deleted'`,
          ),
        )
        .limit(1);
      return file !== undefined;
    });
  }
}

export type DecisionOutcome =
  | {
      status: 'approved' | 'rejected';
      lead: LeadDetail;
      activities: LeadActivity[];
      emailSkipped?: ChangeDecisionEmailSkipped;
    }
  | { status: 'not_found' | 'resolved' | 'version_conflict' | 'trashed' }
  | { status: 'invalid_field'; field: string };

export interface DecideInput extends WriteScope {
  leadId: string;
  changeRequestId: string;
  expectedVersion: number;
  catalog: PropertyCatalog;
}

/** An approval the lead update refused: the transaction rolls back and the request stays pending. */
class ApprovalRefused extends Error {
  constructor(readonly field: string) {
    super('change_request_approval_refused');
  }
}

/** The SIM order form keys a request may change (the rest are the contact's and the order's). */
const FORM_KEYS = [
  'delivery',
  'arrivalDate',
  'permitType',
  'canadaAddress',
  'shippingAddress',
  'flightBooked',
] as const;

/** The lead update an approval applies: the requested values, as a staff edit would. */
function approvalUpdate(input: DecideInput, requested: ChangeRequestFields): UpdateLeadWorkInput {
  const contact: LeadContactEdit = {
    ...(requested.fullName !== undefined ? { fullName: requested.fullName } : {}),
    ...(requested.phone !== undefined ? { phone: requested.phone } : {}),
  };
  const form: Record<string, string | boolean | null> = {};
  for (const key of FORM_KEYS) {
    const value = requested[key];
    if (value !== undefined) form[key] = value;
  }
  return {
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    requestId: input.requestId,
    leadId: input.leadId,
    catalog: input.catalog,
    ...(Object.keys(contact).length > 0 ? { contact } : {}),
    ...(Object.keys(form).length > 0 ? { form } : {}),
    ...(requested.planId !== undefined ? { order: { planId: requested.planId } } : {}),
  };
}

/** Entries in the lead page's order: newest first, one transaction's entries by id descending. */
function newestFirst(activities: readonly LeadActivity[]): LeadActivity[] {
  return [...activities].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

/**
 * Change requests end to end: the customer's two writes (delegated to the
 * store, then the replaced files' objects deleted, best effort) and staff's
 * decision. A decision locks the lead, then the request; approval applies the
 * requested values through `applyLeadUpdate` (the staff edit's own checks,
 * timeline and audit, a new plan re-frozen) and makes the held documents
 * current; rejection tombstones them and deletes their objects after commit.
 * Either way the request is resolved (`resolved_at` and `resolved_by` both),
 * a `change_approved`/`change_rejected` entry and audit name keys only, and
 * the decision mail is always queued in the same transaction, or the outcome
 * says why it was not (`emailSkipped`).
 */
export class ChangeRequestService {
  private readonly database: Pick<DatabaseClient, 'withTenantTx'>;
  private readonly bucket: string;

  constructor(
    private readonly dependencies: {
      store: ChangeRequestStore;
      context: LeadUpdateContext;
      objects?: Pick<R2DocumentStore, 'deleteObject'>;
      bucket?: string;
      database?: Pick<DatabaseClient, 'withTenantTx'>;
    },
  ) {
    this.database = dependencies.database ?? { withTenantTx };
    this.bucket = dependencies.bucket ?? documentBucket();
  }

  async requestChange(
    input: Parameters<ChangeRequestStore['requestChange']>[0],
  ): Promise<CustomerChangeOutcome> {
    const outcome = await this.dependencies.store.requestChange(input);
    if (outcome.status === 'saved')
      await this.deleteObjects(input.workspaceId, outcome.removedObjectKeys);
    return outcome;
  }

  async attachDocument(
    input: Parameters<ChangeRequestStore['attachDocument']>[0],
  ): Promise<CustomerChangeOutcome> {
    const outcome = await this.dependencies.store.attachDocument(input);
    if (outcome.status === 'saved') {
      await this.deleteObjects(input.workspaceId, outcome.removedObjectKeys);
    } else if (outcome.status === 'not_allowed' || outcome.status === 'not_found') {
      // Finalized but joining nothing (the order moved on meanwhile): never keep it orphaned.
      const keys = await this.dependencies.store.discardUnjoinedHeldFile(input);
      await this.deleteObjects(input.workspaceId, keys);
    }
    return outcome;
  }

  /** The file is the lead's held upload: the only file a customer grant may finalize. */
  isHeldUpload(input: Parameters<ChangeRequestStore['isHeldUpload']>[0]): Promise<boolean> {
    return this.dependencies.store.isHeldUpload(input);
  }

  approve(input: DecideInput): Promise<DecisionOutcome> {
    return this.decide('approved', input);
  }

  reject(input: DecideInput): Promise<DecisionOutcome> {
    return this.decide('rejected', input);
  }

  private async decide(
    decision: 'approved' | 'rejected',
    input: DecideInput,
  ): Promise<DecisionOutcome> {
    const { context } = this.dependencies;
    let removedObjectKeys: string[] = [];
    let outcome: DecisionOutcome;
    try {
      outcome = await this.database.withTenantTx(
        { workspaceId: input.workspaceId, actorId: input.actorId },
        async (tx): Promise<DecisionOutcome> => {
          const lead = await lockLead(tx, input.workspaceId, input.leadId);
          if (!lead) return { status: 'not_found' };
          if (lead.trashed) return { status: 'trashed' };
          const request = await lockRequest(
            tx,
            input.workspaceId,
            input.leadId,
            input.changeRequestId,
          );
          if (!request) return { status: 'not_found' };
          if (request.status !== 'pending') return { status: 'resolved' };
          if (request.version !== input.expectedVersion) return { status: 'version_conflict' };

          const fields = fieldKeys(request.requested);
          const documents = request.stagedFiles.map((file) => file.documentType);
          const held = {
            workspaceId: input.workspaceId,
            actorId: input.actorId,
            requestId: input.requestId,
            fileIds: request.stagedFiles.map((file) => file.fileId),
          };
          const activities: LeadActivity[] = [];
          if (decision === 'approved') {
            const updated = await applyLeadUpdate(
              tx,
              context,
              approvalUpdate(input, request.requested),
            );
            if (updated.status === 'invalid_field') throw new ApprovalRefused(updated.field);
            if (updated.status !== 'updated') {
              throw new Error(`change request approval refused: ${updated.status}`);
            }
            activities.push(...updated.activities);
            await releaseHeldFiles(tx, held);
          } else {
            removedObjectKeys = await tombstoneHeldFiles(tx, held);
          }

          const now = new Date();
          await tx
            .update(changeRequests)
            .set({ status: decision, resolvedBy: input.actorId, resolvedAt: now, updatedAt: now })
            .where(
              and(
                eq(changeRequests.workspaceId, input.workspaceId),
                eq(changeRequests.id, request.id),
              ),
            );
          const event = decision === 'approved' ? 'change_approved' : 'change_rejected';
          // Keys and document types only, as the request's own entries carry them.
          const keys = {
            requestNo: request.requestNo,
            changeRequestId: request.id,
            fields,
            documents,
          };
          const [entry] = await tx
            .insert(leadActivities)
            .values({
              workspaceId: input.workspaceId,
              leadId: input.leadId,
              actorId: input.actorId,
              kind: 'system',
              data: { event, ...keys },
            })
            .returning({
              id: leadActivities.id,
              actorId: leadActivities.actorId,
              kind: leadActivities.kind,
              body: leadActivities.body,
              data: leadActivities.data,
              createdAt: leadActivities.createdAt,
            });
          if (!entry) throw new Error('activity insert did not return a row');
          activities.push(toLeadActivity({ ...entry, createdAt: entry.createdAt.toISOString() }));
          await tx.insert(auditEvents).values({
            workspaceId: input.workspaceId,
            actorId: input.actorId,
            actorLabel: 'staff actor',
            action: `lead.change_request_${decision}`,
            entity: 'lead',
            entityId: input.leadId,
            requestId: input.requestId,
            after: { changeRequestId: request.id, requestNo: request.requestNo, fields, documents },
          });

          // The decision mail always goes, in this transaction, or the answer says why not.
          const template = event;
          const composed = await composeCustomerEmail(tx, context.emailEnvironment, {
            workspaceId: input.workspaceId,
            template,
            recipient: {
              kind: 'lead',
              lead: await readAutomationLead(tx, input.workspaceId, input.leadId),
            },
          });
          let emailSkipped: ChangeDecisionEmailSkipped | undefined;
          if (composed.kind === 'ready') {
            const queued = await queueComposedEmail(tx, {
              workspaceId: input.workspaceId,
              actorId: input.actorId,
              requestId: input.requestId,
              leadId: input.leadId,
              dedupeKey: `${input.leadId}:${template}:${request.id}`,
              payload: composed.payload,
              automation: null,
            });
            if (queued.activity) activities.push(queued.activity);
          } else {
            // Both decision mails are built-in templates, which always exist.
            if (composed.reason === 'template_unavailable') {
              throw new Error(`built-in ${template} template unavailable`);
            }
            const missing = composed.missing?.filter(isEmailFillInKey);
            emailSkipped = {
              template,
              reason: composed.reason,
              ...(missing ? { missing } : {}),
            };
          }

          const detail = await selectLeadDetail(tx, input.workspaceId, input.leadId, input.catalog);
          if (!detail) throw new Error('lead vanished inside its own transaction');
          return {
            status: decision,
            lead: detail,
            activities: newestFirst(activities),
            ...(emailSkipped ? { emailSkipped } : {}),
          };
        },
      );
    } catch (error) {
      if (error instanceof ApprovalRefused) return { status: 'invalid_field', field: error.field };
      throw error;
    }
    await this.deleteObjects(input.workspaceId, removedObjectKeys);
    return outcome;
  }

  /** After commit, best effort: a failed delete leaves an orphan object, logged by code only. */
  private async deleteObjects(workspaceId: string, objectKeys: readonly string[]): Promise<void> {
    const objects = this.dependencies.objects;
    if (!objects) return;
    for (const objectKey of objectKeys) {
      try {
        await objects.deleteObject({ workspaceId, bucket: this.bucket, objectKey });
      } catch (error) {
        console.warn(
          JSON.stringify({
            event: 'change_request_object_delete_failed',
            workspaceId,
            code:
              error instanceof Error && /^[A-Za-z0-9_]{1,64}$/.test(error.name)
                ? error.name
                : 'unknown',
          }),
        );
      }
    }
  }
}
