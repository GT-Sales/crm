import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { rateLimitHit } from '@gt-sales/db';
import { z } from 'zod';

import {
  defaultStaffSessionVerifier,
  requireStaffSession,
  type StaffRateLimit,
  type StaffSessionVerifier,
} from '../auth/session.js';
import { DatabaseEmailStore, type EmailStore } from '../email/store.js';
import { hashContact, requireContactHashSecret } from '../email/hash.js';
import { createAuthorize } from '../staff/authorization.js';
import { DatabaseStaffStore, type StaffStore } from '../staff/store.js';
import { loadMachineRegistry, type MachineRegistry } from '../machines/registry.js';

export interface EmailRouteDependencies {
  store: EmailStore;
  sessionVerifier: StaffSessionVerifier;
  /** Per-IP limit applied before any session check; omitted in route tests. */
  rateLimit?: StaffRateLimit;
  /**
   * Read lazily (only when a request actually needs it), not at app
   * construction — so a deployment/test that never exercises an email route
   * is never forced to configure this secret up front.
   */
  contactHashSecret: () => string;
  /** The consent-version string recorded for an unsubscribe (CASL). */
  unsubscribeConsentVersion: string;
  registry: MachineRegistry;
  /** Read-only visibility into delivery status is `workspace.read`, not a privileged financial action. */
  authorizeDeliveryView: (actorId: string, workspaceId: string) => Promise<boolean>;
}

/**
 * `SES_...` env vars are read only here; nothing above the route layer
 * touches them. Missing config fails closed rather than defaulting.
 */
export function createDefaultEmailRouteDependencies(
  staffStore: Pick<StaffStore, 'loadStaffAccess'> = new DatabaseStaffStore(),
): EmailRouteDependencies {
  return {
    store: new DatabaseEmailStore(),
    sessionVerifier: defaultStaffSessionVerifier(),
    rateLimit: rateLimitHit,
    contactHashSecret: () => requireContactHashSecret(),
    unsubscribeConsentVersion: process.env.MARKETING_CONSENT_VERSION ?? '1',
    registry: loadMachineRegistry(),
    authorizeDeliveryView: async (actorId, workspaceId) => {
      const authorize = createAuthorize({ accessStore: staffStore });
      const decision = await authorize({ actorId, workspaceId, action: 'workspace.read' });
      return decision.allowed;
    },
  };
}

/**
 * Builds an unsubscribe token that identifies a workspace + contact + lead
 * without a login/session, and without embedding the raw email address. The
 * signature binds all three fields so a token cannot be replayed against a
 * different workspace or lead.
 */
export function buildUnsubscribeToken(
  secret: string,
  input: { workspaceId: string; contactHash: string; leadId?: string },
): string {
  const payload = `${input.workspaceId}.${input.contactHash}.${input.leadId ?? ''}`;
  const signature = createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
  return Buffer.from(`${payload}.${signature}`, 'utf8').toString('base64url');
}

function verifyUnsubscribeToken(
  secret: string,
  token: string,
): { workspaceId: string; contactHash: string; leadId?: string } | undefined {
  let decoded: string;
  try {
    decoded = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
  const parts = decoded.split('.');
  if (parts.length !== 4) return undefined;
  const workspaceId = parts[0];
  const contactHash = parts[1];
  const leadId = parts[2];
  const signature = parts[3];
  if (
    workspaceId === undefined ||
    contactHash === undefined ||
    leadId === undefined ||
    signature === undefined
  ) {
    return undefined;
  }
  const payload = `${workspaceId}.${contactHash}.${leadId}`;
  const expected = createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(signature, 'utf8');
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    return undefined;
  }
  const parsed = z
    .object({
      workspaceId: z.uuid(),
      contactHash: z.string().regex(/^[a-f0-9]{64}$/),
      leadId: z.uuid(),
    })
    .safeParse({ workspaceId, contactHash, leadId });
  return parsed.success ? parsed.data : undefined;
}

const resendEventSchema = z.object({
  type: z.string().min(1).max(100),
  created_at: z.iso.datetime(),
  data: z.unknown(),
});
const resendEmailSchema = z.object({
  email_id: z.string().min(1).max(200),
  to: z.array(z.email()).length(1),
  tags: z.record(z.string(), z.string()).optional(),
  bounce: z.object({ type: z.string().min(1) }).optional(),
});

/** Mounted with express.raw BEFORE the app's JSON parser. The old normalized
 * shared-secret endpoint is retired; only a native signed Resend event is accepted.
 */
export function createResendWebhookRouter(dependencies: EmailRouteDependencies): Router {
  const router = Router();
  router.post('/:selector', async (req, res) => {
    if (!Buffer.isBuffer(req.body)) {
      res.status(400).json({ error: 'raw_json_required' });
      return;
    }
    const identity = dependencies.registry.resolveResendWebhook({
      selector: String(req.params.selector),
      rawBody: req.body,
      id: req.get('svix-id') ?? '',
      timestamp: req.get('svix-timestamp') ?? '',
      signature: req.get('svix-signature') ?? '',
    });
    if (!identity.ok) {
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
    const parsed = resendEventSchema.safeParse(body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_event' });
      return;
    }
    const types = {
      'email.delivered': 'delivered',
      'email.bounced': 'bounce',
      'email.complained': 'complaint',
      'email.failed': 'reject',
    } as const;
    const eventType = Object.entries(types).find(([key]) => key === parsed.data.type)?.[1];
    if (!eventType) {
      res.status(200).json({ status: 'ignored' });
      return;
    }
    const email = resendEmailSchema.safeParse(parsed.data.data);
    if (!email.success) {
      res.status(400).json({ error: 'invalid_event' });
      return;
    }
    const tag = email.data.tags?.cp_message_id;
    if (tag !== undefined && !z.uuid().safeParse(tag).success) {
      res.status(400).json({ error: 'invalid_event' });
      return;
    }
    const outcome = await dependencies.store.applyProviderEvent({
      workspaceId: identity.workspaceId,
      actorId: identity.actorId,
      provider: identity.provider,
      providerAccount: identity.providerAccount,
      providerEventId: req.get('svix-id')!,
      eventType,
      providerMessageId: email.data.email_id,
      messageId: tag,
      contactHash: hashContact(email.data.to[0]!, dependencies.contactHashSecret()),
      hardBounce: eventType === 'bounce' && email.data.bounce?.type === 'Permanent',
      receivedAt: new Date(parsed.data.created_at),
    });
    // Retry uncorrelated events rather than acknowledging and losing an early event.
    res.status(outcome === 'invalid' ? 503 : 200).json({ status: outcome });
  });
  return router;
}

export function createEmailRouter(dependencies: EmailRouteDependencies): Router {
  const router = Router();

  router.get('/unsubscribe', async (req: Request, res: Response) => {
    const token = typeof req.query.token === 'string' ? req.query.token : undefined;
    if (!token) {
      res.status(400).json({ error: 'missing_token' });
      return;
    }
    const parsed = verifyUnsubscribeToken(dependencies.contactHashSecret(), token);
    if (!parsed) {
      res.status(400).json({ error: 'invalid_token' });
      return;
    }
    await dependencies.store.recordUnsubscribe({
      workspaceId: parsed.workspaceId,
      contactHash: parsed.contactHash,
      leadId: parsed.leadId,
      version: dependencies.unsubscribeConsentVersion,
      now: new Date(),
    });
    res.status(200).json({ status: 'unsubscribed' });
  });

  router.use('/staff', requireStaffSession(dependencies.sessionVerifier, dependencies.rateLimit));
  router.get('/staff/workspaces/:workspaceId/delivery', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const actor = req.staffSession;
    if (!workspaceId.success || !actor) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const authorized = await dependencies.authorizeDeliveryView(actor.actorId, workspaceId.data);
    if (!authorized) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const [rows, summary] = await Promise.all([
      dependencies.store.listDelivery(workspaceId.data, actor.actorId),
      dependencies.store.deliverySummary(workspaceId.data, actor.actorId),
    ]);
    // sent/delivered/failed/uncertain are surfaced as distinct counters, never
    // collapsed into a single "ok/error" status (T18 admin requirement).
    res.status(200).json({ messages: rows, summary });
  });

  return router;
}
