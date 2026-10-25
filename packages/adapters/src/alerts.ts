import { createHmac } from 'node:crypto';

import { scrubValue } from '@gt-sales/observability';
import { z } from 'zod';

/**
 * Owner alert channel (REQ 40, IMPLEMENTATION_PLAN §10: "Alerts route to the
 * owner by email (and optionally a chat channel) for: failed-job queue
 * growth, backup age, synthetic check failure, and error-rate spikes"). This
 * is deliberately separate from the customer `EmailAdapter`
 * (`packages/adapters/src/messaging.ts`): the owner is not a suppressible
 * contact, alerts must never be gated by consent/unsubscribe state, and the
 * message is a fixed operational template, not a customer-facing one.
 */

export const ownerAlertKinds = [
  'synthetic_check_failed',
  'backup_stale',
  'job_queue_stuck',
  'error_rate_spike',
  'catalogue_sync_failed',
  'scheduler_not_started',
] as const;
export type OwnerAlertKind = (typeof ownerAlertKinds)[number];

export interface OwnerAlert {
  kind: OwnerAlertKind;
  /** Short, bounded operational detail — a code or count, never free text/PII. */
  detail: string;
  occurredAt: string;
}

export interface OwnerAlertChannel {
  send(alert: OwnerAlert): Promise<void>;
}

/** In-memory channel for tests. */
export class FakeOwnerAlertChannel implements OwnerAlertChannel {
  readonly sent: OwnerAlert[] = [];

  async send(alert: OwnerAlert): Promise<void> {
    this.sent.push(structuredClone(alert));
  }
}

/** Used when no channel is configured; logs so the omission is visible without crashing a caller. */
export class NoopOwnerAlertChannel implements OwnerAlertChannel {
  async send(alert: OwnerAlert): Promise<void> {
    console.error(
      JSON.stringify({
        event: 'owner_alert_channel_unconfigured',
        kind: alert.kind,
      }),
    );
  }
}

function alertSubject(kind: OwnerAlertKind): string {
  switch (kind) {
    case 'synthetic_check_failed':
      return 'GT Sales CRM: synthetic order check failed';
    case 'backup_stale':
      return 'GT Sales CRM: backup snapshot is stale';
    case 'job_queue_stuck':
      return 'GT Sales CRM: failed job queue is not draining';
    case 'error_rate_spike':
      return 'GT Sales CRM: error rate spike detected';
    case 'catalogue_sync_failed':
      return 'GT Sales CRM: catalogue sync is failing';
    case 'scheduler_not_started':
      return 'GT Sales CRM: background scheduler did not start';
  }
}

const resendResponseSchema = z.object({ id: z.string().optional() });

export interface EmailOwnerAlertChannelConfig {
  apiKey: string;
  ownerEmail: string;
  fromAddress: string;
  fromName: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Sends the owner a plain operational email over Resend's HTTP API directly
 * (no SDK dependency — matches `ResendEmailAdapter`). A delivery failure
 * throws so {@link MultiOwnerAlertChannel} can fall back to another channel.
 */
export class EmailOwnerAlertChannel implements OwnerAlertChannel {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: EmailOwnerAlertChannelConfig) {
    if (!config.apiKey) throw new Error('Owner alert email channel requires an API key.');
    if (!config.ownerEmail) throw new Error('Owner alert email channel requires an owner address.');
    if (!config.fromAddress) throw new Error('Owner alert email channel requires a from address.');
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async send(alert: OwnerAlert): Promise<void> {
    const response = await this.fetchImpl(
      `${this.config.apiUrl ?? 'https://api.resend.com'}/emails`,
      {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: `${this.config.fromName} <${this.config.fromAddress}>`,
          to: [this.config.ownerEmail],
          subject: alertSubject(alert.kind),
          text: `${alertSubject(alert.kind)}\n\nDetail: ${alert.detail}\nOccurred at: ${alert.occurredAt}`,
        }),
      },
    );
    if (!response.ok) throw new Error(`owner_alert_email_http_${response.status}`);
    const parsed = resendResponseSchema.safeParse(await response.json());
    if (!parsed.success || !parsed.data.id) throw new Error('owner_alert_email_missing_id');
  }
}

export interface WebhookOwnerAlertChannelConfig {
  url: string;
  /** Optional shared secret; when present, signs the body as `X-Alert-Signature: sha256=<hex>`. */
  signingSecret?: string;
  fetchImpl?: typeof fetch;
}

/** Optional chat-channel alert (IMPLEMENTATION_PLAN §10: "and optionally a chat channel"). */
export class WebhookOwnerAlertChannel implements OwnerAlertChannel {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: WebhookOwnerAlertChannelConfig) {
    if (!config.url) throw new Error('Owner alert webhook channel requires a URL.');
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async send(alert: OwnerAlert): Promise<void> {
    const body = JSON.stringify(scrubValue(alert));
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.signingSecret) {
      headers['X-Alert-Signature'] = `sha256=${createHmac('sha256', this.config.signingSecret)
        .update(body)
        .digest('hex')}`;
    }
    const response = await this.fetchImpl(this.config.url, {
      method: 'POST',
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`owner_alert_webhook_http_${response.status}`);
  }
}

/**
 * Fans an alert out to every configured channel and only throws if every one
 * of them failed — one channel being down (a bad webhook URL, say) must not
 * silently swallow the email the owner actually needs.
 */
export class MultiOwnerAlertChannel implements OwnerAlertChannel {
  constructor(private readonly channels: readonly OwnerAlertChannel[]) {}

  async send(alert: OwnerAlert): Promise<void> {
    const results = await Promise.allSettled(this.channels.map((channel) => channel.send(alert)));
    const allFailed = results.length > 0 && results.every((result) => result.status === 'rejected');
    if (allFailed) throw new Error('owner_alert_all_channels_failed');
  }
}

export interface CreateOwnerAlertChannelOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

/**
 * Builds the owner alert channel from environment configuration.
 * `OWNER_ALERT_EMAIL` + `RESEND_API_KEY` wires the email channel;
 * `OWNER_ALERT_WEBHOOK_URL` additionally wires the optional chat channel.
 * Neither configured yields {@link NoopOwnerAlertChannel} so a caller can
 * always call `.send()` without checking configuration first.
 */
export function createOwnerAlertChannelFromEnv(
  options: CreateOwnerAlertChannelOptions = {},
): OwnerAlertChannel {
  const env = options.env ?? process.env;
  const channels: OwnerAlertChannel[] = [];

  const ownerEmail = env['OWNER_ALERT_EMAIL'];
  const apiKey = env['RESEND_API_KEY'];
  const fromAddress = env['RESEND_FROM_EMAIL'];
  const fromName = env['RESEND_FROM_NAME'];
  if (ownerEmail && apiKey && fromAddress && fromName) {
    channels.push(
      new EmailOwnerAlertChannel({
        apiKey,
        ownerEmail,
        fromAddress,
        fromName,
        fetchImpl: options.fetchImpl,
      }),
    );
  }

  const webhookUrl = env['OWNER_ALERT_WEBHOOK_URL'];
  if (webhookUrl) {
    channels.push(
      new WebhookOwnerAlertChannel({
        url: webhookUrl,
        signingSecret: env['OWNER_ALERT_WEBHOOK_SECRET'],
        fetchImpl: options.fetchImpl,
      }),
    );
  }

  if (channels.length === 0) return new NoopOwnerAlertChannel();
  return channels.length === 1 ? channels[0]! : new MultiOwnerAlertChannel(channels);
}
