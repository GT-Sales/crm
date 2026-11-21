import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';
import type { R2DocumentStore } from '@gt-sales/adapters';
import { auditEvents, draftGrants, files, leadTasks, leads, withTenantTx } from '@gt-sales/db';

import { enqueueDeletedFile } from '../documents/store.js';

/**
 * SEC-12, owner decision (22 Oct 2026): an order form
 * that is still `incomplete` 90 days after its last change has the visitor's
 * name, email, phone, country, answers and custom property values erased and
 * its resume links revoked.
 * The row stays, restricted, as an anonymous count (source and offer kept).
 * Submitted leads are never touched; they belong to an order.
 *
 * Audit M-2: the same run also erases what the lead row only points at, so a
 * passport uploaded to a draft does not outlive the draft. Its files are
 * tombstoned and their objects deleted after commit; its identities (sealed
 * SIN, licence link, and CanadaWide's legacy plain-text copy), task titles
 * and note texts go; the attribution keeps only the source fields the reports
 * count (`utmSource`, `utmMedium`, `utmCampaign`, `partnerCode`,
 * `partnerCodeMatched`, `referrerHost`) and the order details only the offer
 * (plan, quantity, payment and commission states); and the contact link is
 * cleared, the global contact row deleted when no lead on any site still
 * references it (`app.erase_restricted_lead_data`, migration 0030).
 *
 * Issue #109: a lead restricted by an older version of this job gets the
 * same erasure, a batch per run. It comes back into a run while it still
 * holds anything a draft restricted today would not (`restrictedWithLeftovers`),
 * and the same field list (`erasedLeadFields`) is applied to it, so both
 * generations end with the same permitted fields; once it holds nothing
 * more it is never picked again, so a second run changes nothing. Trimming
 * the attribution of an already restricted lead needs migration 0042 (the
 * guard refuses it before); until that is applied those leads keep their
 * attribution extras, are not picked for them, and the run says so.
 */
export const ABANDONED_LEAD_RETENTION_DAYS = 90;
/** Bounded per run so one daily tick never holds a long lock. */
export const ABANDONED_LEAD_BATCH_SIZE = 1000;

/** Attribution keys a restricted lead loses: free text that can carry an identifier. */
const ERASED_ATTRIBUTION_KEYS = ['utmTerm', 'utmContent', 'landingPath'] as const;
/** Order details a restricted lead loses: everything about a person's delivery. */
const ERASED_ORDER_KEYS = [
  'courier',
  'trackingNumber',
  'dispatchedAt',
  'activatedAt',
  'activationNumber',
  'activationAccount',
  'documentsOverride',
] as const;

/**
 * What a restricted lead's own row loses, for a draft restricted now and for
 * one restricted by an older version of this job alike. `trimAttribution`
 * is false only for an already restricted lead before migration 0042.
 */
function erasedLeadFields(trimAttribution: boolean) {
  return {
    fullName: null,
    email: null,
    phone: null,
    countryCode: null,
    payload: null,
    customValues: sql`'{}'::jsonb`,
    contactId: null,
    ...(trimAttribution
      ? {
          attribution: sql`${leads.attribution} - ${sql.raw(textArray(ERASED_ATTRIBUTION_KEYS))}`,
        }
      : {}),
    orderDetails: sql`${leads.orderDetails} - ${sql.raw(textArray(ERASED_ORDER_KEYS))}`,
  };
}

type RetentionDatabase = Pick<import('@gt-sales/db').DatabaseClient, 'withTenantTx'>;
type Tx = Parameters<Parameters<typeof withTenantTx>[1]>[0];

export interface AbandonedLeadResult {
  restrictedLeads: number;
  /** Leads restricted before files and identities were erased with them, finished now. */
  finishedLeads: number;
  deletedObjects: number;
  failedDeletes: number;
}

export interface AbandonedLeadPrunerOptions {
  /** Object storage, when configured. Without it there are no stored objects to delete. */
  objects?: Pick<R2DocumentStore, 'deleteObject'>;
  /** While the nightly backup holds its lease, object deletes wait for the next run. */
  backupLease?: { isActive(): Promise<boolean> };
}

export class DatabaseAbandonedLeadPruner {
  constructor(
    private readonly database: RetentionDatabase = { withTenantTx },
    private readonly options: AbandonedLeadPrunerOptions = {},
  ) {}

  async restrictAbandoned(input: {
    workspaceId: string;
    actorId: string;
    now: Date;
  }): Promise<AbandonedLeadResult> {
    // Tombstoning a file and deleting its object happen in one run, so with
    // the backup running the whole pass waits (as DocumentService.sweepExpired
    // does): a tombstone whose object was never deleted would be forgotten.
    if (await this.options.backupLease?.isActive()) {
      return { restrictedLeads: 0, finishedLeads: 0, deletedObjects: 0, failedDeletes: 0 };
    }
    const cutoff = new Date(
      input.now.getTime() - ABANDONED_LEAD_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    const outcome = await this.database.withTenantTx(
      { workspaceId: input.workspaceId, actorId: input.actorId },
      async (tx) => {
        const abandoned = and(
          eq(leads.workspaceId, input.workspaceId),
          eq(leads.status, 'incomplete'),
          isNull(leads.customerDataRestrictedAt),
          lt(leads.updatedAt, cutoff),
        );
        // Locked, so a submit racing this run waits and is then re-checked
        // against `abandoned` (READ COMMITTED re-evaluates a locked row): a
        // lead submitted meanwhile is skipped before anything is erased.
        const candidates = await tx
          .select({ id: leads.id, contactId: leads.contactId })
          .from(leads)
          .where(abandoned)
          .limit(ABANDONED_LEAD_BATCH_SIZE)
          .for('update');
        const ids = candidates.map((row) => row.id);

        let restricted: { id: string }[] = [];
        if (ids.length > 0) {
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
          restricted = await tx
            .update(leads)
            .set({
              ...erasedLeadFields(true),
              customerDataRestrictedAt: input.now,
              updatedAt: input.now,
            })
            .where(and(abandoned, inArray(leads.id, ids)))
            .returning({ id: leads.id });
        }

        // Leads restricted by an older version of this job still hold what
        // a draft restricted today loses (files, identities, tasks, notes, a
        // contact link, custom values, attribution extras): finish a batch
        // of them too, with the same field list. Migration 0042 is applied
        // by hand; before it the guard refuses an attribution change on a
        // restricted lead, so those extras wait and are not selected on.
        const [trim] = await tx.execute<{ present: boolean }>(
          sql`select to_regprocedure('app.restricted_lead_erased_attribution_keys()') is not null as present`,
        );
        const trimAttribution = trim?.present === true;
        if (!trimAttribution) {
          console.warn(
            JSON.stringify({
              event: 'restricted_attribution_trim_unavailable',
              workspaceId: input.workspaceId,
            }),
          );
        }
        const leftovers = await restrictedWithLeftovers(tx, input.workspaceId, trimAttribution);
        const restrictedIds = new Set(restricted.map((row) => row.id));
        const finished = leftovers.filter((row) => !restrictedIds.has(row.id));
        if (finished.length > 0) {
          await tx
            .update(leads)
            .set(erasedLeadFields(trimAttribution))
            .where(
              and(
                eq(leads.workspaceId, input.workspaceId),
                inArray(
                  leads.id,
                  finished.map((row) => row.id),
                ),
              ),
            );
        }

        const eraseIds = [...restrictedIds, ...finished.map((row) => row.id)];
        const eraseContacts = [
          ...new Set([
            ...candidates.flatMap((row) =>
              row.contactId && restrictedIds.has(row.id) ? [row.contactId] : [],
            ),
            ...finished.flatMap((row) => (row.contactId ? [row.contactId] : [])),
          ]),
        ];
        let objectKeys: { bucket: string; key: string }[] = [];
        if (eraseIds.length > 0) {
          objectKeys = await eraseLeadAttachments(tx, input.workspaceId, eraseIds, input.now);
          // Migration 0030 is applied by hand; a backend deployed before it
          // still restricts and erases what its own grants reach, and says so.
          const [fn] = await tx.execute<{ present: boolean }>(
            sql`select to_regprocedure('app.erase_restricted_lead_data(uuid,uuid[],uuid[])') is not null as present`,
          );
          if (fn?.present) {
            // The function takes at most 1000 leads and 1000 contacts a call
            // (`too_many_ids`), and a run can hold a full batch of newly due
            // drafts plus older restricted leads: one call per slice of both
            // lists. The contacts' leads were unlinked above, so a contact is
            // decided on its own, whichever call carries it.
            const calls = Math.ceil(
              Math.max(eraseIds.length, eraseContacts.length) / RESTRICTED_ERASURE_BATCH,
            );
            for (let call = 0; call < calls; call += 1) {
              const from = call * RESTRICTED_ERASURE_BATCH;
              const to = from + RESTRICTED_ERASURE_BATCH;
              await tx.execute(
                sql`select * from app.erase_restricted_lead_data(${input.workspaceId}::uuid, ${uuidArray(eraseIds.slice(from, to))}, ${uuidArray(eraseContacts.slice(from, to))})`,
              );
            }
          } else {
            console.warn(
              JSON.stringify({
                event: 'restricted_lead_erasure_function_missing',
                workspaceId: input.workspaceId,
              }),
            );
          }
          await eraseAiChatTurns(tx, input.workspaceId, eraseIds);
        }

        const requestId = randomUUID();
        const audits = [
          ...restricted.map(({ id }) => ({
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
          ...finished.map(({ id }) => ({
            workspaceId: input.workspaceId,
            actorId: input.actorId,
            actorLabel: 'scheduler',
            action: 'lead.restricted_data_erased',
            entity: 'lead',
            entityId: id,
            before: null,
            after: { erased: true },
            requestId,
          })),
        ];
        if (audits.length > 0) await tx.insert(auditEvents).values(audits);
        return { restricted: restricted.length, finished: finished.length, objectKeys };
      },
    );

    // After commit, best effort: a failed delete leaves an orphan object no
    // row points at (never served), counted, never retried blindly.
    let deletedObjects = 0;
    let failedDeletes = 0;
    if (this.options.objects) {
      for (const object of outcome.objectKeys) {
        try {
          await this.options.objects.deleteObject({
            workspaceId: input.workspaceId,
            bucket: object.bucket,
            objectKey: object.key,
          });
          deletedObjects += 1;
        } catch {
          failedDeletes += 1;
        }
      }
    }
    return {
      restrictedLeads: outcome.restricted,
      finishedLeads: outcome.finished,
      deletedObjects,
      failedDeletes,
    };
  }
}

/**
 * Audit B2: Ask AI's saved turns that name these (now restricted) leads lose
 * their text in the same transaction, for every member of the site
 * (`app.erase_restricted_lead_ai_turns`, migration 0039); their files go with
 * the scheduler's next `document_cleanup`, objects first. Until 0039 is
 * applied the turns stay stored but are never replayed (the history reads the
 * lead's state), and this says so; the migration erases the turns of every
 * lead restricted before it.
 */
async function eraseAiChatTurns(
  tx: Tx,
  workspaceId: string,
  leadIds: readonly string[],
): Promise<void> {
  const [fn] = await tx.execute<{ present: boolean }>(
    sql`select to_regprocedure('app.erase_restricted_lead_ai_turns(uuid,uuid[])') is not null as present`,
  );
  if (!fn?.present) {
    console.warn(JSON.stringify({ event: 'ai_chat_erasure_function_missing', workspaceId }));
    return;
  }
  for (let at = 0; at < leadIds.length; at += AI_CHAT_ERASURE_BATCH) {
    await tx.execute(
      sql`select * from app.erase_restricted_lead_ai_turns(${workspaceId}::uuid, ${uuidArray(leadIds.slice(at, at + AI_CHAT_ERASURE_BATCH))})`,
    );
  }
}

/** The 0030 function takes at most this many leads, and this many contacts, per call. */
const RESTRICTED_ERASURE_BATCH = 1000;

/** The 0039 function takes at most this many leads per call. */
const AI_CHAT_ERASURE_BATCH = 1000;

/** A constant SQL `text[]` literal from code-owned keys (never request data). */
function textArray(keys: readonly string[]): string {
  for (const key of keys) if (!/^[A-Za-z]+$/.test(key)) throw new Error('invalid key');
  return `array[${keys.map((key) => `'${key}'`).join(',')}]::text[]`;
}

function uuidArray(ids: readonly string[]) {
  return sql`${`{${ids.join(',')}}`}::uuid[]`;
}

/**
 * Restricted leads of this site that still hold something a draft restricted
 * today loses: on the row itself (`erasedLeadFields`) or in what it points at.
 * A lead that holds none of it is not returned, which is what makes a second
 * run a no-op and lets each run take the next batch.
 */
async function restrictedWithLeftovers(
  tx: Tx,
  workspaceId: string,
  trimAttribution: boolean,
): Promise<{ id: string; contactId: string | null }[]> {
  const attributionExtras = trimAttribution
    ? sql`or jsonb_exists_any(${leads.attribution}, ${sql.raw(textArray(ERASED_ATTRIBUTION_KEYS))})`
    : sql``;
  return tx
    .select({ id: leads.id, contactId: leads.contactId })
    .from(leads)
    .where(
      and(
        eq(leads.workspaceId, workspaceId),
        isNotNull(leads.customerDataRestrictedAt),
        sql`(
          ${leads.contactId} is not null
          or ${leads.fullName} is not null
          or ${leads.email} is not null
          or ${leads.phone} is not null
          or ${leads.countryCode} is not null
          or ${leads.payload} is not null
          or ${leads.customValues} <> '{}'::jsonb
          or jsonb_exists_any(${leads.orderDetails}, ${sql.raw(textArray(ERASED_ORDER_KEYS))})
          ${attributionExtras}
          or exists (select 1 from app.files f where f.workspace_id = ${leads.workspaceId}
            and f.record_type = 'lead' and f.record_id = ${leads.id} and f.status <> 'deleted')
          or exists (select 1 from app.lead_identities i where i.workspace_id = ${leads.workspaceId}
            and i.lead_id = ${leads.id})
          or exists (select 1 from app.lead_tasks t where t.workspace_id = ${leads.workspaceId}
            and t.lead_id = ${leads.id})
          or exists (select 1 from app.lead_activities a where a.workspace_id = ${leads.workspaceId}
            and a.lead_id = ${leads.id} and a.body is not null)
        )`,
      ),
    )
    .limit(ABANDONED_LEAD_BATCH_SIZE)
    .for('update');
}

/**
 * Tombstones the leads' files (the one write a restricted lead's file still
 * allows) and deletes their tasks, returning every object key to remove.
 */
async function eraseLeadAttachments(
  tx: Tx,
  workspaceId: string,
  leadIds: string[],
  now: Date,
): Promise<{ bucket: string; key: string }[]> {
  await tx
    .update(files)
    .set({ status: 'deleted', deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(files.workspaceId, workspaceId),
        eq(files.recordType, 'lead'),
        inArray(files.recordId, leadIds),
        ne(files.status, 'deleted'),
      ),
    );
  // Every file the leads ever had, tombstoned earlier ones included: a
  // tombstone alone leaves its object in the bucket. Deleting an object that
  // is already gone is a no-op.
  const tombstoned = await tx
    .select({
      id: files.id,
      bucket: files.bucket,
      stagingKey: files.stagingKey,
      candidateKey: files.candidateKey,
      objectKey: files.objectKey,
    })
    .from(files)
    .where(
      and(
        eq(files.workspaceId, workspaceId),
        eq(files.recordType, 'lead'),
        inArray(files.recordId, leadIds),
      ),
    );
  await tx
    .delete(leadTasks)
    .where(and(eq(leadTasks.workspaceId, workspaceId), inArray(leadTasks.leadId, leadIds)));
  // Recorded in this transaction (#82): the deletes after commit are best
  // effort, and the cleanup sweep retries each object until storage confirms.
  for (const row of tombstoned) await enqueueDeletedFile(tx, workspaceId, row);
  const keys = new Map<string, { bucket: string; key: string }>();
  for (const row of tombstoned) {
    for (const key of [row.stagingKey, row.candidateKey, row.objectKey]) {
      if (key) keys.set(`${row.bucket}\u0000${key}`, { bucket: row.bucket, key });
    }
  }
  return [...keys.values()];
}
