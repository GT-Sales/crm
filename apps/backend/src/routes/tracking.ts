import { createR2DocumentStoreFromEnv } from '@gt-sales/adapters';
import { Router, type Request, type Response } from 'express';
import {
  CHANGE_REQUEST_STAGES,
  TRACKING_CODE_REQUESTS_PER_EMAIL,
  TRACKING_EMAIL_WINDOW_SECONDS,
  TRACKING_MIN_LATENCY_MS,
  TRACKING_VERIFICATIONS_PER_EMAIL,
  TRACKING_WRITES_PER_EMAIL,
  createTrackedChangeRequestSchema,
  finalizeUploadRequestSchema,
  trackingCodeRequestSchema,
  trackingReferenceSchema,
  trackingUploadIntentRequestSchema,
  trackingVerifyRequestSchema,
} from '@gt-sales/contracts';
import { z } from 'zod';

import { createDocumentServiceFromEnv } from '../documents/factory.js';
import type { DocumentService } from '../documents/service.js';
import { sendDomainError } from '../http/domain-errors.js';
import { logRequestError } from '../http/logger.js';
import { sendWebsiteError } from '../http/website-errors.js';
import { customerEmailEnvironmentFromEnv } from '../email/senders.js';
import {
  ChangeRequestService,
  DatabaseChangeRequestStore,
  toTrackingPendingChange,
  type CustomerChangeOutcome,
} from '../tracking/change-requests.js';
import {
  emailRateBucket,
  loadTrackingSecret,
  normalizeTrackingEmail,
  type TrackingGrantIdentity,
} from '../tracking/secrets.js';
import { TrackingService } from '../tracking/service.js';
import { DatabaseTrackingStore, type TrackedLeadRef } from '../tracking/store.js';
import {
  loadEndpointRateLimits,
  requireEndpointRateLimit,
  requireHumanProof,
  requireScope,
  requireWebsiteCredential,
  websiteContext,
  websiteVisitorKey,
  type WebsiteAuthDependencies,
} from '../website/session.js';
import { failRequest } from './website.js';

const endpointRateLimits = loadEndpointRateLimits();

/** Per visitor, beside the per-email budgets: Canadian Plans' values (ruling T10). */
const CODE_REQUESTS_PER_VISITOR = 20;
const VERIFICATIONS_PER_VISITOR = 40;

export interface TrackingRouteDependencies {
  auth: WebsiteAuthDependencies;
  tracking: TrackingService;
  changeRequests: ChangeRequestService;
  documents?: { service: Pick<DocumentService, 'createIntent' | 'finalize'> };
  /**
   * `TRACKING_HASH_SECRET`: keys the per-email rate buckets. Tracking is on
   * only when this and `tracking.configured` both are.
   */
  secret: string | undefined;
  /** The neutral code answer's floor, measured from the request's start. */
  minLatencyMs?: number;
}

/** The deployment's tracking: the database stores, the secret and the document store, when configured. */
export function createDefaultTrackingRouteDependencies(
  auth: WebsiteAuthDependencies,
  env: NodeJS.ProcessEnv = process.env,
): TrackingRouteDependencies {
  const secret = loadTrackingSecret(env);
  const emailEnvironment = customerEmailEnvironmentFromEnv(env);
  let objects: ReturnType<typeof createR2DocumentStoreFromEnv> | undefined;
  try {
    objects = createR2DocumentStoreFromEnv(env);
  } catch {
    objects = undefined;
  }
  const documents = createDocumentServiceFromEnv(env);
  return {
    auth,
    secret,
    tracking: new TrackingService({
      store: new DatabaseTrackingStore(),
      secret,
      contactHash: (email) => emailEnvironment.contactHash(email),
    }),
    changeRequests: new ChangeRequestService({
      store: new DatabaseChangeRequestStore(),
      context: { emailEnvironment },
      ...(objects ? { objects } : {}),
    }),
    ...(documents ? { documents: { service: documents } } : {}),
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Customer order tracking for a website (ported from Canadian Plans'
 * `createTrackingRouter`, adapted to leads). The website's credential needs
 * the `tracking` scope; a code request answers the same neutral 200 after the
 * same floor whether or not the email has orders; a verified code yields a
 * grant bound to the site and the email, which every other route checks and
 * re-resolves orders by. Neither the email, the code nor the grant is logged.
 */
export function createTrackingRouter(dependencies: TrackingRouteDependencies): Router {
  const router = Router();
  const { auth, tracking, changeRequests } = dependencies;
  const minLatencyMs = dependencies.minLatencyMs ?? TRACKING_MIN_LATENCY_MS;
  const guard = [requireWebsiteCredential(auth), requireScope('tracking')];
  const limited = requireEndpointRateLimit(auth, 'tracking', endpointRateLimits.tracking);

  // One answer to "is tracking on": the service has its secret and so do the
  // routes, which key the per-email buckets with it. Either missing, tracking
  // is unconfigured, so a per-email bucket can never be skipped.
  const secret = tracking.configured ? dependencies.secret : undefined;

  /** A ten-minute rate bucket's verdict. */
  function allowed(bucketKey: string, maxCount: number) {
    return auth.rateLimit({ bucketKey, windowSeconds: TRACKING_EMAIL_WINDOW_SECONDS, maxCount });
  }

  /** The grant's identity, or the answer already sent (409 unconfigured, 401 no valid grant). */
  function identity(req: Request, res: Response): TrackingGrantIdentity | undefined {
    if (secret === undefined) {
      sendDomainError(res, req.id, 'feature_not_ready', 409);
      return undefined;
    }
    const verified = tracking.identify(
      req.get('x-customer-grant'),
      websiteContext(req).workspaceId,
    );
    if (!verified) {
      // Missing, forged, expired and another site's grants look the same.
      sendDomainError(res, req.id, 'not_found', 401);
      return undefined;
    }
    return verified;
  }

  /** The order the reference names among the grant's, or the answer already sent. */
  async function trackedLead(
    req: Request,
    res: Response,
    verified: TrackingGrantIdentity,
  ): Promise<TrackedLeadRef | undefined> {
    const reference = trackingReferenceSchema.safeParse(req.params['reference']);
    if (!reference.success) {
      sendDomainError(res, req.id, 'validation_error', 400, { field: 'reference' });
      return undefined;
    }
    const ctx = websiteContext(req);
    const lead = await tracking.resolveLead(
      { workspaceId: ctx.workspaceId, actorId: ctx.credentialId },
      verified,
      reference.data,
    );
    if (!lead) {
      sendDomainError(res, req.id, 'order_not_found', 404);
      return undefined;
    }
    return lead;
  }

  /** The per-email budget on a customer's writes, or the 429 already sent. */
  async function writeAllowed(
    req: Request,
    res: Response,
    verified: TrackingGrantIdentity,
  ): Promise<boolean> {
    if (secret === undefined) {
      sendDomainError(res, req.id, 'feature_not_ready', 409);
      return false;
    }
    const limit = await allowed(
      emailRateBucket(secret, verified.workspaceId, verified.normalizedEmail, 'write'),
      TRACKING_WRITES_PER_EMAIL,
    );
    if (limit.allowed) return true;
    sendWebsiteError(res, req.id, 'rate_limited', 429, {
      'retry-after': String(limit.retryAfterSeconds),
    });
    return false;
  }

  const isChangeable = (lead: TrackedLeadRef) =>
    lead.leadType === 'sim_order' && CHANGE_REQUEST_STAGES.some((stage) => stage === lead.stage);

  /** A customer write's outcome as the website reads it. */
  function sendChange(req: Request, res: Response, outcome: CustomerChangeOutcome, status: number) {
    switch (outcome.status) {
      case 'saved':
        res.status(status).json({
          changeRequest: toTrackingPendingChange(outcome.changeRequest),
          requestId: req.id,
        });
        return;
      case 'not_found':
        sendDomainError(res, req.id, 'order_not_found', 404);
        return;
      case 'not_allowed':
        sendDomainError(res, req.id, 'change_request_not_allowed', 409);
        return;
      case 'invalid_field':
        sendDomainError(res, req.id, 'validation_error', 400, { field: outcome.field });
        return;
    }
  }

  router.post(
    '/tracking/code',
    ...guard,
    requireHumanProof(auth, 'tracking-request'),
    limited,
    async (req, res) => {
      const startedAt = Date.now();
      const body = trackingCodeRequestSchema.safeParse(req.body);
      if (!body.success) {
        sendDomainError(res, req.id, 'validation_error', 400);
        return;
      }
      const ctx = websiteContext(req);
      try {
        if (secret !== undefined) {
          const normalizedEmail = normalizeTrackingEmail(body.data.email);
          // Both buckets count every request, whether or not the email has orders.
          const [byEmail, byVisitor] = await Promise.all([
            allowed(
              emailRateBucket(secret, ctx.workspaceId, normalizedEmail, 'code'),
              TRACKING_CODE_REQUESTS_PER_EMAIL,
            ),
            allowed(
              `tracking-code:visitor:${ctx.workspaceId}:${websiteVisitorKey(req)}`,
              CODE_REQUESTS_PER_VISITOR,
            ),
          ]);
          if (byEmail.allowed && byVisitor.allowed) {
            // Not awaited past the floor: a known email's lock and writes, or
            // a slow database, must not make its answer later than an
            // unknown email's. A failure is logged by code, never surfaced.
            void tracking
              .requestCode({
                workspaceId: ctx.workspaceId,
                actorId: ctx.credentialId,
                email: body.data.email,
              })
              .catch(() =>
                logRequestError({
                  requestId: req.id,
                  workspaceId: ctx.workspaceId,
                  route: '/api/v1/website/tracking/code',
                  code: 'tracking_code_request_failed',
                  flag: 'not_retryable',
                }),
              );
          }
        }
      } catch {
        logRequestError({
          requestId: req.id,
          workspaceId: ctx.workspaceId,
          route: '/api/v1/website/tracking/code',
          code: 'tracking_code_limit_failed',
          flag: 'not_retryable',
        });
      }
      const remaining = startedAt + minLatencyMs - Date.now();
      if (remaining > 0) await sleep(remaining);
      res.status(200).json({ status: 'code_sent', requestId: req.id });
    },
  );

  router.post(
    '/tracking/verify',
    ...guard,
    requireHumanProof(auth, 'tracking-verify'),
    limited,
    async (req, res) => {
      const body = trackingVerifyRequestSchema.safeParse(req.body);
      if (!body.success) {
        sendDomainError(res, req.id, 'validation_error', 400);
        return;
      }
      if (secret === undefined) {
        sendDomainError(res, req.id, 'feature_not_ready', 409);
        return;
      }
      try {
        const ctx = websiteContext(req);
        const normalizedEmail = normalizeTrackingEmail(body.data.email);
        const byEmail = await allowed(
          emailRateBucket(secret, ctx.workspaceId, normalizedEmail, 'verify'),
          TRACKING_VERIFICATIONS_PER_EMAIL,
        );
        const byVisitor = await allowed(
          `tracking-verify:visitor:${ctx.workspaceId}:${websiteVisitorKey(req)}`,
          VERIFICATIONS_PER_VISITOR,
        );
        if (!byEmail.allowed || !byVisitor.allowed) {
          const retryAfter = byEmail.allowed
            ? byVisitor.retryAfterSeconds
            : byEmail.retryAfterSeconds;
          sendWebsiteError(res, req.id, 'rate_limited', 429, { 'retry-after': String(retryAfter) });
          return;
        }
        const outcome = await tracking.verifyCode({
          workspaceId: ctx.workspaceId,
          actorId: ctx.credentialId,
          email: body.data.email,
          code: body.data.code,
        });
        if (outcome.status === 'verified') {
          res.status(200).json({ grant: outcome.grant, requestId: req.id });
          return;
        }
        // One answer for every other outcome: a guesser never learns how it ended.
        sendDomainError(res, req.id, 'tracking_challenge_invalid', 400);
      } catch (error) {
        failRequest(req, res, '/api/v1/website/tracking/verify', error);
      }
    },
  );

  router.get('/tracking/orders', ...guard, limited, async (req, res) => {
    const verified = identity(req, res);
    if (!verified) return;
    try {
      const ctx = websiteContext(req);
      const orders = await tracking.listOrders(
        { workspaceId: ctx.workspaceId, actorId: ctx.credentialId },
        verified,
      );
      res.status(200).json({ orders, requestId: req.id });
    } catch (error) {
      failRequest(req, res, '/api/v1/website/tracking/orders', error);
    }
  });

  router.post('/tracking/orders/:reference/changes', ...guard, limited, async (req, res) => {
    const verified = identity(req, res);
    if (!verified) return;
    const body = createTrackedChangeRequestSchema.safeParse(req.body);
    if (!body.success) {
      sendDomainError(res, req.id, 'validation_error', 400);
      return;
    }
    try {
      if (!(await writeAllowed(req, res, verified))) return;
      const lead = await trackedLead(req, res, verified);
      if (!lead) return;
      const ctx = websiteContext(req);
      const outcome = await changeRequests.requestChange({
        workspaceId: ctx.workspaceId,
        actorId: ctx.credentialId,
        requestId: req.id,
        leadId: lead.leadId,
        fields: body.data.fields,
        now: new Date(),
      });
      sendChange(req, res, outcome, 201);
    } catch (error) {
      failRequest(req, res, '/api/v1/website/tracking/orders/:reference/changes', error);
    }
  });

  router.post(
    '/tracking/orders/:reference/uploads/intents',
    ...guard,
    requireHumanProof(auth, 'upload-intent'),
    limited,
    async (req, res) => {
      const verified = identity(req, res);
      if (!verified) return;
      const documents = dependencies.documents;
      if (!documents) {
        sendDomainError(res, req.id, 'feature_not_ready', 409);
        return;
      }
      const body = trackingUploadIntentRequestSchema.safeParse(req.body);
      if (!body.success) {
        sendDomainError(res, req.id, 'validation_error', 400);
        return;
      }
      try {
        if (!(await writeAllowed(req, res, verified))) return;
        const lead = await trackedLead(req, res, verified);
        if (!lead) return;
        if (!isChangeable(lead)) {
          sendDomainError(res, req.id, 'change_request_not_allowed', 409);
          return;
        }
        const ctx = websiteContext(req);
        const outcome = await documents.service.createIntent({
          workspaceId: ctx.workspaceId,
          actorId: ctx.credentialId,
          requestId: req.id,
          recordType: 'lead',
          recordId: lead.leadId,
          documentType: body.data.documentType,
          declaredContentType: body.data.contentType,
          declaredSizeBytes: body.data.sizeBytes,
          held: true,
        });
        switch (outcome.status) {
          case 'created':
            res.status(201).json({
              uploadId: outcome.uploadId,
              url: outcome.url,
              method: 'PUT',
              headers: outcome.headers,
              expiresAt: outcome.expiresAt.toISOString(),
              requestId: req.id,
            });
            return;
          case 'parent_not_found':
            sendDomainError(res, req.id, 'order_not_found', 404);
            return;
          case 'too_large':
            sendDomainError(res, req.id, 'document_too_large', 413);
            return;
          case 'checklist_mismatch':
            sendDomainError(res, req.id, 'checklist_mismatch', 409);
            return;
        }
      } catch (error) {
        failRequest(req, res, '/api/v1/website/tracking/orders/:reference/uploads/intents', error);
      }
    },
  );

  router.post(
    '/tracking/orders/:reference/uploads/:uploadId/finalize',
    ...guard,
    requireHumanProof(auth, 'upload-finalize'),
    limited,
    async (req, res) => {
      const verified = identity(req, res);
      if (!verified) return;
      const documents = dependencies.documents;
      if (!documents) {
        sendDomainError(res, req.id, 'feature_not_ready', 409);
        return;
      }
      const uploadId = z.uuid().safeParse(req.params['uploadId']);
      const body = finalizeUploadRequestSchema.safeParse(req.body);
      if (!uploadId.success || !body.success) {
        sendDomainError(res, req.id, 'validation_error', 400);
        return;
      }
      try {
        if (!(await writeAllowed(req, res, verified))) return;
        const lead = await trackedLead(req, res, verified);
        if (!lead) return;
        const ctx = websiteContext(req);
        // Only the order's own held upload: a customer grant never verifies,
        // and so never makes current, any other file of the lead.
        const held = await changeRequests.isHeldUpload({
          workspaceId: ctx.workspaceId,
          actorId: ctx.credentialId,
          leadId: lead.leadId,
          fileId: uploadId.data,
        });
        if (!held) {
          sendDomainError(res, req.id, 'upload_not_found', 404);
          return;
        }
        const finalized = await documents.service.finalize({
          workspaceId: ctx.workspaceId,
          actorId: ctx.credentialId,
          requestId: req.id,
          fileId: uploadId.data,
          checksumSha256: body.data.checksumSha256,
          ownedLeadId: lead.leadId,
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
        const outcome = await changeRequests.attachDocument({
          workspaceId: ctx.workspaceId,
          actorId: ctx.credentialId,
          requestId: req.id,
          leadId: lead.leadId,
          fileId: uploadId.data,
          now: new Date(),
        });
        if (outcome.status === 'not_found') {
          // The file is the lead's, but not a held upload for its change request.
          sendDomainError(res, req.id, 'upload_not_found', 404);
          return;
        }
        sendChange(req, res, outcome, 200);
      } catch (error) {
        failRequest(
          req,
          res,
          '/api/v1/website/tracking/orders/:reference/uploads/:uploadId/finalize',
          error,
        );
      }
    },
  );

  return router;
}
