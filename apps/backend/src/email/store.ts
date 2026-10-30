import { and, desc, eq, or, sql } from 'drizzle-orm';
import {
  emailMessages,
  deletedEmailMessages,
  emailProviderEvents,
  emailSuppressions,
  followUpSchedules,
  marketingConsents,
  withTenantTx,
  type TenantTransaction,
} from '@gt-sales/db';
import { JobHandlerError, type EmailEligibilityChecker } from '@gt-sales/jobs';
import type { ProviderDeliveryResult } from '@gt-sales/adapters';
import { customerSubjectActive } from '../leads/restriction.js';

export type EmailMessageStatus =
  'queued' | 'sent' | 'delivered' | 'bounced' | 'complained' | 'failed' | 'uncertain';

export type SuppressionReason = 'hard_bounce' | 'complaint' | 'manual';

const suppressionReasons: readonly SuppressionReason[] = ['hard_bounce', 'complaint', 'manual'];

export interface QueueEmailMessageInput {
  workspaceId: string;
  actorId: string;
  messageId: string;
  template: string;
  /** The site template version the mail was rendered from; absent for built-in copy. */
  templateVersion?: number;
  messageClass: 'transactional' | 'marketing';
  contactHash: string;
  leadId?: string;
  orderId?: string;
}

export interface DeliveryStatusRow {
  messageId: string;
  template: string;
  status: EmailMessageStatus;
  providerId: string | null;
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DeliverySummary {
  sent: number;
  delivered: number;
  failed: number;
  uncertain: number;
}

export interface ProviderEventInput {
  workspaceId: string;
  actorId: string;
  providerEventId: string;
  provider: string;
  providerAccount: string;
  providerMessageId: string;
  hardBounce: boolean;
  eventType: 'delivered' | 'bounce' | 'complaint' | 'reject';
  messageId?: string;
  contactHash: string;
  receivedAt: Date;
}

export type ApplyProviderEventOutcome = 'applied' | 'duplicate' | 'invalid';

/**
 * The full email persistence surface T18 needs, beyond the pure eligibility
 * check `@gt-sales/jobs` requires from every registry.
 */
export interface EmailStore extends EmailEligibilityChecker {
  queueMessage(input: QueueEmailMessageInput): Promise<void>;
  applyProviderEvent(input: ProviderEventInput): Promise<ApplyProviderEventOutcome>;
  listDelivery(workspaceId: string, actorId: string): Promise<DeliveryStatusRow[]>;
  deliverySummary(workspaceId: string, actorId: string): Promise<DeliverySummary>;
  recordUnsubscribe(input: {
    workspaceId: string;
    contactHash: string;
    leadId?: string;
    orderId?: string;
    version: string;
    now: Date;
  }): Promise<void>;
}

type EmailDatabase = Pick<import('@gt-sales/db').DatabaseClient, 'withTenantTx'>;
const defaultDatabase: EmailDatabase = { withTenantTx };

function statusValue(value: string): EmailMessageStatus {
  const known: readonly EmailMessageStatus[] = [
    'queued',
    'sent',
    'delivered',
    'bounced',
    'complained',
    'failed',
    'uncertain',
  ];
  return known.find((status) => status === value) ?? 'uncertain';
}

/** Tenant-scoped persistence; all external publication happens through the outbox. */
export class DatabaseEmailStore implements EmailStore {
  constructor(private readonly database: EmailDatabase = defaultDatabase) {}

  async prepareDelivery(
    input: QueueEmailMessageInput & { provider: string; providerAccount: string },
  ): Promise<void> {
    await this.database.withTenantTx(
      { workspaceId: input.workspaceId, actorId: input.actorId },
      async (tx) => {
        if (!(await customerSubjectActive(tx, input.workspaceId, input)))
          throw new JobHandlerError('customer_data_restricted', false);
        const [deleted] = await tx
          .select({ id: deletedEmailMessages.messageId })
          .from(deletedEmailMessages)
          .where(
            and(
              eq(deletedEmailMessages.workspaceId, input.workspaceId),
              eq(deletedEmailMessages.messageId, input.messageId),
            ),
          )
          .limit(1);
        if (deleted) throw new JobHandlerError('customer_data_restricted', false);
        await tx
          .insert(emailMessages)
          .values({ ...input, status: 'queued' })
          .onConflictDoNothing();
        const [row] = await tx
          .select()
          .from(emailMessages)
          .where(
            and(
              eq(emailMessages.workspaceId, input.workspaceId),
              eq(emailMessages.messageId, input.messageId),
            ),
          )
          .for('update');
        if (
          !row ||
          row.contactHash !== input.contactHash ||
          (row.provider !== null &&
            (row.provider !== input.provider || row.providerAccount !== input.providerAccount))
        ) {
          throw new Error('email_delivery_binding_mismatch');
        }
        await tx
          .update(emailMessages)
          .set({ provider: input.provider, providerAccount: input.providerAccount })
          .where(
            and(
              eq(emailMessages.workspaceId, input.workspaceId),
              eq(emailMessages.messageId, input.messageId),
            ),
          );
      },
    );
  }

  async recordDeliveryResult(input: {
    workspaceId: string;
    actorId: string;
    messageId: string;
    result: ProviderDeliveryResult;
  }): Promise<void> {
    await this.database.withTenantTx(
      { workspaceId: input.workspaceId, actorId: input.actorId },
      async (tx) => {
        const [row] = await tx
          .select()
          .from(emailMessages)
          .where(
            and(
              eq(emailMessages.workspaceId, input.workspaceId),
              eq(emailMessages.messageId, input.messageId),
            ),
          )
          .for('update');
        if (!row) {
          const [deleted] = await tx
            .select({ id: deletedEmailMessages.messageId })
            .from(deletedEmailMessages)
            .where(
              and(
                eq(deletedEmailMessages.workspaceId, input.workspaceId),
                eq(deletedEmailMessages.messageId, input.messageId),
              ),
            )
            .limit(1);
          if (!deleted) throw new Error('email_delivery_missing');
          if (input.result.status === 'delivered')
            await tx
              .update(deletedEmailMessages)
              .set({ providerId: input.result.providerId })
              .where(
                and(
                  eq(deletedEmailMessages.workspaceId, input.workspaceId),
                  eq(deletedEmailMessages.messageId, input.messageId),
                  sql`${deletedEmailMessages.providerId} is null`,
                ),
              );
          return;
        }
        if (
          input.result.status === 'delivered' &&
          row.providerId &&
          row.providerId !== input.result.providerId
        ) {
          throw new Error('email_provider_id_mismatch');
        }
        await tx
          .update(emailMessages)
          .set({
            providerId:
              input.result.status === 'delivered' ? input.result.providerId : row.providerId,
            status: row.lastEventAt
              ? row.status
              : input.result.status === 'delivered'
                ? 'sent'
                : 'uncertain',
            lastErrorCode: input.result.status === 'uncertain' ? input.result.errorCode : null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(emailMessages.workspaceId, input.workspaceId),
              eq(emailMessages.messageId, input.messageId),
            ),
          );
      },
    );
  }

  async checkTransactional(input: {
    workspaceId: string;
    actorId: string;
    contactHash: string;
    orderId?: string;
    leadId?: string;
  }): Promise<{ eligible: boolean; reason?: string }> {
    return this.database.withTenantTx(
      { workspaceId: input.workspaceId, actorId: input.actorId },
      async (tx) => {
        if (!(await customerSubjectActive(tx, input.workspaceId, input)))
          return { eligible: false, reason: 'customer_data_restricted' };
        const suppressed = await isSuppressed(tx, input.workspaceId, input.contactHash);
        return suppressed ? { eligible: false, reason: suppressed } : { eligible: true };
      },
    );
  }

  async checkMarketing(input: {
    workspaceId: string;
    actorId: string;
    contactHash: string;
    leadId?: string;
    orderId?: string;
  }): Promise<{ eligible: boolean; reason?: string }> {
    return this.database.withTenantTx(
      { workspaceId: input.workspaceId, actorId: input.actorId },
      async (tx) => {
        if (!(await customerSubjectActive(tx, input.workspaceId, input)))
          return { eligible: false, reason: 'customer_data_restricted' };
        const suppressed = await isSuppressed(tx, input.workspaceId, input.contactHash);
        if (suppressed) return { eligible: false, reason: suppressed };
        const [latestConsent] = await tx
          .select({ marketingOptIn: marketingConsents.marketingOptIn })
          .from(marketingConsents)
          .where(
            and(
              eq(marketingConsents.workspaceId, input.workspaceId),
              eq(marketingConsents.contactHash, input.contactHash),
            ),
          )
          .orderBy(desc(marketingConsents.capturedAt))
          .limit(1);
        if (!latestConsent) return { eligible: false, reason: 'no_recorded_consent' };
        if (!latestConsent.marketingOptIn) return { eligible: false, reason: 'opted_out' };
        return { eligible: true };
      },
    );
  }

  async queueMessage(input: QueueEmailMessageInput): Promise<void> {
    await this.database.withTenantTx(
      { workspaceId: input.workspaceId, actorId: input.actorId },
      async (tx) => {
        if (!(await customerSubjectActive(tx, input.workspaceId, input))) return;
        await tx
          .insert(emailMessages)
          .values({
            workspaceId: input.workspaceId,
            messageId: input.messageId,
            template: input.template,
            templateVersion: input.templateVersion,
            messageClass: input.messageClass,
            leadId: input.leadId,
            contactHash: input.contactHash,
            status: 'queued',
          })
          .onConflictDoNothing();
      },
    );
  }

  async applyProviderEvent(input: ProviderEventInput): Promise<ApplyProviderEventOutcome> {
    return this.database.withTenantTx(
      { workspaceId: input.workspaceId, actorId: input.actorId },
      async (tx) => {
        const [deleted] = await tx
          .select({ id: deletedEmailMessages.messageId })
          .from(deletedEmailMessages)
          .where(
            and(
              eq(deletedEmailMessages.workspaceId, input.workspaceId),
              or(
                input.messageId ? eq(deletedEmailMessages.messageId, input.messageId) : undefined,
                and(
                  eq(deletedEmailMessages.provider, input.provider),
                  eq(deletedEmailMessages.providerAccount, input.providerAccount),
                  eq(deletedEmailMessages.providerId, input.providerMessageId),
                ),
              ),
            ),
          )
          .limit(1);
        if (deleted) return 'duplicate';
        // Correlate against a send prepared BEFORE the network call. A signed
        // provider event cannot select a tenant/contact or impersonate a job.
        const [message] = await tx
          .select()
          .from(emailMessages)
          .where(
            and(
              eq(emailMessages.workspaceId, input.workspaceId),
              eq(emailMessages.provider, input.provider),
              eq(emailMessages.providerAccount, input.providerAccount),
              input.messageId
                ? eq(emailMessages.messageId, input.messageId)
                : eq(emailMessages.providerId, input.providerMessageId),
            ),
          )
          .for('update');
        if (
          !message ||
          message.contactHash !== input.contactHash ||
          (message.providerId !== null && message.providerId !== input.providerMessageId)
        )
          return 'invalid';
        const inserted = await tx
          .insert(emailProviderEvents)
          .values({
            workspaceId: input.workspaceId,
            provider: input.provider,
            providerAccount: input.providerAccount,
            providerEventId: input.providerEventId,
            eventType: input.eventType,
            messageId: message.messageId,
            contactHash: message.contactHash,
            receivedAt: input.receivedAt,
          })
          .onConflictDoNothing()
          .returning({ id: emailProviderEvents.id });
        if (inserted.length === 0) return 'duplicate';
        const now = new Date();
        const nextStatus: EmailMessageStatus =
          input.eventType === 'delivered'
            ? 'delivered'
            : input.eventType === 'bounce'
              ? input.hardBounce
                ? 'bounced'
                : 'uncertain'
              : input.eventType === 'complaint'
                ? 'complained'
                : 'failed';
        // Late delivery or rejection must not erase a permanent bounce/complaint.
        const rank: Record<string, number> = {
          queued: 0,
          sent: 1,
          uncertain: 1,
          failed: 2,
          delivered: 3,
          bounced: 4,
          complained: 5,
        };
        const status =
          (rank[message.status] ?? 0) > (rank[nextStatus] ?? 0) ? message.status : nextStatus;
        await tx
          .update(emailMessages)
          .set({ status, providerId: input.providerMessageId, lastEventAt: now, updatedAt: now })
          .where(
            and(
              eq(emailMessages.workspaceId, input.workspaceId),
              eq(emailMessages.messageId, message.messageId),
            ),
          );
        if ((input.eventType === 'bounce' && input.hardBounce) || input.eventType === 'complaint') {
          const reason: SuppressionReason =
            input.eventType === 'bounce' ? 'hard_bounce' : 'complaint';
          await tx
            .insert(emailSuppressions)
            .values({
              workspaceId: input.workspaceId,
              contactHash: message.contactHash,
              reason,
              sourceEventId: input.providerEventId,
            })
            .onConflictDoNothing();
        }
        await tx
          .update(emailProviderEvents)
          .set({ appliedAt: now })
          .where(
            and(
              eq(emailProviderEvents.workspaceId, input.workspaceId),
              eq(emailProviderEvents.id, inserted[0]!.id),
            ),
          );
        return 'applied';
      },
    );
  }

  async listDelivery(workspaceId: string, actorId: string): Promise<DeliveryStatusRow[]> {
    return this.database.withTenantTx({ workspaceId, actorId }, async (tx) => {
      const rows = await tx
        .select({
          messageId: emailMessages.messageId,
          template: emailMessages.template,
          status: emailMessages.status,
          providerId: emailMessages.providerId,
          lastErrorCode: emailMessages.lastErrorCode,
          createdAt: emailMessages.createdAt,
          updatedAt: emailMessages.updatedAt,
        })
        .from(emailMessages)
        .where(eq(emailMessages.workspaceId, workspaceId))
        .orderBy(desc(emailMessages.createdAt))
        .limit(200);
      return rows.map((row) => ({ ...row, status: statusValue(row.status) }));
    });
  }

  async deliverySummary(workspaceId: string, actorId: string): Promise<DeliverySummary> {
    return this.database.withTenantTx({ workspaceId, actorId }, async (tx) => {
      const rows = await tx
        .select({ status: emailMessages.status, count: sql<number>`count(*)::int` })
        .from(emailMessages)
        .where(eq(emailMessages.workspaceId, workspaceId))
        .groupBy(emailMessages.status);
      const summary: DeliverySummary = { sent: 0, delivered: 0, failed: 0, uncertain: 0 };
      for (const row of rows) {
        if (row.status === 'delivered') summary.delivered += row.count;
        else if (row.status === 'failed' || row.status === 'bounced' || row.status === 'complained')
          summary.failed += row.count;
        else if (row.status === 'uncertain') summary.uncertain += row.count;
        else summary.sent += row.count;
      }
      return summary;
    });
  }

  async recordUnsubscribe(input: {
    workspaceId: string;
    contactHash: string;
    leadId?: string;
    orderId?: string;
    version: string;
    now: Date;
  }): Promise<void> {
    await this.database.withTenantTx(
      { workspaceId: input.workspaceId, actorId: input.workspaceId },
      async (tx) => {
        const active = await customerSubjectActive(tx, input.workspaceId, input);
        await tx.insert(marketingConsents).values({
          workspaceId: input.workspaceId,
          leadId: active ? input.leadId : undefined,
          contactHash: input.contactHash,
          marketingOptIn: false,
          version: active ? input.version : 'retained-opt-out',
          capturedAt: input.now,
        });
        // Cancel any still-scheduled marketing follow-ups for this contact's
        // lead/order so a pending job never fires after unsubscribe.
        if (input.leadId) {
          await tx
            .update(followUpSchedules)
            .set({ status: 'cancelled', cancelledReason: 'unsubscribed', updatedAt: input.now })
            .where(
              and(
                eq(followUpSchedules.workspaceId, input.workspaceId),
                eq(followUpSchedules.leadId, input.leadId),
                eq(followUpSchedules.status, 'scheduled'),
              ),
            );
        }
      },
    );
  }
}

async function isSuppressed(
  tx: TenantTransaction,
  workspaceId: string,
  contactHash: string,
): Promise<SuppressionReason | undefined> {
  const [row] = await tx
    .select({ reason: emailSuppressions.reason })
    .from(emailSuppressions)
    .where(
      and(
        eq(emailSuppressions.workspaceId, workspaceId),
        eq(emailSuppressions.contactHash, contactHash),
      ),
    )
    .limit(1);
  return row ? suppressionReasons.find((reason) => reason === row.reason) : undefined;
}
