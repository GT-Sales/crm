import { withTenantTx, type DatabaseClient } from '@gt-sales/db';
import { CUSTOMER_MAIL_ACTOR_ID } from '@gt-sales/contracts';
import { sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';

import { verifyResendSignature } from '../machines/registry.js';
import { keptMailText } from './kept-text.js';
import {
  htmlToText,
  loadReplyAddressing,
  replyText,
  type ReplyAddressing,
} from './reply-address.js';

/**
 * Customer replies coming in. The mail provider (Resend) posts an
 * `email.received` event here for every mail to the inbound domain; the event
 * carries addresses and a subject, never the words. A mail addressed to a
 * lead's reply address (reply-address.ts) is fetched from the provider and
 * kept on that lead's timeline as a `customer_replied` entry, its subject and
 * text in `body` beside the mails the CRM sent, so erasing the customer's data
 * removes it the same way. Any other mail is ignored: this is not a mailbox.
 *
 * Configured by `RESEND_INBOUND_WEBHOOK_SECRET` (the webhook's `whsec_…`
 * signing secret) and `RESEND_API_KEY`, with the reply addressing's settings.
 */
export interface ReceivedEmail {
  subject: string;
  text: string;
}

export interface InboundReplyStore {
  record(input: {
    workspaceId: string;
    leadId: string;
    /** The provider's id of the received mail: one entry per mail, however often it is delivered. */
    inboundId: string;
    subject: string;
    text: string;
  }): Promise<'recorded' | 'duplicate' | 'no_lead'>;
}

export interface InboundMailDependencies {
  /** The webhook's signing secret; undefined, the route answers 404. */
  secret: string | undefined;
  replies: ReplyAddressing | undefined;
  /** The mail's words from the provider; undefined when it cannot be read just now. */
  fetchEmail(emailId: string): Promise<ReceivedEmail | undefined>;
  store: InboundReplyStore;
  now?: () => number;
}

export class DatabaseInboundReplyStore implements InboundReplyStore {
  constructor(private readonly database: Pick<DatabaseClient, 'withTenantTx'> = { withTenantTx }) {}

  record(input: Parameters<InboundReplyStore['record']>[0]) {
    return this.database.withTenantTx(
      { workspaceId: input.workspaceId, actorId: CUSTOMER_MAIL_ACTOR_ID },
      async (tx): Promise<'recorded' | 'duplicate' | 'no_lead'> => {
        // A lead whose customer data is restricted keeps nothing new about them.
        const [lead] = await tx.execute<{ id: string }>(sql`
          select l.id from app.leads l
          where l.workspace_id = ${input.workspaceId} and l.id = ${input.leadId}
            and l.customer_data_restricted_at is null
          for update
        `);
        if (!lead) return 'no_lead';
        const [seen] = await tx.execute<{ id: string }>(sql`
          select a.id from app.lead_activities a
          where a.workspace_id = ${input.workspaceId} and a.lead_id = ${input.leadId}
            and a.kind = 'system' and a.data ->> 'inboundId' = ${input.inboundId}
          limit 1
        `);
        if (seen) return 'duplicate';
        const kept = keptMailText({ subject: input.subject, text: input.text });
        const data = {
          event: 'customer_replied',
          inboundId: input.inboundId,
          ...(kept.cut ? { textCut: true } : {}),
        };
        await tx.execute(sql`
          insert into app.lead_activities (workspace_id, lead_id, actor_id, kind, body, data)
          values (${input.workspaceId}, ${input.leadId}, ${CUSTOMER_MAIL_ACTOR_ID}, 'system',
            ${kept.body}, ${JSON.stringify(data)}::jsonb)
        `);
        // A reply is news on the lead: it moves up the inbox.
        await tx.execute(sql`
          update app.leads set updated_at = now()
          where workspace_id = ${input.workspaceId} and id = ${input.leadId}
        `);
        return 'recorded';
      },
    );
  }
}

const receivedSchema = z.object({
  subject: z.string().nullish(),
  text: z.string().nullish(),
  html: z.string().nullish(),
});

/** Reads a received mail's words from Resend; undefined on any failure (the webhook is retried). */
export function resendReceivedEmailFetcher(
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): InboundMailDependencies['fetchEmail'] {
  return async (emailId) => {
    if (!apiKey) return undefined;
    try {
      const response = await fetchImpl(
        `https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`,
        {
          headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
          signal: AbortSignal.timeout(8_000),
          redirect: 'error',
        },
      );
      if (!response.ok) return undefined;
      const mail = receivedSchema.parse(await response.json());
      const text = mail.text?.trim() ? mail.text : htmlToText(mail.html ?? '');
      return { subject: mail.subject?.trim() || '(no subject)', text };
    } catch {
      return undefined;
    }
  };
}

export function createDefaultInboundMailDependencies(
  env: NodeJS.ProcessEnv = process.env,
): InboundMailDependencies {
  return {
    secret: env['RESEND_INBOUND_WEBHOOK_SECRET']?.trim() || undefined,
    replies: loadReplyAddressing(env),
    fetchEmail: resendReceivedEmailFetcher(env['RESEND_API_KEY']?.trim() || undefined),
    store: new DatabaseInboundReplyStore(),
  };
}

const eventSchema = z.object({ type: z.string().min(1).max(100), data: z.unknown() });
const addresses = z.array(z.string().max(320)).max(100).nullish();
const receivedEventSchema = z.object({
  email_id: z.string().min(1).max(200),
  to: addresses,
  cc: addresses,
  received_for: addresses,
});

/** `Name <a@b.c>` → `a@b.c`. */
function bareAddress(value: string): string {
  const angled = /<([^<>]+)>\s*$/.exec(value);
  return (angled?.[1] ?? value).trim();
}

/** Mounted with express.raw BEFORE the app's JSON parser: the signature covers the raw body. */
export function createInboundMailRouter(dependencies: InboundMailDependencies): Router {
  const router = Router();
  router.post('/', async (req, res) => {
    const { secret, replies } = dependencies;
    if (!secret || !replies) {
      res.status(404).json({ error: 'not_configured' });
      return;
    }
    if (!Buffer.isBuffer(req.body)) {
      res.status(400).json({ error: 'raw_json_required' });
      return;
    }
    const signed = verifyResendSignature(
      {
        id: req.get('svix-id') ?? '',
        timestamp: req.get('svix-timestamp') ?? '',
        signature: req.get('svix-signature') ?? '',
        rawBody: req.body,
      },
      secret,
      (dependencies.now ?? Date.now)(),
    );
    if (!signed) {
      res.status(401).json({ error: 'invalid_webhook_signature' });
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(req.body.toString('utf8'));
    } catch {
      res.status(400).json({ error: 'invalid_event' });
      return;
    }
    const event = eventSchema.safeParse(body);
    if (!event.success) {
      res.status(400).json({ error: 'invalid_event' });
      return;
    }
    if (event.data.type !== 'email.received') {
      res.status(200).json({ status: 'ignored' });
      return;
    }
    const received = receivedEventSchema.safeParse(event.data.data);
    if (!received.success) {
      res.status(400).json({ error: 'invalid_event' });
      return;
    }
    const target = [
      ...(received.data.received_for ?? []),
      ...(received.data.to ?? []),
      ...(received.data.cc ?? []),
    ]
      .map((address) => replies.resolve(bareAddress(address)))
      .find((found) => found !== undefined);
    if (!target) {
      // Not a reply to a lead's mail: nothing here is a mailbox.
      res.status(200).json({ status: 'ignored' });
      return;
    }
    try {
      const mail = await dependencies.fetchEmail(received.data.email_id);
      if (!mail) {
        // A non-2xx makes the provider deliver the event again.
        res.status(503).json({ error: 'mail_unavailable' });
        return;
      }
      const status = await dependencies.store.record({
        ...target,
        inboundId: received.data.email_id,
        subject: mail.subject,
        text: replyText(mail.text),
      });
      res.status(200).json({ status });
    } catch {
      // No words and no address in a log: only that this delivery failed.
      res.status(500).json({ error: 'internal_error' });
    }
  });
  return router;
}
