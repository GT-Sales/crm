import { z } from 'zod';

import { isoDateTimeSchema, requestIdSchema } from './common';

/**
 * The vocabulary of the mails a site sends its customers (spec §15): the
 * templates, the fill-ins their subject and body may use, the values of a
 * site's email settings and the outbox job that carries one rendered mail.
 * A template is content only (subject, body, version); whether it is sent is
 * up to the staff action or the automation rule that names it.
 *
 * This module imports nothing but zod and `./common`, so every family file can
 * use it.
 */

/** The mails a site can send, in Settings → Email order. */
export const CUSTOMER_EMAIL_TEMPLATES = [
  'tracking_code',
  'order_received',
  'information_needed',
  'dispatched',
  'activated',
  'cancelled',
  'sim_number_ready',
] as const;
export const customerEmailTemplateSchema = z.enum(CUSTOMER_EMAIL_TEMPLATES);
export type CustomerEmailTemplate = z.infer<typeof customerEmailTemplateSchema>;

export const CUSTOMER_EMAIL_TEMPLATE_LABELS: Readonly<Record<CustomerEmailTemplate, string>> = {
  tracking_code: 'Tracking code',
  order_received: 'Order received',
  information_needed: 'Information needed',
  dispatched: 'Dispatched',
  activated: 'Activated',
  cancelled: 'Cancelled',
  sim_number_ready: 'SIM number ready',
};

/** What a template may write in braces (`{first name}`), as the owner types it. */
export const EMAIL_FILL_IN_KEYS = [
  'first name',
  'last name',
  'site name',
  'plan',
  'price',
  'SIM number',
  'courier',
  'tracking number',
  'tracking link',
  'code',
] as const;
export type EmailFillInKey = (typeof EMAIL_FILL_IN_KEYS)[number];

/** One fill-in: what it is replaced with, for the editor's hint, and the templates that may use it. */
export interface EmailFillIn {
  readonly key: EmailFillInKey;
  readonly hint: string;
  readonly templates: readonly CustomerEmailTemplate[];
}

const ALL_TEMPLATES: readonly CustomerEmailTemplate[] = CUSTOMER_EMAIL_TEMPLATES;
/** Every mail about an order; the tracking code mail is about the customer's access, not an order. */
const ORDER_TEMPLATES: readonly CustomerEmailTemplate[] = ALL_TEMPLATES.filter(
  (template) => template !== 'tracking_code',
);

export const emailFillIns: readonly EmailFillIn[] = [
  { key: 'first name', hint: 'The customer’s first name', templates: ORDER_TEMPLATES },
  { key: 'last name', hint: 'The customer’s last name', templates: ORDER_TEMPLATES },
  { key: 'site name', hint: 'The site’s name, as its emails sign', templates: ALL_TEMPLATES },
  { key: 'plan', hint: 'The name of the plan ordered', templates: ORDER_TEMPLATES },
  { key: 'price', hint: 'The plan’s price, such as $40.00', templates: ORDER_TEMPLATES },
  {
    key: 'SIM number',
    hint: 'The order’s Canadian phone number',
    templates: ['dispatched', 'activated', 'sim_number_ready'],
  },
  { key: 'courier', hint: 'Who carries the order, such as Canada Post', templates: ['dispatched'] },
  { key: 'tracking number', hint: 'The courier’s tracking number', templates: ['dispatched'] },
  {
    key: 'tracking link',
    hint: 'The link to the site’s order tracking page',
    templates: ORDER_TEMPLATES,
  },
  { key: 'code', hint: 'The customer’s one-time tracking code', templates: ['tracking_code'] },
];

/** The fill-ins `template` may use, in `EMAIL_FILL_IN_KEYS` order. */
export function fillInsForTemplate(template: CustomerEmailTemplate): readonly EmailFillInKey[] {
  return emailFillIns
    .filter((fillIn) => fillIn.templates.includes(template))
    .map((fillIn) => fillIn.key);
}

const canonical = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();
const fillInsByCanonicalName: ReadonlyMap<string, EmailFillInKey> = new Map(
  EMAIL_FILL_IN_KEYS.map((key) => [canonical(key), key]),
);

/**
 * The fill-in a name typed in braces means, forgiving case and spacing
 * (`{ First  Name }` is `first name`), or `undefined` for one that is not a
 * fill-in (`{tracking nmber}`).
 */
export function normalizeFillInName(raw: string): EmailFillInKey | undefined {
  return fillInsByCanonicalName.get(canonical(raw));
}

/** The brand colour a site's emails use until the owner picks one. */
export const DEFAULT_EMAIL_BRAND_COLOR = '#d72638';

export const emailSubjectSchema = z.string().trim().min(1).max(150);
export const emailBodySchema = z.string().trim().min(1).max(5000);

/**
 * A `#rrggbb` colour, stored in lower case. Lower-cased with `overwrite`, not
 * `transform`, so the schema still has a JSON Schema form for the OpenAPI
 * document.
 */
export const brandColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'a colour, #rrggbb')
  .overwrite((value) => value.toLowerCase());

/** A link an email may carry (the site's logo, its address): https only. */
export const httpsUrlSchema = z.url({ protocol: /^https$/ }).max(2048);

/** The outbox job that sends one rendered customer mail. */
export const CUSTOMER_EMAIL_JOB_TYPE = 'lead_customer_email';

/**
 * The payload of a `lead_customer_email` job: the mail rendered when it was
 * queued, its sender and its address, so the job only sends. `leadId` is
 * absent for a test send (`test: true`), which goes to the staff member who
 * asked for it.
 */
export const customerEmailJobPayloadSchema = z
  .object({
    leadId: z.uuid().optional(),
    template: customerEmailTemplateSchema,
    templateVersion: z.int().min(0),
    toAddress: z.email(),
    contactHash: z.string().min(1),
    sender: z
      .object({
        fromName: z.string().min(1).max(100),
        fromAddress: z.email(),
        replyToAddress: z.email().optional(),
      })
      .strict(),
    rendered: z
      .object({
        subject: z.string().min(1).max(300),
        html: z.string().min(1).max(200_000),
        text: z.string().min(1).max(50_000),
      })
      .strict(),
    test: z.literal(true).optional(),
  })
  .strict();
export type CustomerEmailJobPayload = z.infer<typeof customerEmailJobPayloadSchema>;

/**
 * A site's email settings (`app.email_settings`, Settings → Email): who its
 * mails come from and how they look. `replyTo`, `logoUrl` and `siteUrl` are
 * null when left empty.
 */
export const emailSettingsSchema = z.object({
  fromName: z.string().trim().min(1).max(80),
  fromAddress: z.email().max(254),
  replyTo: z.email().max(254).nullable(),
  logoUrl: httpsUrlSchema.nullable(),
  brandColor: brandColorSchema,
  footerText: z.string().trim().max(500),
  siteUrl: httpsUrlSchema.nullable(),
  updatedAt: isoDateTimeSchema,
  updatedBy: z.uuid(),
});
export type EmailSettings = z.infer<typeof emailSettingsSchema>;

/** `PUT …/email/settings`: the whole form; colour and footer fall back to the defaults. */
export const updateEmailSettingsRequestSchema = emailSettingsSchema
  .omit({ updatedAt: true, updatedBy: true })
  .extend({
    brandColor: brandColorSchema.default(DEFAULT_EMAIL_BRAND_COLOR),
    footerText: z.string().trim().max(500).default(''),
  })
  .strict();
export type UpdateEmailSettingsRequest = z.infer<typeof updateEmailSettingsRequestSchema>;
export type UpdateEmailSettingsRequestInput = z.input<typeof updateEmailSettingsRequestSchema>;

/**
 * `GET`/`PUT …/email/settings`. `settings` is null until the owner saves
 * them; `fallback` is then the sender configured for the deployment
 * (`EMAIL_SENDERS_JSON`), which mails use meanwhile, or null when there is none.
 */
export const emailSettingsResponseSchema = z.object({
  settings: emailSettingsSchema.nullable(),
  fallback: z
    .object({
      fromName: z.string(),
      fromAddress: z.email(),
      siteUrl: z.url().nullable(),
    })
    .nullable(),
  requestId: requestIdSchema,
});
export type EmailSettingsResponse = z.infer<typeof emailSettingsResponseSchema>;

/** One template as the site has it; `version` 0 is the starter text, never saved. */
export const emailTemplateSchema = z.object({
  key: customerEmailTemplateSchema,
  subject: emailSubjectSchema,
  body: emailBodySchema,
  version: z.int().min(0),
  updatedAt: isoDateTimeSchema.nullable(),
  updatedBy: z.uuid().nullable(),
});
export type EmailTemplate = z.infer<typeof emailTemplateSchema>;

export const listEmailTemplatesResponseSchema = z.object({
  templates: z.array(emailTemplateSchema).length(CUSTOMER_EMAIL_TEMPLATES.length),
  requestId: requestIdSchema,
});
export type ListEmailTemplatesResponse = z.infer<typeof listEmailTemplatesResponseSchema>;

/** `PUT …/email/templates/:key`; `expectedVersion` is the version the editor loaded. */
export const updateEmailTemplateRequestSchema = z
  .object({
    expectedVersion: z.int().min(0),
    subject: emailSubjectSchema,
    body: emailBodySchema,
  })
  .strict();
export type UpdateEmailTemplateRequest = z.infer<typeof updateEmailTemplateRequestSchema>;

export const emailTemplateResponseSchema = z.object({
  template: emailTemplateSchema,
  requestId: requestIdSchema,
});
export type EmailTemplateResponse = z.infer<typeof emailTemplateResponseSchema>;

/** `POST …/email/templates/:key/preview`: the unsaved subject and body, rendered with sample values. */
export const previewEmailTemplateRequestSchema = z
  .object({ subject: emailSubjectSchema, body: emailBodySchema })
  .strict();
export type PreviewEmailTemplateRequest = z.infer<typeof previewEmailTemplateRequestSchema>;

export const previewEmailTemplateResponseSchema = z.object({
  subject: z.string(),
  html: z.string(),
  text: z.string(),
  requestId: requestIdSchema,
});
export type PreviewEmailTemplateResponse = z.infer<typeof previewEmailTemplateResponseSchema>;

/** `POST …/email/templates/:key/test`: `queued` is false when the mail was not queued. */
export const sendTestEmailResponseSchema = z.object({
  queued: z.boolean(),
  requestId: requestIdSchema,
});
export type SendTestEmailResponse = z.infer<typeof sendTestEmailResponseSchema>;
