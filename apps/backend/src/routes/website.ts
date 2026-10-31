import {
  IDEMPOTENCY_KEY_HEADER,
  idempotencyKeySchema,
  isOrderLeadType,
  websiteBotActions,
  type WebsiteBotAction,
} from '@gt-sales/contracts';
import { Router, type Request, type Response } from 'express';
import { rateLimitHit, resolveWebsiteCredential } from '@gt-sales/db';
import {
  createIdentityUploadRequestSchema,
  createLeadRequestSchema,
  listWebsitePlansQuerySchema,
  createUploadIntentRequestSchema,
  finalizeUploadRequestSchema,
  submitLeadIdentityRequestSchema,
  updateLeadRequestSchema,
} from '@gt-sales/contracts';
import { z } from 'zod';

import { sensitiveFieldsKey } from '../crypto/cipher.js';
import { DatabaseDraftGrantVerifier, type DraftGrantVerifier } from '../documents/grant.js';
import { createDocumentServiceFromEnv } from '../documents/factory.js';
import { legacyIdentityKey } from '../documents/keys.js';
import { toFileSummary } from '../documents/summary.js';
import type { DocumentService } from '../documents/service.js';

import { sendDomainError } from '../http/domain-errors.js';
import { isConnectionLevelError, logRequestError } from '../http/logger.js';
import {
  idempotencyKeyHash,
  IdempotencyError,
  requestFingerprint,
  type IdempotencyInput,
} from '../leads/idempotency.js';
import {
  DatabaseIdentityStore,
  LEGACY_IDENTITY_BUCKET,
  type IdentityStore,
  type RecordIdentityOutcome,
} from '../leads/identity-store.js';
import {
  DatabaseLeadStore,
  ExternalRefTakenError,
  OrderIntakeError,
  type LeadStore,
} from '../leads/store.js';
import { parseDraftGrantToken } from '../leads/token.js';
import { checkLeadIntake } from '../leads/types.js';
import { DatabasePlanStore, type PlanStore } from '../plans/store.js';
import { createTurnstileVerifier } from '../website/turnstile.js';
import {
  loadEndpointRateLimits,
  requireEndpointRateLimit,
  requireScope,
  requireWebsiteCredential,
  requireHumanProof,
  websiteContext,
  type WebsiteAuthDependencies,
} from '../website/session.js';

const endpointRateLimits = loadEndpointRateLimits();

export interface WebsiteRouteDependencies {
  auth: WebsiteAuthDependencies;
  leads: { store: LeadStore };
  documents?: {
    service: Pick<
      DocumentService,
      'createIntent' | 'finalize' | 'issueDownload' | 'copyAvailableToBucket' | 'removeBucketCopy'
    >;
    grants: DraftGrantVerifier;
  };
  /** The ID step; absent without `SENSITIVE_FIELDS_KEY`, which refuses it rather than store a SIN unsealed. */
  identities?: { store: IdentityStore };
  /** The site's plans for its storefront; `createApp` supplies the staff plan store when omitted. */
  plans?: { store: PlanStore };
}

/**
 * How website writes prove a human is behind them.
 *
 * - `turnstile` (the default, and what any unrecognised value means): the
 *   website forwards a Cloudflare Turnstile token and the backend verifies it;
 *   without Turnstile configured every protected write is refused.
 * - `delegated`: the calling website's server is trusted to have screened the
 *   submission itself (honeypot, origin check, its own per-IP and per-email
 *   limits), as CanadaWide's routes do. The site key, the per-credential,
 *   per-visitor and per-endpoint limits still apply to every write. Turnstile
 *   is optional in the plan (docs/PLAN.md §5.10); this is the explicit way to
 *   run without it, never a silent fallback.
 */
export type WebsiteBotCheckMode = 'turnstile' | 'delegated';

export function websiteBotCheckMode(env: NodeJS.ProcessEnv = process.env): WebsiteBotCheckMode {
  return env.WEBSITE_BOT_CHECK === 'delegated' ? 'delegated' : 'turnstile';
}

export function createDefaultWebsiteRouteDependencies(): WebsiteRouteDependencies {
  const mode = websiteBotCheckMode();
  const turnstileSecret = process.env.TURNSTILE_SECRET_KEY;
  const turnstileHosts = (process.env.TURNSTILE_HOSTNAMES ?? process.env.TURNSTILE_HOSTNAME ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
  // Every protected write fails closed without these, so say so once at boot
  // instead of leaving the owner to discover it from website 403s.
  if (mode === 'turnstile' && (!turnstileSecret || turnstileHosts.length === 0)) {
    logRequestError({
      requestId: 'startup',
      route: 'website:turnstile',
      code: 'bot_check_unconfigured',
      flag: 'not_retryable',
    });
  }
  const verifiers = new Map(
    websiteBotActions.map((action) => [
      action,
      createTurnstileVerifier({
        secret: turnstileSecret,
        hostnames: turnstileHosts,
        action,
        onFailure: (code) =>
          logRequestError({
            requestId: 'turnstile',
            route: `website:${action}`,
            code: `bot_check_${code}`,
            flag: 'not_retryable',
          }),
      }),
    ]),
  );
  return {
    auth: {
      resolveCredential: resolveWebsiteCredential,
      rateLimit: rateLimitHit,
      botCheck:
        mode === 'delegated'
          ? () => true
          : (req, action) => verifiers.get(action)?.(req.get('x-turnstile-token')) ?? false,
    },
    leads: { store: new DatabaseLeadStore() },
    plans: { store: new DatabasePlanStore() },
    ...documentsDependencies(),
    ...identityDependencies(),
  };
}

function identityDependencies(): Pick<WebsiteRouteDependencies, 'identities'> {
  const secret = sensitiveFieldsKey();
  return secret ? { identities: { store: new DatabaseIdentityStore(secret) } } : {};
}

function documentsDependencies(): Pick<WebsiteRouteDependencies, 'documents'> {
  const service = createDocumentServiceFromEnv();
  if (!service) return {};
  return { documents: { service, grants: new DatabaseDraftGrantVerifier() } };
}

/**
 * Every website handler's last-resort failure path. Only a genuine
 * connection/availability failure is retryable; a logic bug or an unparsable
 * row surfaces as a non-retryable 500 instead of being masked as transient.
 * Each failure is logged with scrubbed identifiers only.
 */
export function failRequest(req: Request, res: Response, route: string, error: unknown): void {
  const workspaceId = req.websiteContext?.workspaceId;
  if (isConnectionLevelError(error)) {
    logRequestError({
      requestId: req.id,
      workspaceId,
      route,
      code: 'persistence_unavailable',
      flag: 'retryable',
    });
    res.setHeader('retry-after', '2');
    sendDomainError(res, req.id, 'persistence_unavailable', 503, { retryable: true });
    return;
  }
  logRequestError({
    requestId: req.id,
    workspaceId,
    route,
    code: 'internal_error',
    flag: 'not_retryable',
  });
  sendDomainError(res, req.id, 'internal_error', 500);
}

/**
 * The optional `Idempotency-Key` header: absent is fine, malformed is a 400
 * (the caller asked for a guarantee it cannot get). Only the key's hash goes
 * further; the raw value is never logged, stored or put in an error.
 */
function readIdempotencyKey(req: Request): { ok: true; keyHash?: string } | { ok: false } {
  const header = req.get(IDEMPOTENCY_KEY_HEADER);
  if (header === undefined) return { ok: true };
  const key = idempotencyKeySchema.safeParse(header);
  return key.success ? { ok: true, keyHash: idempotencyKeyHash(key.data) } : { ok: false };
}

/** A keyed request the store refused; `in_progress` tells the caller when to retry. */
function sendIdempotencyRefusal(
  res: Response,
  requestId: string,
  code: IdempotencyError['code'],
): void {
  if (code === 'idempotency_in_progress') res.setHeader('retry-after', '2');
  sendDomainError(res, requestId, code, 409);
}

function requireDraftGrant(req: Request): string | undefined {
  return parseDraftGrantToken(req.get('x-draft-grant'));
}

/**
 * Website intake surface. Every route authenticates by service credential
 * only: the workspace and scopes come from the credential, so a `workspace_id`
 * in the body, or a spoofed Host/Origin, cannot change the tenant. The website
 * has no human actor, so the credential's own id stands in as `actorId` for
 * its tenant writes.
 */
export function createWebsiteRouter(dependencies: WebsiteRouteDependencies): Router {
  const router = Router();
  const authenticate = requireWebsiteCredential(dependencies.auth);
  // Credential (and its rate limits) first: an unauthenticated caller must never
  // make the backend call Cloudflare, and every write still proves a human once.
  const admit = (action: WebsiteBotAction) => [
    authenticate,
    requireHumanProof(dependencies.auth, action),
  ];

  router.post(
    '/leads',
    ...admit('lead-save'),
    requireScope('leads:write'),
    requireEndpointRateLimit(dependencies.auth, 'leads', endpointRateLimits.leads),
    async (req, res) => {
      const body = createLeadRequestSchema.safeParse(req.body);
      if (!body.success) {
        sendDomainError(res, req.id, 'validation_error', 400);
        return;
      }
      const key = readIdempotencyKey(req);
      if (!key.ok) {
        sendDomainError(res, req.id, 'validation_error', 400, { field: IDEMPOTENCY_KEY_HEADER });
        return;
      }
      const idempotency: IdempotencyInput | undefined =
        key.keyHash === undefined
          ? undefined
          : { keyHash: key.keyHash, fingerprint: requestFingerprint(body.data) };

      // The registry decides what a lead of this type must carry. The detail
      // names the refused part only, never a submitted value.
      const intake = checkLeadIntake(body.data);
      if (!intake.ok) {
        sendDomainError(res, req.id, 'validation_error', 400, { field: intake.problem });
        return;
      }
      // Only an order type takes a plan; the store checks the plan itself.
      if (body.data.order && !isOrderLeadType(body.data.leadType)) {
        sendDomainError(res, req.id, 'invalid_request', 400, { field: 'order' });
        return;
      }

      try {
        const ctx = websiteContext(req);
        const result = await dependencies.leads.store.createLead({
          workspaceId: ctx.workspaceId,
          actorId: ctx.credentialId,
          requestId: req.id,
          leadType: body.data.leadType,
          externalRef: body.data.externalRef,
          contact: body.data.contact,
          form: body.data.form,
          attribution: body.data.attribution,
          consentVersion: body.data.consentVersion,
          submit: body.data.submit,
          order: body.data.order,
          idempotency,
        });
        res.status(201).json({
          lead: result.lead,
          draftGrant: result.grant,
          ...(result.replayed ? { replayed: true } : {}),
          requestId: req.id,
        });
      } catch (error) {
        if (error instanceof IdempotencyError) {
          sendIdempotencyRefusal(res, req.id, error.code);
          return;
        }
        if (error instanceof OrderIntakeError) {
          sendDomainError(res, req.id, error.code, 400, { field: 'order' });
          return;
        }
        if (error instanceof ExternalRefTakenError) {
          sendDomainError(res, req.id, error.code, 409);
          return;
        }
        failRequest(req, res, '/api/v1/website/leads', error);
      }
    },
  );

  // The storefront's plans: a read with no visitor behind it to prove, so no
  // bot check; never cached, so a price change shows on the next request.
  router.get('/plans', authenticate, requireScope('leads:write'), async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    const query = listWebsitePlansQuerySchema.safeParse(req.query);
    if (!query.success) {
      sendDomainError(res, req.id, 'validation_error', 400);
      return;
    }
    try {
      if (!dependencies.plans) throw new Error('plan store is not configured');
      const ctx = websiteContext(req);
      const plans = await dependencies.plans.store.listForWebsite(
        { workspaceId: ctx.workspaceId, actorId: ctx.credentialId },
        query.data.leadType,
      );
      res.json({ plans, requestId: req.id });
    } catch (error) {
      failRequest(req, res, '/api/v1/website/plans', error);
    }
  });

  router.get('/leads/:leadId', authenticate, requireScope('leads:write'), async (req, res) => {
    res.setHeader('cache-control', 'private, no-store');
    const leadId = z.uuid().safeParse(req.params['leadId']);
    const grantToken = requireDraftGrant(req);
    if (!leadId.success) {
      sendDomainError(res, req.id, 'validation_error', 400);
      return;
    }
    if (!grantToken) {
      sendDomainError(res, req.id, 'draft_not_found', 401);
      return;
    }
    try {
      const ctx = websiteContext(req);
      const outcome = await dependencies.leads.store.readLead({
        workspaceId: ctx.workspaceId,
        actorId: ctx.credentialId,
        leadId: leadId.data,
        grantToken,
      });
      if (outcome.status !== 'read') {
        const code =
          outcome.status === 'grant_expired'
            ? 'draft_expired'
            : outcome.status === 'draft_submitted'
              ? 'draft_already_submitted'
              : 'draft_not_found';
        sendDomainError(res, req.id, code, outcome.status === 'draft_submitted' ? 409 : 401);
        return;
      }
      res.json({ draft: outcome.draft, requestId: req.id });
    } catch (error) {
      failRequest(req, res, '/api/v1/website/leads/:leadId', error);
    }
  });

  router.patch(
    '/leads/:leadId',
    ...admit('lead-save'),
    requireScope('leads:write'),
    requireEndpointRateLimit(dependencies.auth, 'leads', endpointRateLimits.leads),
    async (req, res) => {
      const leadId = z.uuid().safeParse(req.params['leadId']);
      const body = updateLeadRequestSchema.safeParse(req.body);
      if (!leadId.success || !body.success) {
        sendDomainError(res, req.id, 'validation_error', 400);
        return;
      }

      const key = readIdempotencyKey(req);
      if (!key.ok) {
        sendDomainError(res, req.id, 'validation_error', 400, { field: IDEMPOTENCY_KEY_HEADER });
        return;
      }
      // Only a submission is made once; a plain save is already repeatable.
      const idempotency: IdempotencyInput | undefined =
        key.keyHash === undefined || body.data.submit !== true
          ? undefined
          : {
              keyHash: key.keyHash,
              fingerprint: requestFingerprint({ leadId: leadId.data, body: body.data }),
            };

      const grantToken = requireDraftGrant(req);
      if (!grantToken) {
        sendDomainError(res, req.id, 'draft_not_found', 401);
        return;
      }

      try {
        const ctx = websiteContext(req);
        const outcome = await dependencies.leads.store.updateLead({
          workspaceId: ctx.workspaceId,
          actorId: ctx.credentialId,
          requestId: req.id,
          leadId: leadId.data,
          grantToken,
          contact: body.data.contact,
          form: body.data.form,
          attribution: body.data.attribution,
          consentVersion: body.data.consentVersion,
          order: body.data.order,
          submit: body.data.submit,
          idempotency,
        });

        if (outcome.status === 'grant_invalid') {
          sendDomainError(res, req.id, 'draft_not_found', 401);
          return;
        }
        if (outcome.status === 'grant_expired') {
          sendDomainError(res, req.id, 'draft_expired', 401);
          return;
        }
        if (outcome.status === 'draft_submitted') {
          sendDomainError(res, req.id, 'draft_already_submitted', 409);
          return;
        }
        if (outcome.status === 'order_not_allowed' || outcome.status === 'plan_not_available') {
          const code =
            outcome.status === 'order_not_allowed' ? 'invalid_request' : 'plan_not_available';
          sendDomainError(res, req.id, code, 400, { field: 'order' });
          return;
        }
        if (
          outcome.status === 'idempotency_conflict' ||
          outcome.status === 'idempotency_in_progress'
        ) {
          sendIdempotencyRefusal(res, req.id, outcome.status);
          return;
        }
        // As on a create: the detail names the part refused, never a value.
        if (outcome.status === 'submission_incomplete') {
          sendDomainError(res, req.id, 'validation_error', 400, { field: outcome.problem });
          return;
        }

        res.json({
          lead: outcome.lead,
          ...(outcome.replayed ? { replayed: true } : {}),
          requestId: req.id,
        });
      } catch (error) {
        failRequest(req, res, '/api/v1/website/leads/:leadId', error);
      }
    },
  );

  // ---- Customer document uploads ------------------------------------------
  // The service credential proves the workspace; the draft grant proves which
  // lead the customer owns. Uploads attach to that lead.
  const documents = dependencies.documents;

  router.post(
    '/uploads/intents',
    ...admit('upload-intent'),
    requireScope('uploads:customer'),
    async (req, res) => {
      if (!documents) {
        sendDomainError(res, req.id, 'feature_not_ready', 409);
        return;
      }
      const body = createUploadIntentRequestSchema.safeParse(req.body);
      const grantToken = requireDraftGrant(req);
      if (!body.success) {
        sendDomainError(res, req.id, 'validation_error', 400);
        return;
      }
      if (!grantToken) {
        sendDomainError(res, req.id, 'draft_not_found', 401);
        return;
      }
      try {
        const ctx = websiteContext(req);
        const leadId = await documents.grants.verifyLead({
          workspaceId: ctx.workspaceId,
          actorId: ctx.credentialId,
          grantToken,
          now: new Date(),
        });
        // Customer uploads only ever attach to their own lead. `parentType` must be
        // 'lead' and `parentId` must match the grant's lead.
        if (!leadId || body.data.parentType !== 'lead' || body.data.parentId !== leadId) {
          sendDomainError(res, req.id, 'draft_not_found', 401);
          return;
        }
        const outcome = await documents.service.createIntent({
          workspaceId: ctx.workspaceId,
          actorId: ctx.credentialId,
          requestId: req.id,
          recordType: 'lead',
          recordId: leadId,
          documentType: body.data.documentType,
          declaredContentType: body.data.contentType,
          declaredSizeBytes: body.data.sizeBytes,
        });
        if (outcome.status === 'created') {
          res.status(201).json({
            uploadId: outcome.uploadId,
            url: outcome.url,
            method: 'PUT',
            headers: outcome.headers,
            expiresAt: outcome.expiresAt.toISOString(),
            requestId: req.id,
          });
          return;
        }
        if (outcome.status === 'parent_not_found') {
          sendDomainError(res, req.id, 'draft_not_found', 401);
          return;
        }
        if (outcome.status === 'too_large') {
          sendDomainError(res, req.id, 'document_too_large', 413);
          return;
        }
        sendDomainError(res, req.id, 'checklist_mismatch', 409);
      } catch (error) {
        failRequest(req, res, '/api/v1/website/uploads/intents', error);
      }
    },
  );

  router.post(
    '/uploads/:uploadId/finalize',
    ...admit('upload-finalize'),
    requireScope('uploads:customer'),
    async (req, res) => {
      if (!documents) {
        sendDomainError(res, req.id, 'feature_not_ready', 409);
        return;
      }
      const uploadId = z.uuid().safeParse(req.params['uploadId']);
      const body = finalizeUploadRequestSchema.safeParse(req.body);
      const grantToken = requireDraftGrant(req);
      if (!uploadId.success || !body.success) {
        sendDomainError(res, req.id, 'validation_error', 400);
        return;
      }
      if (!grantToken) {
        sendDomainError(res, req.id, 'draft_not_found', 401);
        return;
      }
      try {
        const ctx = websiteContext(req);
        const leadId = await documents.grants.verifyLead({
          workspaceId: ctx.workspaceId,
          actorId: ctx.credentialId,
          grantToken,
          now: new Date(),
        });
        if (!leadId) {
          sendDomainError(res, req.id, 'draft_not_found', 401);
          return;
        }
        const outcome = await documents.service.finalize({
          workspaceId: ctx.workspaceId,
          actorId: ctx.credentialId,
          requestId: req.id,
          fileId: uploadId.data,
          checksumSha256: body.data.checksumSha256,
          ownedLeadId: leadId,
        });
        switch (outcome.status) {
          case 'available':
            res.json({ file: toFileSummary(outcome.file), requestId: req.id });
            return;
          case 'rejected':
            sendDomainError(res, req.id, 'document_verification_failed', 422, {
              reason: outcome.reason,
            });
            return;
          case 'in_progress':
            res.setHeader('retry-after', '2');
            sendDomainError(res, req.id, 'verification_in_progress', 409, { retryable: true });
            return;
          case 'expired':
            sendDomainError(res, req.id, 'upload_expired', 410);
            return;
          case 'not_found':
            sendDomainError(res, req.id, 'upload_not_found', 404);
            return;
        }
      } catch (error) {
        failRequest(req, res, '/api/v1/website/uploads/:uploadId/finalize', error);
      }
    },
  );

  router.post(
    '/files/:fileId/download-link',
    ...admit('file-download'),
    requireScope('uploads:customer'),
    async (req, res) => {
      if (!documents) {
        sendDomainError(res, req.id, 'feature_not_ready', 409);
        return;
      }
      const fileId = z.uuid().safeParse(req.params['fileId']);
      const grantToken = requireDraftGrant(req);
      if (!fileId.success) {
        sendDomainError(res, req.id, 'validation_error', 400);
        return;
      }
      if (!grantToken) {
        sendDomainError(res, req.id, 'draft_not_found', 401);
        return;
      }
      try {
        const ctx = websiteContext(req);
        const leadId = await documents.grants.verifyLead({
          workspaceId: ctx.workspaceId,
          actorId: ctx.credentialId,
          grantToken,
          now: new Date(),
        });
        if (!leadId) {
          sendDomainError(res, req.id, 'draft_not_found', 401);
          return;
        }
        const outcome = await documents.service.issueDownload({
          workspaceId: ctx.workspaceId,
          actorId: ctx.credentialId,
          fileId: fileId.data,
          requestId: req.id,
          ownedLeadId: leadId,
        });
        if (outcome.status === 'issued') {
          res.json({
            url: outcome.url,
            expiresAt: outcome.expiresAt.toISOString(),
            requestId: req.id,
          });
          return;
        }
        if (outcome.status === 'not_available') {
          sendDomainError(res, req.id, 'file_not_available', 409);
          return;
        }
        sendDomainError(res, req.id, 'file_not_found', 404);
      } catch (error) {
        failRequest(req, res, '/api/v1/website/files/:fileId/download-link', error);
      }
    },
  );

  // ---- The customer's identity for a credit check (CanadaWide's ID step) ---
  // The lead was created submitted, so there is no draft grant: what ties the
  // request to the lead is its id, which only the website's server holds, a
  // lead type that takes an identity, a 24-hour window and a cap per lead.
  const identities = dependencies.identities;

  router.post(
    '/leads/:leadId/identity/uploads',
    ...admit('identity-submit'),
    requireScope('leads:write'),
    requireEndpointRateLimit(dependencies.auth, 'identity', endpointRateLimits.identity),
    async (req, res) => {
      if (!identities || !documents) {
        sendDomainError(res, req.id, 'feature_not_ready', 409);
        return;
      }
      const leadId = z.uuid().safeParse(req.params['leadId']);
      const body = createIdentityUploadRequestSchema.safeParse(req.body);
      if (!leadId.success || !body.success) {
        sendDomainError(res, req.id, 'validation_error', 400);
        return;
      }
      try {
        const ctx = websiteContext(req);
        const scope = { workspaceId: ctx.workspaceId, actorId: ctx.credentialId };
        const eligibility = await identities.store.eligibility({ ...scope, leadId: leadId.data });
        if (eligibility.status !== 'eligible') {
          sendIdentityRefusal(req, res, eligibility.status);
          return;
        }
        const outcome = await documents.service.createIntent({
          ...scope,
          requestId: req.id,
          recordType: 'lead',
          recordId: leadId.data,
          documentType: 'drivers_licence',
          declaredContentType: body.data.contentType,
          declaredSizeBytes: body.data.sizeBytes,
        });
        if (outcome.status === 'created') {
          res.status(201).json({
            uploadId: outcome.uploadId,
            url: outcome.url,
            method: 'PUT',
            headers: outcome.headers,
            expiresAt: outcome.expiresAt.toISOString(),
            requestId: req.id,
          });
          return;
        }
        if (outcome.status === 'too_large') {
          sendDomainError(res, req.id, 'document_too_large', 413);
          return;
        }
        sendDomainError(res, req.id, 'lead_not_found', 404);
      } catch (error) {
        failRequest(req, res, '/api/v1/website/leads/:leadId/identity/uploads', error);
      }
    },
  );

  router.post(
    '/leads/:leadId/identity',
    ...admit('identity-submit'),
    requireScope('leads:write'),
    requireEndpointRateLimit(dependencies.auth, 'identity', endpointRateLimits.identity),
    async (req, res) => {
      if (!identities) {
        sendDomainError(res, req.id, 'feature_not_ready', 409);
        return;
      }
      const leadId = z.uuid().safeParse(req.params['leadId']);
      // The refusal never names or echoes a submitted value: this body can carry a SIN.
      const body = submitLeadIdentityRequestSchema.safeParse(req.body);
      if (!leadId.success || !body.success) {
        sendDomainError(res, req.id, 'validation_error', 400);
        return;
      }
      try {
        const ctx = websiteContext(req);
        const scope = {
          workspaceId: ctx.workspaceId,
          actorId: ctx.credentialId,
          requestId: req.id,
          leadId: leadId.data,
          consentedAt: new Date(),
        };
        let outcome: RecordIdentityOutcome;
        if (body.data.idType === 'sin') {
          outcome = await identities.store.recordSin({
            ...scope,
            sin: body.data.sin,
            dateOfBirth: body.data.dateOfBirth,
          });
        } else {
          if (!documents) {
            sendDomainError(res, req.id, 'feature_not_ready', 409);
            return;
          }
          const eligibility = await identities.store.eligibility(scope);
          if (eligibility.status !== 'eligible') {
            sendIdentityRefusal(req, res, eligibility.status);
            return;
          }
          const finalized = await documents.service.finalize({
            workspaceId: scope.workspaceId,
            actorId: scope.actorId,
            requestId: req.id,
            fileId: body.data.uploadId,
            checksumSha256: body.data.checksumSha256,
            ownedLeadId: scope.leadId,
          });
          switch (finalized.status) {
            case 'available':
              break;
            case 'rejected':
              sendDomainError(res, req.id, 'document_verification_failed', 422, {
                reason: finalized.reason,
              });
              return;
            case 'in_progress':
              res.setHeader('retry-after', '2');
              sendDomainError(res, req.id, 'verification_in_progress', 409, { retryable: true });
              return;
            case 'expired':
              sendDomainError(res, req.id, 'upload_expired', 410);
              return;
            case 'not_found':
              sendDomainError(res, req.id, 'upload_not_found', 404);
              return;
          }
          const file = finalized.file;
          if (file.documentType !== 'drivers_licence' || !file.detectedMime) {
            sendDomainError(res, req.id, 'upload_not_found', 404);
            return;
          }
          // The old admin reads ID photos from its own bucket, so the copy
          // goes there before the row that points at it. A failed copy fails
          // the step (retryable): the two admins never disagree.
          const legacyPath = eligibility.legacy
            ? legacyIdentityKey(scope.leadId, file.id, file.detectedMime)
            : null;
          if (legacyPath) {
            try {
              await documents.service.copyAvailableToBucket({
                workspaceId: scope.workspaceId,
                file,
                destinationBucket: LEGACY_IDENTITY_BUCKET,
                destinationKey: legacyPath,
              });
            } catch {
              logRequestError({
                requestId: req.id,
                workspaceId: scope.workspaceId,
                route: '/api/v1/website/leads/:leadId/identity',
                code: 'legacy_copy_failed',
                flag: 'retryable',
              });
              res.setHeader('retry-after', '2');
              sendDomainError(res, req.id, 'persistence_unavailable', 503, { retryable: true });
              return;
            }
          }
          outcome = await identities.store.recordLicence({ ...scope, fileId: file.id, legacyPath });
          // Undo a copy nothing links to. Never after `not_found`: a retry that
          // lands after the lead closed may share its key with the identity
          // already recorded, and an orphaned copy costs nothing.
          const unlinked =
            outcome.status === 'limit_reached' ||
            outcome.status === 'file_not_usable' ||
            (outcome.status === 'recorded' && !outcome.replayed && !outcome.mirrored);
          if (legacyPath && unlinked) {
            await documents.service
              .removeBucketCopy({ bucket: LEGACY_IDENTITY_BUCKET, key: legacyPath })
              .catch(() => undefined);
          }
        }
        if (outcome.status !== 'recorded') {
          sendIdentityRefusal(req, res, outcome.status);
          return;
        }
        res.status(201).json({ identity: outcome.identity, requestId: req.id });
      } catch (error) {
        failRequest(req, res, '/api/v1/website/leads/:leadId/identity', error);
      }
    },
  );

  return router;
}

function sendIdentityRefusal(
  req: Request,
  res: Response,
  status: 'not_found' | 'limit_reached' | 'file_not_usable',
): void {
  if (status === 'limit_reached') {
    sendDomainError(res, req.id, 'identity_limit_reached', 409);
    return;
  }
  if (status === 'file_not_usable') {
    sendDomainError(res, req.id, 'upload_not_found', 404);
    return;
  }
  sendDomainError(res, req.id, 'lead_not_found', 404);
}
