import { isSiteTemplateKey, type SiteTemplateKey } from '@gt-sales/contracts';
import { z } from 'zod';

/**
 * A site's own mails (Settings → Email): the backend renders them from the
 * site's template when it queues the mail and `EmailMessage.rendered` carries
 * the result, so no copy for them lives here.
 */
const siteContentEmailTemplates = [
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

/**
 * Email templates T18 requires (REQ 26-27, IMPLEMENTATION_PLAN.md §9 "Email"),
 * plus the site-content templates a site's staff edit. `abandoned_form_marketing` is the one marketing template; every
 * other template is transactional and is never gated on marketing opt-out.
 */
export const emailTemplates = [
  'order_acknowledgement',
  'order_status',
  'order_awaiting_customer',
  'order_dispatch',
  'order_activation',
  'abandoned_form_marketing',
  ...siteContentEmailTemplates,
] as const;
export type EmailTemplate = (typeof emailTemplates)[number];

export const transactionalEmailTemplates: readonly EmailTemplate[] = emailTemplates.filter(
  (template) => template !== 'abandoned_form_marketing',
);

export type EmailMessageClass = 'transactional' | 'marketing';

export function messageClassForTemplate(template: EmailTemplate): EmailMessageClass {
  return template === 'abandoned_form_marketing' ? 'marketing' : 'transactional';
}

/**
 * Everything the adapter needs to render and send one message. `toAddress`
 * necessarily carries the raw address (the provider needs it); the
 * `email_messages` audit/status table never stores it, keying instead on a
 * `contactHash` for suppression/consent matching, so admin views and delivery
 * history never surface a bare address (§4 invariant 12).
 */
export interface EmailMessage {
  workspaceId: string;
  /** Stable logical job id; used for provider-level dedup, never regenerated on retry. */
  messageId: string;
  /** A built-in template, or a site-made one (`tpl_…`), which always arrives rendered. */
  template: EmailTemplate | SiteTemplateKey;
  toAddress: string;
  /** Present for order-scoped templates. */
  orderId?: string;
  /** Present for lead-scoped templates (e.g. abandoned-form marketing). */
  leadId?: string;
  reference?: string;
  /** Required only for the marketing template; a one-click, no-login unsubscribe URL. */
  unsubscribeUrl?: string;
  /** Small, bounded template variables. Never raw documents or full personal payloads. */
  variables?: Readonly<Record<string, string>>;
  /**
   * The sender the message was queued with (a site's own, chosen when staff
   * queued it). Absent for the built-in mails, which use the workspace's or
   * the deployment's sender.
   */
  sender?: SenderIdentity;
  /**
   * The message as the backend rendered it. When present it is sent exactly as
   * given, with nothing appended; the adapter never renders it again.
   */
  rendered?: RenderedEmail;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export type ProviderDeliveryResult =
  { status: 'delivered'; providerId: string } | { status: 'uncertain'; errorCode: string };

export interface EmailAdapter {
  send(message: EmailMessage): Promise<ProviderDeliveryResult>;
}

/**
 * The verified sender identity for a workspace's website. SPF/DKIM/DMARC are
 * configured at the DNS/provider level (outside this adapter); this only
 * carries the From header the provider is expected to send as, so a
 * misconfigured deployment fails obviously (unset env) rather than silently
 * sending as the wrong identity.
 */
export interface SenderIdentity {
  fromAddress: string;
  fromName: string;
  replyToAddress?: string;
}

/**
 * The `From` header for a sender. The display name is free-form staff input,
 * so control characters are dropped and a name with RFC 5322 specials, or
 * anything outside printable ASCII, is quoted (escaping `\` and `"`), which
 * keeps the header one address however the name is typed. Plain names stay
 * unquoted.
 */
export function formatFrom(sender: SenderIdentity): string {
  const name = Array.from(sender.fromName)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join('')
    .trim();
  const needsQuotes = /[()<>[\]:;@\\,."]|[^\x20-\x7e]/.test(name);
  if (!name) return sender.fromAddress;
  const display = needsQuotes ? `"${name.replace(/[\\"]/g, '\\$&')}"` : name;
  return `${display} <${sender.fromAddress}>`;
}

/** Deterministic, deduplicating provider fake used by tests and non-production environments. */
export class FakeEmailAdapter implements EmailAdapter {
  readonly deliveries: EmailMessage[] = [];
  private readonly providerIds = new Map<string, string>();

  async send(message: EmailMessage): Promise<ProviderDeliveryResult> {
    const existing = this.providerIds.get(message.messageId);
    if (existing) return { status: 'delivered', providerId: existing };
    const providerId = `fake-email:${message.messageId}`;
    this.providerIds.set(message.messageId, providerId);
    this.deliveries.push(structuredClone(message));
    return { status: 'delivered', providerId };
  }
}

/**
 * The server-emitted conversion events (IMPLEMENTATION_PLAN §9). Both are
 * emitted once from the transactional outbox, never from the browser, so a
 * submission is counted exactly once (REQ 35).
 */
export const analyticsEventNames = ['lead_saved', 'order_submitted'] as const;
export type AnalyticsEventName = (typeof analyticsEventNames)[number];

/**
 * Amazon SES v2 implementation, structurally selected pending
 * OPEN_INPUTS #23 (production access, region, verified sender domain, quota).
 * All configuration comes from environment variables — never hardcoded — and
 * the adapter throws at construction if any are missing, so a deployment
 * cannot silently send unauthenticated mail. Never wired for anything but the
 * explicit `EMAIL_PROVIDER=ses` opt-in (see apps/backend/src/jobs/providers.ts);
 * `EMAIL_PROVIDER=fake` in CI/previews never reaches this class.
 */
export class SesEmailAdapter implements EmailAdapter {
  private client: import('@aws-sdk/client-sesv2').SESv2Client | undefined;

  constructor(
    private readonly config: {
      region: string;
      sender: SenderIdentity;
      configurationSetName?: string;
    },
  ) {
    if (!config.region) throw new Error('SES adapter requires a region.');
    if (!config.sender.fromAddress) throw new Error('SES adapter requires a from address.');
  }

  /** Lazily constructed so importing this module never requires AWS credentials at load time. */
  private async getClient(): Promise<import('@aws-sdk/client-sesv2').SESv2Client> {
    if (!this.client) {
      const { SESv2Client } = await import('@aws-sdk/client-sesv2');
      this.client = new SESv2Client({ region: this.config.region });
    }
    return this.client;
  }

  async send(message: EmailMessage): Promise<ProviderDeliveryResult> {
    const { SendEmailCommand } = await import('@aws-sdk/client-sesv2');
    const client = await this.getClient();
    const sender = message.sender ?? this.config.sender;
    const content = contentFor(message, sender.fromName);
    if (!content) return { status: 'uncertain', errorCode: 'rendered_message_missing' };
    const { subject, text, html } = content;
    try {
      const result = await client.send(
        new SendEmailCommand({
          FromEmailAddress: formatFrom(sender),
          ReplyToAddresses: sender.replyToAddress ? [sender.replyToAddress] : undefined,
          ConfigurationSetName: this.config.configurationSetName,
          Destination: { ToAddresses: [message.toAddress] },
          Content: {
            Simple: {
              Subject: { Data: subject },
              Body: { Text: { Data: text }, Html: html ? { Data: html } : undefined },
            },
          },
          // SES's own dedup is at-most-once per API call; the logical message
          // id still gates whether this call happens at all (outbox dedupe).
        }),
      );
      const providerId = result.MessageId;
      if (!providerId) return { status: 'uncertain', errorCode: 'ses_missing_message_id' };
      return { status: 'delivered', providerId };
    } catch (error) {
      // A thrown SDK error after the request left the process is ambiguous —
      // the message may already be queued by SES — so this is uncertain, not
      // failed, and the outbox/job layer decides whether to retry or reconcile.
      const errorCode = error instanceof Error ? error.name : 'ses_send_error';
      return { status: 'uncertain', errorCode };
    }
  }
}

/**
 * Resend implementation, the current production email provider (OPEN_INPUTS
 * #23: Resend selected for launch, AWS SES deferred — see
 * docs/OPEN_INPUTS.md). Talks to Resend's HTTP API directly (no SDK
 * dependency, matching the SES adapter's env-only, throw-at-construction
 * fail-closed shape). Only wired for the explicit `EMAIL_PROVIDER=resend`
 * opt-in (see apps/backend/src/jobs/providers.ts); `EMAIL_PROVIDER=fake` in
 * CI/previews never reaches this class.
 */
const resendResponseSchema = z.object({ id: z.string().optional() });

export class ResendEmailAdapter implements EmailAdapter {
  constructor(
    private readonly config: {
      apiKey: string;
      /** The deployment's own sender, for a message queued without its site's. */
      sender: SenderIdentity;
      apiUrl?: string;
      /** Upper bound per send; a timeout is an "uncertain" outcome, retried with the same idempotency key. */
      timeoutMs?: number;
    },
  ) {
    if (!config.apiKey) throw new Error('Resend adapter requires an API key.');
    if (!config.sender.fromAddress) throw new Error('Resend adapter requires a from address.');
  }

  async send(message: EmailMessage): Promise<ProviderDeliveryResult> {
    const sender = message.sender ?? this.config.sender;
    const content = contentFor(message, sender.fromName);
    if (!content) return { status: 'uncertain', errorCode: 'rendered_message_missing' };
    const { subject, text, html } = content;
    try {
      const response = await fetch(`${this.config.apiUrl ?? 'https://api.resend.com'}/emails`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000),
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': `${message.workspaceId}/${message.messageId}`,
        },
        body: JSON.stringify({
          from: formatFrom(sender),
          reply_to: sender.replyToAddress,
          to: [message.toAddress],
          subject,
          text,
          html,
          tags: [{ name: 'cp_message_id', value: message.messageId }],
        }),
      });
      if (!response.ok) {
        return { status: 'uncertain', errorCode: `resend_http_${response.status}` };
      }
      const parsed = resendResponseSchema.safeParse(await response.json());
      if (!parsed.success || !parsed.data.id) {
        return { status: 'uncertain', errorCode: 'resend_missing_message_id' };
      }
      return { status: 'delivered', providerId: parsed.data.id };
    } catch (error) {
      // A thrown network error after the request left the process is
      // ambiguous — the message may already be queued by Resend — so this is
      // uncertain, not failed, and the outbox/job layer decides whether to
      // retry or reconcile.
      const errorCode = error instanceof Error ? error.name : 'resend_send_error';
      return { status: 'uncertain', errorCode };
    }
  }
}

/**
 * The subject and body to send: a rendered message exactly as given, else the
 * built-in copy for the template (`undefined` for a site-content template that
 * arrived without its rendered message).
 */
function contentFor(
  message: EmailMessage,
  senderName: string,
): { subject: string; text: string; html?: string } | undefined {
  if (message.rendered) return message.rendered;
  const { template } = message;
  if (isSiteTemplateKey(template)) return undefined;
  if (siteContentEmailTemplates.some((entry) => entry === template)) return undefined;
  return renderTemplate({ ...message, template }, senderName);
}

/** A message of one of the built-in templates the adapter renders itself. */
type BuiltInMessage = EmailMessage & { template: EmailTemplate };

/**
 * Sender identification on every email (CASL s.6(2) requires it in each
 * commercial message; transactional mail carries it too): the name of the
 * site that sends it, as its From header shows.
 */
function renderTemplate(
  message: BuiltInMessage,
  senderName: string,
): { subject: string; text: string; html?: string } {
  const rendered = renderTemplateBody(message);
  return { ...rendered, text: `${rendered.text}\n\n${senderName}` };
}

function renderTemplateBody(message: BuiltInMessage): {
  subject: string;
  text: string;
  html?: string;
} {
  const ref = message.reference ?? message.variables?.reference ?? '';
  switch (message.template) {
    case 'order_acknowledgement':
      return {
        subject: `We received your order ${ref}`,
        text: `Thanks — we received your order ${ref}. Nothing has been charged. An advisor will contact you to confirm your plan. Didn't place this order? Reply to this email and we will cancel it.`,
      };
    case 'order_status':
      return {
        subject: `Update on your order ${ref}`,
        text: `Your order ${ref} status: ${message.variables?.status ?? ''}.`,
      };
    case 'order_awaiting_customer':
      return {
        subject: `Action needed on your order ${ref}`,
        text: `We need more information on order ${ref} to keep moving. Please respond when you can.`,
      };
    case 'order_dispatch': {
      // Nothing is physically shipped at this stage: "dispatch"
      // is the handoff to the provider, whose confirmation number is the
      // reference staff record, so it is shown only when present.
      const providerReference = message.variables?.trackingReference?.trim();
      return {
        subject: `Your order ${ref} has been handed to your provider`,
        text: `Order ${ref} has been passed to your service provider for activation. They will contact you directly with the next steps. Reply to this email if you have questions.${
          providerReference ? `\n\nReference from the provider: ${providerReference}.` : ''
        }`,
      };
    }
    case 'order_activation':
      return {
        subject: `Your service for order ${ref} is active`,
        text: `Good news — the service for order ${ref} is now active.`,
      };
    case 'tracking_code':
    case 'order_received':
    case 'information_needed':
    case 'dispatched':
    case 'activated':
    case 'cancelled':
    case 'sim_number_ready':
    case 'change_approved':
    case 'change_rejected':
      // Never reached: `contentFor` refuses these without a rendered message.
      throw new Error('rendered_message_missing');
    case 'abandoned_form_marketing':
      return {
        subject: `Still interested in a Canadian plan?`,
        text: `You started a plan application but didn't finish. Pick up where you left off.\n\nUnsubscribe: ${
          message.unsubscribeUrl ?? ''
        }`,
      };
  }
}

export interface AnalyticsEvent {
  workspaceId: string;
  /** Stable logical id (the outbox `message_id`); providers dedupe on it. */
  eventId: string;
  name: AnalyticsEventName;
  /** Internal opaque lead/order identifier only. No contact, URL, attribution, or free text. */
  subjectId: string;
}

/**
 * The analytics seam (PLATFORM_CONTEXT §6). Only an Umami and a fake/log sink
 * exist in Phase A; Google Ads/Meta are Phase B sinks over the same events.
 */
export interface AnalyticsSink {
  capture(event: AnalyticsEvent): Promise<ProviderDeliveryResult>;
}

/** In-memory analytics sink with stable event-id deduplication (tests, non-production). */
export class FakeAnalyticsSink implements AnalyticsSink {
  readonly events: AnalyticsEvent[] = [];
  private readonly providerIds = new Map<string, string>();

  async capture(event: AnalyticsEvent): Promise<ProviderDeliveryResult> {
    const existing = this.providerIds.get(event.eventId);
    if (existing) return { status: 'delivered', providerId: existing };
    const providerId = `fake-analytics:${event.eventId}`;
    this.providerIds.set(event.eventId, providerId);
    this.events.push(structuredClone(event));
    return { status: 'delivered', providerId };
  }
}

/**
 * Durable suppression-change ledger publisher (IMPLEMENTATION_PLAN.md §13
 * "External deletion/suppression ledger"). The real ledger (a dedicated B2
 * bucket with append-only credentials, built in T4R) does not exist yet, so
 * this is the interface the email module publishes through today and a fake
 * for tests; wiring the real publisher is tracked as a blocker below.
 */
export interface SuppressionLedgerEvent {
  workspaceId: string;
  operationId: string;
  operation: 'suppress';
  contactHash: string;
  reason: 'hard_bounce' | 'complaint' | 'manual';
  occurredAt: string;
}

export interface SuppressionLedgerPublisher {
  publish(event: SuppressionLedgerEvent): Promise<void>;
}

/** In-memory publisher fake used by tests until the real ledger (T4R) exists. */
export class FakeSuppressionLedgerPublisher implements SuppressionLedgerPublisher {
  readonly published: SuppressionLedgerEvent[] = [];
  private readonly seen = new Set<string>();

  async publish(event: SuppressionLedgerEvent): Promise<void> {
    if (this.seen.has(event.operationId)) return;
    this.seen.add(event.operationId);
    this.published.push(structuredClone(event));
  }
}
