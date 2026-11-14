import { z } from 'zod';

import { isoDateTimeSchema, pageInfoSchema, requestIdSchema } from './common';
import { automationKeySchema } from './automation-keys';
import { emailTemplateKeySchema } from './customer-email';
import { leadTypeSchema } from './leads';
import { LEAD_MAIL_TEXT_MAX, leadMailStatusSchema } from './lead-work';

/**
 * Mail → the site's sent mail, as conversations: the customers of active,
 * unrestricted leads the CRM has written to (their latest mail each), and one
 * customer's mails, their replies among them. Each row is a lead's `customer_emailed` timeline entry
 * (see `leadActivitySchema`) with the lead it belongs to. Read-only; a mail
 * is written through the lead's `customer-emails` route.
 */
export const MAILBOX_PAGE_SIZE = 50;

export const mailboxQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().max(1000).optional(),
    /**
     * With a lead: every mail to that lead's customer, newest first. Without:
     * one row per customer, their latest mail, most recently written to first.
     */
    leadId: z.uuid().optional(),
  })
  .strict();
export type MailboxQuery = z.infer<typeof mailboxQuerySchema>;

export const mailboxItemSchema = z.object({
  /** The timeline entry's id. */
  id: z.uuid(),
  /** `out`: a mail the CRM sent the customer; `in`: the customer's reply. */
  direction: z.enum(['out', 'in']),
  createdAt: isoDateTimeSchema,
  /** Who queued it; the member who activated the flow when `automation` is set. */
  actorId: z.uuid(),
  viaAi: z.literal(true).optional(),
  automation: automationKeySchema.optional(),
  automationName: z.string().min(1).max(80).optional(),
  template: emailTemplateKeySchema.optional(),
  templateName: z.string().min(1).max(80).optional(),
  /** Absent on mails queued before the CRM kept what it sent. */
  subject: z.string().min(1).max(LEAD_MAIL_TEXT_MAX).optional(),
  text: z.string().max(LEAD_MAIL_TEXT_MAX).optional(),
  textCut: z.literal(true).optional(),
  mailStatus: leadMailStatusSchema.optional(),
  /** In the per-customer list: how many mails this customer has been sent. */
  mails: z.int().positive().optional(),
  lead: z.object({
    id: z.uuid(),
    leadType: leadTypeSchema,
    /** The customer's name, else their email: what staff recognise the lead by. */
    name: z.string().max(320).nullable(),
  }),
});
export type MailboxItem = z.infer<typeof mailboxItemSchema>;

export const mailboxResponseSchema = z.object({
  items: z.array(mailboxItemSchema).max(MAILBOX_PAGE_SIZE),
  page: pageInfoSchema,
  /** Whether replies to this site's mail come back to the CRM (else they go to its reply-to mailbox). */
  repliesEnabled: z.boolean(),
  requestId: requestIdSchema,
});
export type MailboxResponse = z.infer<typeof mailboxResponseSchema>;
