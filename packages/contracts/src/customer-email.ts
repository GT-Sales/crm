import { z } from 'zod';

import { AUTOMATION_MAX_FLOWS, automationKeySchema, randomKeySuffix } from './automation-keys';
import { isoDateTimeSchema, requestIdSchema } from './common';

/**
 * The vocabulary of the mails a site sends its customers (spec §15): the
 * templates, the fill-ins their subject and body may use, the values of a
 * site's email settings and the outbox job that carries one rendered mail.
 * A template is content only (subject, body, version); whether it is sent is
 * up to the staff action or the automation rule that names it.
 *
 * This module imports nothing but zod, `./common` and `./automation-keys`, so
 * every family file can use it.
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
  'change_approved',
  'change_rejected',
] as const;
export const customerEmailTemplateSchema = z.enum(CUSTOMER_EMAIL_TEMPLATES);
export type CustomerEmailTemplate = z.infer<typeof customerEmailTemplateSchema>;

/** A site-made template's key (Settings → Email "New template"): `tpl_` and 16 of `[a-z0-9]`. */
export const SITE_TEMPLATE_KEY_PATTERN = /^tpl_[a-z0-9]{16}$/;
export const siteTemplateKeySchema = z.string().regex(SITE_TEMPLATE_KEY_PATTERN);
/** Any template's key: one of the nine built-ins or a site-made one. */
export const emailTemplateKeySchema = z.union([customerEmailTemplateSchema, siteTemplateKeySchema]);
export type EmailTemplateKey = z.infer<typeof emailTemplateKeySchema>;

/** A site-made template's key as a type. */
export type SiteTemplateKey = `tpl_${string}`;

export function isSiteTemplateKey(key: string): key is SiteTemplateKey {
  return SITE_TEMPLATE_KEY_PATTERN.test(key);
}

/** `tpl_` + 16 of [a-z0-9] from `crypto.getRandomValues`. */
export function generateTemplateKey(): string {
  return `tpl_${randomKeySuffix(16)}`;
}

/** Site-made templates per site that are not archived (P13). */
export const EMAIL_TEMPLATE_MAX_SITE_MADE = 50;

export const CUSTOMER_EMAIL_TEMPLATE_LABELS: Readonly<Record<CustomerEmailTemplate, string>> = {
  tracking_code: 'Tracking code',
  order_received: 'Order received',
  information_needed: 'Information needed',
  dispatched: 'Dispatched',
  activated: 'Activated',
  cancelled: 'Cancelled',
  sim_number_ready: 'SIM number ready',
  change_approved: 'Change approved',
  change_rejected: 'Change rejected',
};

/**
 * The mails sent whenever their moment comes, never through an automation
 * rule: the tracking code answers the customer's own request, and the two
 * change decisions answer the change request they sent from `/track`.
 */
export const ALWAYS_SENT_TEMPLATES: readonly CustomerEmailTemplate[] = [
  'tracking_code',
  'change_approved',
  'change_rejected',
];

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
  'order number',
  'code',
] as const;
export type EmailFillInKey = (typeof EMAIL_FILL_IN_KEYS)[number];

/** Whether `name` is one of `EMAIL_FILL_IN_KEYS` (not a `prop:` fill-in). */
export function isEmailFillInKey(name: string): name is EmailFillInKey {
  return EMAIL_FILL_IN_KEYS.some((key) => key === name);
}

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
/**
 * The order mails that may name the plan, its price and the last name. The
 * two change decisions may not: a decision mail always goes out, so it uses
 * only what every order has (ruling T9).
 */
const ORDER_DETAIL_TEMPLATES: readonly CustomerEmailTemplate[] = ORDER_TEMPLATES.filter(
  (template) => template !== 'change_approved' && template !== 'change_rejected',
);

export const emailFillIns: readonly EmailFillIn[] = [
  { key: 'first name', hint: 'The customer’s first name', templates: ORDER_TEMPLATES },
  { key: 'last name', hint: 'The customer’s last name', templates: ORDER_DETAIL_TEMPLATES },
  { key: 'site name', hint: 'The site’s name, as its emails sign', templates: ALL_TEMPLATES },
  { key: 'plan', hint: 'The name of the plan ordered', templates: ORDER_DETAIL_TEMPLATES },
  { key: 'price', hint: 'The plan’s price, such as $40.00', templates: ORDER_DETAIL_TEMPLATES },
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
  { key: 'order number', hint: 'The order number, such as MS-1042', templates: ORDER_TEMPLATES },
  { key: 'code', hint: 'The customer’s one-time tracking code', templates: ['tracking_code'] },
];

/**
 * The fill-ins `template` may use, in `EMAIL_FILL_IN_KEYS` order. A site-made
 * template may use every one but the code (it is never the tracking code mail).
 */
export function fillInsForTemplate(template: EmailTemplateKey): readonly EmailFillInKey[] {
  const builtIn = customerEmailTemplateSchema.safeParse(template);
  if (!builtIn.success) return EMAIL_FILL_IN_KEYS.filter((key) => key !== 'code');
  return emailFillIns
    .filter((fillIn) => fillIn.templates.includes(builtIn.data))
    .map((fillIn) => fillIn.key);
}

/** How a site-made template writes a property's value: `{prop:custom_size}`. */
export const PROPERTY_FILL_IN_PREFIX = 'prop:';
/** `prop:` and a property key (`propertyKeySchema`'s pattern, repeated here to keep this module's imports small). */
const PROPERTY_FILL_IN_PATTERN = /^prop:[a-z][A-Za-z0-9_]{0,63}$/;

/** A fill-in by name: one of `EMAIL_FILL_IN_KEYS`, or `prop:<key>` for a property. */
export type EmailFillInName = EmailFillInKey | `prop:${string}`;
export const emailFillInNameSchema = z.union([
  z.enum(EMAIL_FILL_IN_KEYS),
  z.string().regex(PROPERTY_FILL_IN_PATTERN),
]);

/** A template as staff read it: a built-in's label, else the site-made template's name, else "Site email". */
export function emailTemplateLabel(key: string, name?: string | null): string {
  const builtIn = customerEmailTemplateSchema.safeParse(key);
  if (builtIn.success) return CUSTOMER_EMAIL_TEMPLATE_LABELS[builtIn.data];
  return name ?? 'Site email';
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
    template: emailTemplateKeySchema,
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
 * The outbox job that sends one tracking code mail. Unlike a
 * `lead_customer_email` it is rendered when it is sent, after checking that
 * its challenge is still open, so no readable code ever sits in the outbox
 * (spec ruling 5).
 */
export const TRACKING_CODE_JOB_TYPE = 'tracking_code_email';

/**
 * The payload of a `tracking_code_email` job (payload version 1): the code
 * only sealed to its challenge (`sealTrackingCode`), never in the clear.
 */
export const trackingCodeJobPayloadSchema = z
  .object({
    challengeId: z.uuid(),
    toAddress: z.email(),
    contactHash: z.string().min(1),
    sealedCode: z.string().min(1).max(100),
    expiresAt: isoDateTimeSchema,
  })
  .strict();
export type TrackingCodeJobPayload = z.infer<typeof trackingCodeJobPayloadSchema>;

/** What a `tracking_code_email` job keeps once it ends: the challenge id only. */
export const trackingCodeScrubbedPayloadSchema = z.object({ challengeId: z.uuid() }).strict();
export type TrackingCodeScrubbedPayload = z.infer<typeof trackingCodeScrubbedPayloadSchema>;

/**
 * The outbox job that mails a staff member a flow's notification (`notify_staff`):
 * a link to the lead and the flow's name, nothing about the customer (O3).
 */
export const STAFF_NOTIFICATION_JOB_TYPE = 'staff_notification_email';

/**
 * The payload of a `staff_notification_email` job. It carries no address
 * (P8): the handler reads the member's notification address when it sends,
 * and skips when the member or the address is gone.
 */
export const staffNotificationJobPayloadSchema = z
  .object({
    actorId: z.uuid(),
    flowKey: automationKeySchema,
    flowName: z.string().min(1).max(80),
    siteName: z.string().min(1).max(100),
    leadId: z.uuid(),
    leadPath: z.string().regex(/^\/w\/[a-z0-9-]{1,64}\/leads\/[0-9a-f-]{36}$/),
    note: z.string().max(300),
  })
  .strict();
export type StaffNotificationJobPayload = z.infer<typeof staffNotificationJobPayloadSchema>;

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
 * them; until then the site sends no email to its customers.
 */
export const emailSettingsResponseSchema = z.object({
  settings: emailSettingsSchema.nullable(),
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

/**
 * One template as Settings → Email lists it once sites make their own: a
 * built-in (its label as `name`) or a site-made `tpl_` one, whether it is
 * archived, and the flows whose active version sends it.
 */
export const siteEmailTemplateSchema = emailTemplateSchema.extend({
  key: emailTemplateKeySchema,
  name: z.string().min(1).max(80),
  archived: z.boolean(),
  usedBy: z
    .array(z.object({ key: automationKeySchema, name: z.string() }))
    .max(AUTOMATION_MAX_FLOWS),
});
export type SiteEmailTemplate = z.infer<typeof siteEmailTemplateSchema>;

/** The nine built-ins and the site's own, archived ones included. */
export const listSiteEmailTemplatesResponseSchema = z.object({
  templates: z.array(siteEmailTemplateSchema).max(9 + 2 * EMAIL_TEMPLATE_MAX_SITE_MADE),
  requestId: requestIdSchema,
});
export type ListSiteEmailTemplatesResponse = z.infer<typeof listSiteEmailTemplatesResponseSchema>;

/** `POST …/email/templates`: a site-made template; its markup and fill-ins are checked as on a save. */
export const createEmailTemplateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    subject: emailSubjectSchema,
    body: emailBodySchema,
  })
  .strict();
export type CreateEmailTemplateRequest = z.infer<typeof createEmailTemplateRequestSchema>;

export const siteEmailTemplateResponseSchema = z.object({
  template: siteEmailTemplateSchema,
  requestId: requestIdSchema,
});
export type SiteEmailTemplateResponse = z.infer<typeof siteEmailTemplateResponseSchema>;

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
