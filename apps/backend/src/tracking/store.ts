import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import {
  outboxJobs,
  trackingChallenges,
  withTenantTx,
  type DatabaseClient,
  type TenantTransaction,
} from '@gt-sales/db';
import {
  CHANGE_REQUEST_STAGES,
  MAX_TRACKED_ORDERS,
  SIM_ORDER_DELIVERIES,
  SIM_ORDER_PERMIT_TYPES,
  TRACKING_CODE_JOB_TYPE,
  TRACKING_MAX_ATTEMPTS,
  orderDateSchema,
  orderLeadTypeSchema,
  trackingCodeJobPayloadSchema,
  trackingOrderSchema,
  trackingStageWord,
  type TrackingDocumentState,
  type TrackingOrder,
  type TrackingPendingChange,
} from '@gt-sales/contracts';
import { orderLeadTypes } from '@gt-sales/types';
import { z } from 'zod';

import { sanitizeLogIdentifier } from '../http/logger.js';
import { LATEST_REVIEW, currentLeadDocuments } from '../leads/documents-check.js';
import { toLeadOrder } from '../leads/order.js';
import { pendingForLeads, toTrackingPendingChange } from './change-request-rows.js';
import { hashesEqual } from './secrets.js';

/**
 * Customer tracking persistence (ported from Canadian Plans'
 * `tracking/store.ts`, adapted to leads). Every read and write runs in the
 * website credential's tenant transaction, and every lead lookup matches the
 * verified email in the same query, so a grant never reaches another email's
 * or another site's order. `consume` locks the newest pending challenge so two
 * concurrent verifications consume it at most once.
 */

export type ConsumeOutcome = 'verified' | 'invalid' | 'expired' | 'exhausted' | 'not_found';

/** The site a website credential belongs to, and the credential itself as the actor. */
export interface WebsiteScope {
  workspaceId: string;
  actorId: string;
}

export interface QueueChallengeInput extends WebsiteScope {
  challengeId: string;
  normalizedEmail: string;
  emailHash: string;
  codeHash: string;
  sealedCode: string;
  contactHash: string;
  expiresAt: Date;
  now: Date;
}

/** One of the verified email's orders, resolved from the reference the customer sent. */
export interface TrackedLeadRef {
  leadId: string;
  leadType: string;
  stage: string;
}

export interface TrackingStore {
  hasTrackableLeads(input: WebsiteScope & { normalizedEmail: string }): Promise<boolean>;
  /** Supersedes the email's pending challenge and its unsent job, then inserts one challenge and one job. */
  createChallengeAndQueue(input: QueueChallengeInput): Promise<'queued' | 'no_leads'>;
  consume(
    input: WebsiteScope & {
      normalizedEmail: string;
      emailHash: string;
      candidateCodeHash: string;
      now: Date;
    },
  ): Promise<ConsumeOutcome>;
  listOrders(input: WebsiteScope & { normalizedEmail: string }): Promise<TrackingOrder[]>;
  resolveLead(
    input: WebsiteScope & { normalizedEmail: string; reference: string },
  ): Promise<TrackedLeadRef | undefined>;
}

type TrackingDatabase = Pick<DatabaseClient, 'withTenantTx'>;

const ORDER_LEAD_TYPES = sql.raw(orderLeadTypes.map((type) => `'${type}'`).join(', '));

/**
 * The leads `/track` shows for `normalizedEmail` on the site (ruling 2), for
 * `app.leads l`: submitted, not archived, not restricted, an order lead type,
 * and the contact's email the verified one.
 */
function trackable(workspaceId: string, normalizedEmail: string): SQL {
  return sql`
    l.workspace_id = ${workspaceId}
    and l.status = 'submitted'
    and l.deleted_at is null
    and l.customer_data_restricted_at is null
    and l.lead_type in (${ORDER_LEAD_TYPES})
    and lower(btrim(l.email)) = ${normalizedEmail}
  `;
}

async function trackableLeadExists(
  tx: TenantTransaction,
  input: { workspaceId: string; normalizedEmail: string },
): Promise<boolean> {
  const rows = await tx.execute<{ found: number }>(sql`
    select 1 as found from app.leads l
    where ${trackable(input.workspaceId, input.normalizedEmail)}
    limit 1
  `);
  return rows.length > 0;
}

async function markConsumed(
  tx: TenantTransaction,
  workspaceId: string,
  challengeId: string,
  now: Date,
): Promise<void> {
  await tx
    .update(trackingChallenges)
    .set({ status: 'consumed', consumedAt: now })
    .where(
      and(eq(trackingChallenges.workspaceId, workspaceId), eq(trackingChallenges.id, challengeId)),
    );
}

/** In the caller's transaction: the challenge is still pending, unexpired and under 5 attempts. */
export async function pendingDelivery(
  tx: TenantTransaction,
  input: { workspaceId: string; challengeId: string; now: Date },
): Promise<{ codeHash: string; emailHash: string } | undefined> {
  const [row] = await tx
    .select({
      codeHash: trackingChallenges.codeHash,
      emailHash: trackingChallenges.emailHash,
      expiresAt: trackingChallenges.expiresAt,
      attempts: trackingChallenges.attempts,
    })
    .from(trackingChallenges)
    .where(
      and(
        eq(trackingChallenges.workspaceId, input.workspaceId),
        eq(trackingChallenges.id, input.challengeId),
        eq(trackingChallenges.status, 'pending'),
      ),
    )
    .limit(1);
  if (
    !row ||
    row.expiresAt.getTime() <= input.now.getTime() ||
    row.attempts >= TRACKING_MAX_ATTEMPTS
  ) {
    return undefined;
  }
  return { codeHash: row.codeHash, emailHash: row.emailHash };
}

// The form keys a customer sees on `/track`, read one by one: a stored
// payload may carry keys outside the website's schema (an imported order's
// `simNumber` and `customerNotes`), so it is never strict-parsed.
const formEnvelopeSchema = z.object({ payload: z.record(z.string(), z.unknown()) });
const textValue = z.string().min(1);
const deliveryValue = z.enum(SIM_ORDER_DELIVERIES);
const permitTypeValue = z.enum(SIM_ORDER_PERMIT_TYPES);

function formOf(stored: unknown): Record<string, unknown> {
  const parsed = formEnvelopeSchema.safeParse(stored);
  return parsed.success ? parsed.data.payload : {};
}

function read<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const documentRowSchema = z.array(
  z.object({ documentType: z.string().min(1).max(64), decision: z.string().nullable() }),
);

/**
 * Each document the order needs or has, as the customer sees it: the frozen
 * plan's required types first, in its order, then any other type with a
 * current file. A current file's latest review decides its state.
 */
function customerDocuments(
  required: readonly string[],
  current: z.infer<typeof documentRowSchema>,
): TrackingOrder['documents'] {
  const decisions = new Map(current.map((row) => [row.documentType, row.decision]));
  const types = [...new Set([...required, ...current.map((row) => row.documentType).sort()])];
  return types.map((documentType) => {
    let state: TrackingDocumentState = 'missing';
    if (decisions.has(documentType)) {
      const decision = decisions.get(documentType);
      state =
        decision === 'approved'
          ? 'approved'
          : decision === 'rejected'
            ? 'needs_replacement'
            : 'received';
    }
    return { documentType, state };
  });
}

interface TrackedLeadRow extends Record<string, unknown> {
  id: string;
  leadType: string;
  stage: string;
  externalRef: string | null;
  fullName: string | null;
  phone: string | null;
  payload: unknown;
  orderDetails: unknown;
  createdAt: Date | string;
  documents: unknown;
}

const isChangeStage = (stage: string) => CHANGE_REQUEST_STAGES.some((value) => value === stage);

function toTrackingOrder(
  row: TrackedLeadRow,
  pendingChange: TrackingPendingChange | null,
): TrackingOrder | undefined {
  const leadType = orderLeadTypeSchema.safeParse(row.leadType);
  if (!leadType.success) return undefined;
  const form = formOf(row.payload);
  const order = toLeadOrder(row.orderDetails);
  const documents = documentRowSchema.safeParse(row.documents);
  return {
    reference: row.externalRef ?? row.id,
    leadType: leadType.data,
    stage: row.stage,
    stageLabel: trackingStageWord(row.leadType, row.stage),
    submittedAt: new Date(row.createdAt).toISOString(),
    plan: order.plan
      ? {
          id: order.plan.planId,
          name: order.plan.name,
          priceMinor: order.plan.priceMinor,
          billingPeriod: order.plan.billingPeriod,
        }
      : null,
    quantity: order.quantity,
    delivery: read(deliveryValue, form['delivery']),
    courier: order.courier,
    trackingNumber: order.trackingNumber,
    dispatchedAt: order.dispatchedAt,
    simNumber: read(textValue, form['simNumber']),
    details: {
      fullName: row.fullName,
      phone: row.phone,
      arrivalDate: read(orderDateSchema, form['arrivalDate']),
      permitType: read(permitTypeValue, form['permitType']),
      canadaAddress: read(textValue, form['canadaAddress']),
      shippingAddress: read(textValue, form['shippingAddress']),
      flightBooked: read(z.boolean(), form['flightBooked']),
    },
    documents: customerDocuments(
      order.plan?.requiredDocuments ?? [],
      documents.success ? documents.data : [],
    ),
    canRequestChange: leadType.data === 'sim_order' && isChangeStage(row.stage),
    pendingChange,
  };
}

/**
 * The order as the contract allows it, or undefined when a stored value does
 * not fit (an order number of spaces, a document type staff imported in
 * another shape): that one order is left out, so it cannot break the
 * customer's whole list, and a warning names only the lead and the failing
 * path, never a value.
 */
function listable(
  workspaceId: string,
  row: TrackedLeadRow,
  pendingChange: TrackingPendingChange | null,
): TrackingOrder | undefined {
  const built = toTrackingOrder(row, pendingChange);
  const parsed = trackingOrderSchema.safeParse(built);
  if (parsed.success) return parsed.data;
  const path = built === undefined ? 'leadType' : parsed.error.issues[0]?.path.join('.');
  console.warn(
    JSON.stringify({
      event: 'tracking_order_unlistable',
      workspaceId: sanitizeLogIdentifier(workspaceId) ?? 'unknown',
      leadId: sanitizeLogIdentifier(row.id) ?? 'unknown',
      path: sanitizeLogIdentifier(path) ?? 'unknown',
    }),
  );
  return undefined;
}

export class DatabaseTrackingStore implements TrackingStore {
  constructor(private readonly database: TrackingDatabase = { withTenantTx }) {}

  private tx<T>(scope: WebsiteScope, body: (tx: TenantTransaction) => Promise<T>): Promise<T> {
    return this.database.withTenantTx(
      { workspaceId: scope.workspaceId, actorId: scope.actorId },
      body,
    );
  }

  hasTrackableLeads(input: WebsiteScope & { normalizedEmail: string }): Promise<boolean> {
    return this.tx(input, (tx) => trackableLeadExists(tx, input));
  }

  createChallengeAndQueue(input: QueueChallengeInput): Promise<'queued' | 'no_leads'> {
    return this.tx(input, async (tx) => {
      // Serialize code requests for one email on one site: an email-scoped
      // challenge has no single row to lock. The key is the keyed email hash,
      // never the address, and the lock ends with this transaction.
      await tx.execute(
        sql`select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`tracking-challenge\n${input.workspaceId}\n${input.emailHash}`}, 0))`,
      );
      // Recheck inside the write: an email whose orders went (archived or
      // restricted) between the first check and now gets no code.
      if (!(await trackableLeadExists(tx, input))) return 'no_leads';

      const superseded = await tx
        .update(trackingChallenges)
        .set({ status: 'consumed', consumedAt: input.now })
        .where(
          and(
            eq(trackingChallenges.workspaceId, input.workspaceId),
            eq(trackingChallenges.emailHash, input.emailHash),
            eq(trackingChallenges.status, 'pending'),
          ),
        )
        .returning({ id: trackingChallenges.id });
      if (superseded.length > 0) {
        await tx
          .update(outboxJobs)
          .set({
            status: 'completed',
            completedAt: input.now,
            providerId: 'skipped:superseded',
            payload: sql`jsonb_build_object('challengeId', ${outboxJobs.payload}->>'challengeId')`,
            updatedAt: input.now,
          })
          .where(
            and(
              eq(outboxJobs.workspaceId, input.workspaceId),
              eq(outboxJobs.jobType, TRACKING_CODE_JOB_TYPE),
              eq(outboxJobs.status, 'pending'),
              inArray(
                sql<string>`${outboxJobs.payload}->>'challengeId'`,
                superseded.map((row) => row.id),
              ),
            ),
          );
      }

      await tx.insert(trackingChallenges).values({
        id: input.challengeId,
        workspaceId: input.workspaceId,
        emailHash: input.emailHash,
        codeHash: input.codeHash,
        expiresAt: input.expiresAt,
      });
      await tx.insert(outboxJobs).values({
        workspaceId: input.workspaceId,
        jobType: TRACKING_CODE_JOB_TYPE,
        payloadVersion: 1,
        dedupeKey: input.challengeId,
        payload: trackingCodeJobPayloadSchema.parse({
          challengeId: input.challengeId,
          toAddress: input.normalizedEmail,
          contactHash: input.contactHash,
          sealedCode: input.sealedCode,
          expiresAt: input.expiresAt.toISOString(),
        }),
      });
      return 'queued';
    });
  }

  consume(
    input: WebsiteScope & {
      normalizedEmail: string;
      emailHash: string;
      candidateCodeHash: string;
      now: Date;
    },
  ): Promise<ConsumeOutcome> {
    return this.tx(input, async (tx) => {
      const [challenge] = await tx
        .select({
          id: trackingChallenges.id,
          codeHash: trackingChallenges.codeHash,
          attempts: trackingChallenges.attempts,
          expiresAt: trackingChallenges.expiresAt,
        })
        .from(trackingChallenges)
        .where(
          and(
            eq(trackingChallenges.workspaceId, input.workspaceId),
            eq(trackingChallenges.emailHash, input.emailHash),
            eq(trackingChallenges.status, 'pending'),
          ),
        )
        .orderBy(desc(trackingChallenges.createdAt), desc(trackingChallenges.id))
        .limit(1)
        .for('update');
      if (!challenge) return 'not_found';

      if (challenge.expiresAt.getTime() <= input.now.getTime()) {
        await markConsumed(tx, input.workspaceId, challenge.id, input.now);
        return 'expired';
      }
      if (challenge.attempts >= TRACKING_MAX_ATTEMPTS) {
        await markConsumed(tx, input.workspaceId, challenge.id, input.now);
        return 'exhausted';
      }
      if (!hashesEqual(challenge.codeHash, input.candidateCodeHash)) {
        await tx
          .update(trackingChallenges)
          .set({ attempts: challenge.attempts + 1 })
          .where(
            and(
              eq(trackingChallenges.workspaceId, input.workspaceId),
              eq(trackingChallenges.id, challenge.id),
            ),
          );
        return 'invalid';
      }
      await markConsumed(tx, input.workspaceId, challenge.id, input.now);
      // A right code for an email whose orders went since the request verifies nothing.
      return (await trackableLeadExists(tx, input)) ? 'verified' : 'not_found';
    });
  }

  listOrders(input: WebsiteScope & { normalizedEmail: string }): Promise<TrackingOrder[]> {
    return this.tx(input, async (tx) => {
      const rows = await tx.execute<TrackedLeadRow>(sql`
        select
          l.id,
          l.lead_type as "leadType",
          l.stage,
          l.external_ref as "externalRef",
          l.full_name as "fullName",
          l.phone,
          l.payload,
          l.order_details as "orderDetails",
          l.created_at as "createdAt",
          (
            select coalesce(json_agg(json_build_object(
              'documentType', d.document_type,
              'decision', d.decision
            )), '[]'::json)
            from (
              select distinct on (f.document_type) f.document_type, review.decision
              from app.files f
              ${LATEST_REVIEW}
              where ${currentLeadDocuments(sql`l.workspace_id`, sql`l.id`)}
              order by f.document_type, f.created_at desc, f.id desc
            ) d
          ) as documents
        from app.leads l
        where ${trackable(input.workspaceId, input.normalizedEmail)}
        order by l.created_at desc, l.id desc
        limit ${MAX_TRACKED_ORDERS}
      `);
      const pending = await pendingForLeads(
        tx,
        input.workspaceId,
        rows.map((row) => row.id),
      );
      return rows.flatMap((row) => {
        const request = pending.get(row.id);
        const order = listable(
          input.workspaceId,
          row,
          request ? toTrackingPendingChange(request) : null,
        );
        return order ? [order] : [];
      });
    });
  }

  resolveLead(
    input: WebsiteScope & { normalizedEmail: string; reference: string },
  ): Promise<TrackedLeadRef | undefined> {
    return this.tx(input, async (tx) => {
      // The reference is the order number, or the lead id of an order that has
      // none: matched together with the email, in one query.
      const [row] = await tx.execute<{ leadId: string; leadType: string; stage: string }>(sql`
        select l.id as "leadId", l.lead_type as "leadType", l.stage
        from app.leads l
        where ${trackable(input.workspaceId, input.normalizedEmail)}
          and (
            l.external_ref = ${input.reference}
            or (l.external_ref is null and l.id::text = ${input.reference})
          )
        order by l.created_at desc, l.id desc
        limit 1
      `);
      return row ? { leadId: row.leadId, leadType: row.leadType, stage: row.stage } : undefined;
    });
  }
}
