import type { TenantTransaction } from '@gt-sales/db';
import {
  customerEmailJobPayloadSchema,
  type CustomerEmailJobPayload,
  type CustomerEmailTemplate,
  type EmailFillInKey,
} from '@gt-sales/contracts';
import { z } from 'zod';

import { fillInValuesForLead, sampleFillInValues, type FillInLead } from './fill-in-values.js';
import { renderCustomerEmail } from './layout.js';
import { resolveSiteSender, type CustomerEmailEnvironment } from './senders.js';
import { readEmailTemplate } from './settings-store.js';

/**
 * Makes one customer mail ready for the outbox: the site's sender, its
 * current copy of the template (the saved version, else the starter at
 * version 0) and the recipient's fill-in values, rendered in the site's look.
 * Whether to send is the caller's decision (an automation rule that is on, a
 * staff click); the composer only says whether the mail can be made, and if
 * not, why. Runs in the caller's tenant transaction and writes nothing.
 *
 * A mail that does not parse, or does not fit the job (a long name can push a
 * subject past its limit), throws: the worker would refuse it for good, so it
 * is never queued. The error names the template only, never a value.
 */

export type ComposeRecipient =
  /** A lead's customer, with the lead's values in the mail. */
  | { kind: 'lead'; lead: FillInLead & { id: string; email: string | null } }
  /** A staff member trying the template, with sample values. */
  | { kind: 'staff_test'; toAddress: string };

export type ComposeOutcome =
  | { kind: 'ready'; payload: CustomerEmailJobPayload }
  | {
      kind: 'skipped';
      reason: 'no_sender' | 'no_customer_email' | 'missing_fill_in';
      /** For `missing_fill_in`: the fill-ins the recipient has no value for. */
      missing?: EmailFillInKey[];
    };

const emailAddress = z.email();

/** The address, trimmed, when it is one, else `undefined`. */
function validAddress(value: string | null): string | undefined {
  const parsed = emailAddress.safeParse(value?.trim());
  return parsed.success ? parsed.data : undefined;
}

export async function composeCustomerEmail(
  tx: TenantTransaction,
  environment: CustomerEmailEnvironment,
  input: { workspaceId: string; template: CustomerEmailTemplate; recipient: ComposeRecipient },
): Promise<ComposeOutcome> {
  if (!environment.providerReady) return { kind: 'skipped', reason: 'no_sender' };
  const site = await resolveSiteSender(tx, environment, input.workspaceId);
  if (!site) return { kind: 'skipped', reason: 'no_sender' };

  const { recipient } = input;
  const toAddress = validAddress(
    recipient.kind === 'lead' ? recipient.lead.email : recipient.toAddress,
  );
  if (!toAddress) return { kind: 'skipped', reason: 'no_customer_email' };

  const stored = await readEmailTemplate(tx, input.workspaceId, input.template);
  const siteValues = { siteName: site.sender.fromName, siteUrl: site.siteUrl };
  const rendered = renderCustomerEmail({
    template: input.template,
    subject: stored.subject,
    body: stored.body,
    branding: site.branding,
    values:
      recipient.kind === 'lead'
        ? fillInValuesForLead(recipient.lead, siteValues)
        : sampleFillInValues(siteValues),
  });
  if (!rendered.ok) {
    if ('missing' in rendered) {
      return { kind: 'skipped', reason: 'missing_fill_in', missing: rendered.missing };
    }
    // Every saved version was parsed before it was written, and the starters
    // are tested: a markup error here is a bug, not a customer's data.
    throw new Error(`stored ${input.template} template v${stored.version} does not parse`);
  }

  const payload = customerEmailJobPayloadSchema.safeParse({
    ...(recipient.kind === 'lead' ? { leadId: recipient.lead.id } : {}),
    template: input.template,
    templateVersion: stored.version,
    toAddress,
    contactHash: environment.contactHash(toAddress),
    sender: site.sender,
    rendered: { subject: rendered.subject, html: rendered.html, text: rendered.text },
    ...(recipient.kind === 'staff_test' ? { test: true as const } : {}),
  });
  if (!payload.success) {
    throw new Error(`composed ${input.template} mail does not fit its job payload`);
  }
  return { kind: 'ready', payload: payload.data };
}
