import { and, eq } from 'drizzle-orm';
import { leads, type TenantTransaction } from '@gt-sales/db';
import {
  emailTemplateLabel,
  isOrderLeadType,
  leadFormSchema,
  type BuiltInAutomation,
  type CustomerEmailTemplate,
  type EmailSkipped,
  type LeadActivity,
} from '@gt-sales/contracts';
import { z } from 'zod';

import { composeCustomerEmail, type ComposeOutcome } from '../email/compose.js';
import type { FillInLead } from '../email/fill-in-values.js';
import { queueComposedEmail } from '../email/queue.js';
import type { CustomerEmailEnvironment } from '../email/senders.js';
import { sanitizeLogIdentifier } from '../http/logger.js';
import { toLeadOrder } from '../leads/order.js';
import { enabledAutomationKeys, type AutomationStore } from './store.js';

/** A lead's stored custom values: an object of values by property key. */
const storedValuesSchema = z.record(z.string(), z.unknown());

/**
 * Fires the built-in automation rules a stage move or a website submit
 * triggered, inside that write's transaction: each rule the site has on
 * composes its template from the lead as now stored and queues it, or records
 * why it could not. A rule that is off does nothing at all. The mail is
 * queued once per occurrence (the move's `status_change` entry, or
 * `submitted`), so a retried write never mails twice. A lead the customer
 * never submitted (`status` still `incomplete`, an abandoned checkout) is not
 * an order: moving it fires no stage rule at all.
 */

/** The lead a rule writes to: its fill-ins, its address and whether the customer submitted it. */
export type AutomationLead = FillInLead & { id: string; email: string | null; submitted: boolean };

export interface RunAutomationsInput {
  workspaceId: string;
  actorId: string;
  requestId: string;
  lead: AutomationLead;
  automations: readonly BuiltInAutomation[];
  /** The `status_change` activity id of a move, or `submitted`. */
  occurrence: string;
  environment: CustomerEmailEnvironment;
  store: AutomationStore;
}

export interface RunAutomationsResult {
  /** The rules that were on but could not send, in rule order. */
  skipped: EmailSkipped[];
  /** The `customer_emailed` timeline entries of the mails queued, in rule order. */
  activities: LeadActivity[];
}

/** What the rules that were on did: the mails they queued and the ones they could not send. */
export async function runAutomations(
  tx: TenantTransaction,
  input: RunAutomationsInput,
): Promise<RunAutomationsResult> {
  const { workspaceId, lead } = input;
  // As if every stage rule were off: no mail, no run, no skip.
  const rules = lead.submitted
    ? input.automations
    : input.automations.filter((rule) => rule.trigger.kind !== 'stage_entered');
  const enabled = await enabledAutomationKeys(
    tx,
    workspaceId,
    rules.map((rule) => rule.key),
  );
  const skipped: EmailSkipped[] = [];
  const activities: LeadActivity[] = [];
  for (const rule of rules) {
    if (!enabled.has(rule.key)) continue;
    const template = rule.action.template;

    let composed: ComposeOutcome;
    try {
      // In a savepoint, so a failure leaves the move or submit's transaction usable.
      composed = await tx.transaction((savepoint) =>
        composeCustomerEmail(savepoint, input.environment, {
          workspaceId,
          template,
          recipient: { kind: 'lead', lead },
        }),
      );
    } catch {
      // A stored template that no longer parses is a bug to fix, not a
      // reason to refuse staff's move or the customer's order.
      logComposeFailure({ requestId: input.requestId, workspaceId, rule: rule.key, template });
      continue;
    }

    if (composed.kind === 'skipped') {
      // A built-in rule sends a built-in template, which always exists.
      if (composed.reason === 'template_unavailable') continue;
      await input.store.recordRun(tx, {
        workspaceId,
        key: rule.key,
        leadId: lead.id,
        outcome: 'skipped',
        reason: composed.reason,
      });
      skipped.push({
        automation: rule.key,
        flowName: rule.label,
        template,
        templateName: emailTemplateLabel(template),
        reason: composed.reason,
        ...(composed.missing ? { missing: composed.missing } : {}),
      });
      continue;
    }

    const queued = await queueComposedEmail(tx, {
      workspaceId,
      actorId: input.actorId,
      requestId: input.requestId,
      leadId: lead.id,
      dedupeKey: `${lead.id}:${rule.key}:${input.occurrence}`,
      payload: composed.payload,
      automation: rule.key,
    });
    // A dedupe hit: this occurrence already mailed, and was already counted.
    if (!queued.queued || queued.jobId === null) continue;
    await input.store.recordRun(tx, {
      workspaceId,
      key: rule.key,
      leadId: lead.id,
      outcome: 'queued',
      jobId: queued.jobId,
    });
    if (queued.activity) activities.push(queued.activity);
  }
  return { skipped, activities };
}

/** The fill-in lead of a stored lead row: its form's values and, for an order type, its order. */
export function automationLeadOf(row: {
  id: string;
  leadType: string;
  status: string;
  fullName: string | null;
  email: string | null;
  externalRef: string | null;
  payload: unknown;
  customValues: unknown;
  orderDetails: unknown;
}): AutomationLead {
  const form = leadFormSchema.safeParse(row.payload);
  const customValues = storedValuesSchema.safeParse(row.customValues);
  return {
    id: row.id,
    leadType: row.leadType,
    fullName: row.fullName,
    externalRef: row.externalRef,
    customValues: customValues.success ? customValues.data : {},
    email: row.email,
    submitted: row.status !== 'incomplete',
    form: form.success ? form.data.payload : {},
    order: isOrderLeadType(row.leadType) ? toLeadOrder(row.orderDetails) : null,
  };
}

/** The lead as stored now, read in the caller's transaction. */
export async function readAutomationLead(
  tx: TenantTransaction,
  workspaceId: string,
  leadId: string,
): Promise<AutomationLead> {
  const [row] = await tx
    .select({
      id: leads.id,
      leadType: leads.leadType,
      status: leads.status,
      fullName: leads.fullName,
      email: leads.email,
      externalRef: leads.externalRef,
      payload: leads.payload,
      customValues: leads.customValues,
      orderDetails: leads.orderDetails,
    })
    .from(leads)
    .where(and(eq(leads.workspaceId, workspaceId), eq(leads.id, leadId)))
    .limit(1);
  if (!row) throw new Error('lead vanished inside its own transaction');
  return automationLeadOf(row);
}

/** One structured warning naming the rule and its template; never the lead, its address or the error's text. */
function logComposeFailure(input: {
  requestId: string;
  workspaceId: string;
  rule: string;
  template: CustomerEmailTemplate;
}): void {
  console.warn(
    JSON.stringify({
      event: 'automation_compose_failed',
      requestId: sanitizeLogIdentifier(input.requestId) ?? 'unknown',
      workspaceId: sanitizeLogIdentifier(input.workspaceId) ?? 'unknown',
      automation: input.rule,
      template: input.template,
    }),
  );
}
