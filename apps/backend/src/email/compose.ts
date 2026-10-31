import type { TenantTransaction } from '@gt-sales/db';
import {
  customerEmailJobPayloadSchema,
  emailTemplateLabel,
  isSiteTemplateKey,
  type CustomerEmailJobPayload,
  type EmailFillInName,
  type EmailTemplateKey,
  type PropertyCatalog,
} from '@gt-sales/contracts';
import { z } from 'zod';

import { fillInValuesForLead, sampleFillInValues, type FillInLead } from './fill-in-values.js';
import { renderCustomerEmail, type FillInValues } from './layout.js';
import { templatePropertyKeys } from './markup.js';
import { loadPropertyCatalog } from '../properties/catalog.js';
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
 * A site-made (`tpl_`) template may also show the lead's properties
 * (`{prop:<key>}`), each only while a customer may see it, else the mail is
 * skipped as missing it; one that is gone or archived is `template_unavailable`.
 *
 * A mail that does not parse, or does not fit the job (a long name can push a
 * subject past its limit), throws: the worker would refuse it for good, so it
 * is never queued. The error names the template only, never a value.
 */

export type ComposeRecipient =
  /** A lead's customer, with the lead's values in the mail. */
  | { kind: 'lead'; lead: FillInLead & { id: string; email: string | null } }
  /** A staff member trying the template, with sample values. */
  | { kind: 'staff_test'; toAddress: string }
  /** A customer's tracking code: the code and the site's name only, no lead and no test. */
  | { kind: 'tracking_code'; toAddress: string; code: string };

export type ComposeOutcome =
  | {
      kind: 'ready';
      payload: CustomerEmailJobPayload;
      /** The template as staff read it: a built-in's label, a site-made one's name. */
      templateName: string;
    }
  | {
      kind: 'skipped';
      reason: 'no_sender' | 'no_customer_email' | 'missing_fill_in' | 'template_unavailable';
      /** For `missing_fill_in`: the fill-ins the recipient has no value for. */
      missing?: EmailFillInName[];
    };

const emailAddress = z.email();

/** The address, trimmed, when it is one, else `undefined`. */
function validAddress(value: string | null): string | undefined {
  const parsed = emailAddress.safeParse(value?.trim());
  return parsed.success ? parsed.data : undefined;
}

function fillInValues(
  recipient: ComposeRecipient,
  site: { siteName: string; siteUrl: string | null },
  properties: { catalog: PropertyCatalog; propertyKeys: readonly string[] } | undefined,
): FillInValues {
  switch (recipient.kind) {
    case 'lead':
      return fillInValuesForLead(recipient.lead, site, properties);
    case 'staff_test':
      return sampleFillInValues(site);
    case 'tracking_code':
      return { 'site name': site.siteName, code: recipient.code };
  }
}

export async function composeCustomerEmail(
  tx: TenantTransaction,
  environment: CustomerEmailEnvironment,
  input: {
    workspaceId: string;
    template: EmailTemplateKey;
    recipient: ComposeRecipient;
    /** The site's catalogue, when the caller has it; loaded only for a template that needs it. */
    catalog?: PropertyCatalog;
  },
): Promise<ComposeOutcome> {
  if (!environment.providerReady) return { kind: 'skipped', reason: 'no_sender' };
  const site = await resolveSiteSender(tx, input.workspaceId);
  if (!site) return { kind: 'skipped', reason: 'no_sender' };

  const { recipient } = input;
  const toAddress = validAddress(
    recipient.kind === 'lead' ? recipient.lead.email : recipient.toAddress,
  );
  if (!toAddress) return { kind: 'skipped', reason: 'no_customer_email' };

  const stored = await readEmailTemplate(tx, input.workspaceId, input.template);
  if (!stored) return { kind: 'skipped', reason: 'template_unavailable' };
  const siteValues = { siteName: site.sender.fromName, siteUrl: site.siteUrl };
  const propertyKeys = isSiteTemplateKey(input.template)
    ? templatePropertyKeys(stored.subject, stored.body)
    : [];
  const properties =
    propertyKeys.length > 0
      ? { catalog: input.catalog ?? (await loadPropertyCatalog(tx)), propertyKeys }
      : undefined;
  const rendered = renderCustomerEmail({
    template: input.template,
    subject: stored.subject,
    body: stored.body,
    branding: site.branding,
    values: fillInValues(recipient, siteValues, properties),
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
  return {
    kind: 'ready',
    payload: payload.data,
    templateName: emailTemplateLabel(input.template, stored.name),
  };
}
