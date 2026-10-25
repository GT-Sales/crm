import type { EmailEligibilityChecker } from '@gt-sales/jobs';

export interface DueFollowUp {
  id: string;
  workspaceId: string;
  leadId?: string;
  orderId?: string;
  template: string;
  contactHash: string;
  toAddress: string;
  unsubscribeUrl?: string;
}

export type FollowUpOutcome = 'sent' | 'skipped_ineligible' | 'skipped_state' | 'cancelled';

/** Minimal read of the state a follow-up must be re-checked against (REQ 27). */
export interface LeadOrderStateReader {
  /** Returns undefined only if the lead genuinely no longer exists. */
  leadState(workspaceId: string, leadId: string): Promise<{ status: string } | undefined>;
  orderState(workspaceId: string, orderId: string): Promise<{ status: string } | undefined>;
}

/** Terminal lead/order states after which a follow-up must never send. */
const terminalLeadStatuses = new Set(['converted', 'abandoned', 'suppressed']);
const terminalOrderStatuses = new Set(['activated', 'cancelled', 'archived']);

export interface FollowUpScheduleStore {
  listDue(workspaceId: string, now: Date): Promise<DueFollowUp[]>;
  markSent(workspaceId: string, id: string, messageId: string): Promise<void>;
  markSkipped(workspaceId: string, id: string, reason: string): Promise<void>;
  markCancelled(workspaceId: string, id: string, reason: string): Promise<void>;
}

export interface EnqueueMarketingEmail {
  (input: {
    workspaceId: string;
    leadId: string;
    toAddress: string;
    contactHash: string;
    unsubscribeUrl: string;
  }): Promise<{ messageId: string }>;
}

/**
 * Runs due follow-ups. Every send re-checks eligibility (suppression +
 * marketing consent) and re-reads the referenced lead/order's current state
 * immediately before sending — never trusting the state at scheduling time
 * (REQ 27). A completed/cancelled/unsubscribed lead or order stops the
 * sequence instead of sending.
 */
export class FollowUpRunner {
  constructor(
    private readonly schedules: FollowUpScheduleStore,
    private readonly state: LeadOrderStateReader,
    private readonly eligibility: EmailEligibilityChecker,
    private readonly enqueue: EnqueueMarketingEmail,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async runDue(workspaceId: string, actorId: string): Promise<Record<FollowUpOutcome, number>> {
    const tally: Record<FollowUpOutcome, number> = {
      sent: 0,
      skipped_ineligible: 0,
      skipped_state: 0,
      cancelled: 0,
    };
    const due = await this.schedules.listDue(workspaceId, this.now());
    for (const item of due) {
      const outcome = await this.runOne(item, actorId);
      tally[outcome] += 1;
    }
    return tally;
  }

  private async runOne(item: DueFollowUp, actorId: string): Promise<FollowUpOutcome> {
    if (item.leadId) {
      const lead = await this.state.leadState(item.workspaceId, item.leadId);
      if (!lead || terminalLeadStatuses.has(lead.status)) {
        await this.schedules.markCancelled(item.workspaceId, item.id, 'lead_terminal');
        return 'cancelled';
      }
    }
    if (item.orderId) {
      const order = await this.state.orderState(item.workspaceId, item.orderId);
      if (!order || terminalOrderStatuses.has(order.status)) {
        await this.schedules.markCancelled(item.workspaceId, item.id, 'order_terminal');
        return 'cancelled';
      }
    }

    const check = await this.eligibility.checkMarketing({
      workspaceId: item.workspaceId,
      actorId,
      contactHash: item.contactHash,
      leadId: item.leadId,
      orderId: item.orderId,
    });
    if (!check.eligible) {
      await this.schedules.markSkipped(item.workspaceId, item.id, check.reason ?? 'ineligible');
      return 'skipped_ineligible';
    }

    if (!item.leadId) {
      await this.schedules.markSkipped(item.workspaceId, item.id, 'no_lead_reference');
      return 'skipped_state';
    }

    const { messageId } = await this.enqueue({
      workspaceId: item.workspaceId,
      leadId: item.leadId,
      toAddress: item.toAddress,
      contactHash: item.contactHash,
      unsubscribeUrl: item.unsubscribeUrl ?? '',
    });
    await this.schedules.markSent(item.workspaceId, item.id, messageId);
    return 'sent';
  }
}
