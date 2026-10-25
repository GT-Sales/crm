import { websiteBotActions, type WebsiteBotAction } from '@gt-sales/contracts';
import { Router, type Request, type Response } from 'express';
import { rateLimitHit, resolveWebsiteCredential } from '@gt-sales/db';
import {
  createLeadRequestSchema,
  createUploadIntentRequestSchema,
  finalizeUploadRequestSchema,
  updateLeadRequestSchema,
} from '@gt-sales/contracts';
import { z } from 'zod';

import { DatabaseDraftGrantVerifier, type DraftGrantVerifier } from '../documents/grant.js';
import { createDocumentServiceFromEnv } from '../documents/factory.js';
import { toFileSummary } from '../documents/summary.js';
import type { DocumentService } from '../documents/service.js';

import { sendDomainError } from '../http/domain-errors.js';
import { isConnectionLevelError, logRequestError } from '../http/logger.js';
import { DatabaseLeadStore, type LeadStore } from '../leads/store.js';
import { parseDraftGrantToken } from '../leads/token.js';
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
    service: Pick<DocumentService, 'createIntent' | 'finalize' | 'issueDownload'>;
    grants: DraftGrantVerifier;
  };
}

export function createDefaultWebsiteRouteDependencies(): WebsiteRouteDependencies {
  const turnstileSecret = process.env.TURNSTILE_SECRET_KEY;
  const turnstileHosts = (process.env.TURNSTILE_HOSTNAMES ?? process.env.TURNSTILE_HOSTNAME ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
  // Every protected write fails closed without these, so say so once at boot
  // instead of leaving the owner to discover it from website 403s.
  if (!turnstileSecret || turnstileHosts.length === 0) {
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
      botCheck: (req, action) => verifiers.get(action)?.(req.get('x-turnstile-token')) ?? false,
    },
    leads: { store: new DatabaseLeadStore() },
    ...documentsDependencies(),
  };
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
function failRequest(req: Request, res: Response, route: string, error: unknown): void {
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

      try {
        const ctx = websiteContext(req);
        const result = await dependencies.leads.store.createLead({
          workspaceId: ctx.workspaceId,
          actorId: ctx.credentialId,
          requestId: req.id,
          contact: body.data.contact,
          form: body.data.form,
          productId: body.data.productId,
          attribution: body.data.attribution,
          consentVersion: body.data.consentVersion,
        });
        res.status(201).json({
          lead: result.lead,
          draftGrant: result.grant,
          requestId: req.id,
        });
      } catch (error) {
        failRequest(req, res, '/api/v1/website/leads', error);
      }
    },
  );

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
          productId: body.data.productId,
          attribution: body.data.attribution,
          consentVersion: body.data.consentVersion,
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

        res.json({ lead: outcome.lead, requestId: req.id });
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

  return router;
}
