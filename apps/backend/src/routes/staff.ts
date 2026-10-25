import { createErrorTrackerFromEnv, type ErrorTracker } from '@gt-sales/adapters';
import { Router, type Request } from 'express';
import {
  createServiceCredentialRequestSchema,
  inviteStaffRequestSchema,
  listWorkspaceLeadsQuerySchema,
  resolveUncertainJobRequestSchema,
  reviewFileRequestSchema,
} from '@gt-sales/contracts';
import { rateLimitHit } from '@gt-sales/db';
import { z } from 'zod';

import { createDocumentServiceFromEnv } from '../documents/factory.js';
import type { DocumentService } from '../documents/service.js';
import { toStaffFile } from '../documents/summary.js';

import {
  requireStaffSession,
  SupabaseStaffSessionVerifier,
  type StaffRateLimit,
  type StaffSessionVerifier,
  type VerifiedStaffSession,
} from '../auth/session.js';
import { isConnectionLevelError, logRequestError } from '../http/logger.js';
import { sendStaffAuthError } from '../http/staff-errors.js';
import { sendDomainError } from '../http/domain-errors.js';
import { sendWebsiteError } from '../http/website-errors.js';
import { DatabaseLeadStore, type LeadStore } from '../leads/store.js';
import { DatabaseOutboxStore, type JobAdminStore } from '../jobs/store.js';
import { createAuthorize, denyReasonOf, type StaffAction } from '../staff/authorization.js';
import { DatabaseStaffStore, type StaffStore } from '../staff/store.js';
import { generateServiceSecret } from '../website/credential.js';
import {
  DatabaseWebsiteCredentialStore,
  type ServiceCredentialRecord,
  type WebsiteCredentialStore,
} from '../website/store.js';

export interface StaffRouteDependencies {
  sessionVerifier: StaffSessionVerifier;
  /** Per-IP limit applied before any session check; omitted in route tests. */
  rateLimit?: StaffRateLimit;
  store: StaffStore;
  credentialStore: WebsiteCredentialStore;
  leadStore: LeadStore;
  jobStore?: JobAdminStore;
  documentService?: Pick<DocumentService, 'review' | 'issueDownload'>;
  /** Receives every unexpected handler failure; optional so tests can omit it. */
  errorTracker?: ErrorTracker;
}

export function createDefaultStaffRouteDependencies(): StaffRouteDependencies {
  return {
    sessionVerifier: new SupabaseStaffSessionVerifier(),
    rateLimit: rateLimitHit,
    store: new DatabaseStaffStore(),
    credentialStore: new DatabaseWebsiteCredentialStore(),
    leadStore: new DatabaseLeadStore(),
    jobStore: new DatabaseOutboxStore(),
    documentService: createDocumentServiceFromEnv(),
    errorTracker: createErrorTrackerFromEnv(),
  };
}

function credentialSummary(record: ServiceCredentialRecord) {
  return {
    id: record.id,
    scopes: record.scopes,
    createdAt: record.createdAt,
    revokedAt: record.revokedAt,
  };
}

function session(req: Request) {
  const value = req.staffSession;
  if (!value) throw new Error('staff session middleware did not run');
  return value;
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ('code' in error && error.code === '23505') return true;
  if (!('cause' in error) || typeof error.cause !== 'object' || error.cause === null) return false;
  return 'code' in error.cause && error.cause.code === '23505';
}

export function createStaffRouter(dependencies: StaffRouteDependencies): Router {
  const router = Router();
  router.use(requireStaffSession(dependencies.sessionVerifier, dependencies.rateLimit));

  function authorizeWith(actor: VerifiedStaffSession) {
    return createAuthorize({
      accessStore: dependencies.store,
      assuranceLevel: actor.assuranceLevel,
    });
  }

  /**
   * Every handler's last-resort failure path: a scrubbed log record plus the
   * error tracker, so a staff-side 500 is never silent. Neither the body, the
   * headers nor the error message reach the log.
   */
  function reportFailure(req: Request, error: unknown): void {
    const workspaceId =
      typeof req.params['workspaceId'] === 'string' ? req.params['workspaceId'] : undefined;
    const routePath: unknown = req.route?.path;
    const route = `${req.baseUrl}${typeof routePath === 'string' ? routePath : req.path}`;
    const connection = isConnectionLevelError(error);
    logRequestError({
      requestId: req.id,
      workspaceId,
      route,
      code: connection ? 'persistence_unavailable' : 'internal_error',
      flag: connection ? 'retryable' : 'not_retryable',
    });
    dependencies.errorTracker?.captureException(error, {
      requestId: req.id,
      workspaceId,
      actorId: req.staffSession?.actorId,
      route,
      release: process.env['RELEASE_SHA'] ?? 'unknown',
      environment: process.env['DEPLOYMENT_ENV'] ?? process.env['NODE_ENV'],
    });
  }

  /** One live authorization decision for this actor and workspace. */
  async function decide(req: Request, workspaceId: string, action: StaffAction) {
    const actor = session(req);
    const authorize = authorizeWith(actor);
    const decision = await authorize({ actorId: actor.actorId, workspaceId, action });
    return { actor, decision };
  }

  /**
   * Whether this actor may see a lead's name, email and phone. Only roles that
   * work leads or money see contact details; read-only roles get leads without
   * them. Decided from the same live permission read the mutations use.
   */
  async function canSeeContacts(req: Request, workspaceId: string): Promise<boolean> {
    const actor = session(req);
    const authorize = authorizeWith(actor);
    const [leadsAccess, orders, finance] = await Promise.all([
      authorize({ actorId: actor.actorId, workspaceId, action: 'lead.manage' }),
      authorize({ actorId: actor.actorId, workspaceId, action: 'order.manage' }),
      authorize({ actorId: actor.actorId, workspaceId, action: 'financial.read' }),
    ]);
    return leadsAccess.allowed || orders.allowed || finance.allowed;
  }

  router.get('/workspaces', async (req, res) => {
    try {
      const actor = session(req);
      const workspaces = await dependencies.store.bootstrapStaff({
        actorId: actor.actorId,
        verifiedEmail: actor.verifiedEmail,
        requestId: req.id,
      });
      res.json({ workspaces, requestId: req.id });
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  router.get('/workspaces/:workspaceId/access', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    if (!workspaceId.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }

    try {
      const { actor, decision } = await decide(req, workspaceId.data, 'workspace.read');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }

      const workspaces = await dependencies.store.bootstrapStaff({
        actorId: actor.actorId,
        verifiedEmail: actor.verifiedEmail,
        requestId: req.id,
      });
      const workspace = workspaces.find((item) => item.id === workspaceId.data);
      if (!workspace) {
        sendStaffAuthError(res, req.id, 'workspace_not_found', 404);
        return;
      }
      res.json({
        workspace,
        permissions: decision.access.permissions
          .filter((permission) => permission.effect === 'allow')
          .map((permission) => permission.name),
        requestId: req.id,
      });
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  router.get('/workspaces/:workspaceId/leads', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const query = listWorkspaceLeadsQuerySchema.safeParse(req.query);
    if (!workspaceId.success || !query.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }

    try {
      const { actor, decision } = await decide(req, workspaceId.data, 'workspace.read');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }

      const result = await dependencies.leadStore.listLeads({
        workspaceId: workspaceId.data,
        actorId: actor.actorId,
        status: query.data.status,
        leadType: query.data.type,
        page: query.data.page,
        pageSize: query.data.pageSize,
      });
      const leads = (await canSeeContacts(req, workspaceId.data))
        ? result.leads
        : result.leads.map((lead) => ({ ...lead, contact: {} }));
      res.json({ leads, page: result.page, requestId: req.id });
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  /** Active staff members of this workspace, for the assignment controls. */
  router.get('/workspaces/:workspaceId/members', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    if (!workspaceId.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const { actor, decision } = await decide(req, workspaceId.data, 'workspace.read');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }
      const members = await dependencies.store.listAssignableMembers(
        workspaceId.data,
        actor.actorId,
      );
      res.json({ members, requestId: req.id });
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  router.get('/workspaces/:workspaceId/jobs', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    if (!workspaceId.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const actor = session(req);
      const authorize = authorizeWith(actor);
      const decision = await authorize({
        actorId: actor.actorId,
        workspaceId: workspaceId.data,
        action: 'workspace.read',
      });
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }
      if (!dependencies.jobStore) {
        sendStaffAuthError(res, req.id, 'internal_error', 500);
        return;
      }
      const { jobs, total } = await dependencies.jobStore.listActive(
        workspaceId.data,
        actor.actorId,
      );
      const retryDecision = await authorize({
        actorId: actor.actorId,
        workspaceId: workspaceId.data,
        action: 'integration.manage',
      });
      res.json({
        jobs: jobs.map((job) => ({
          ...job,
          availableAt: job.availableAt.toISOString(),
          leaseExpiresAt: job.leaseExpiresAt?.toISOString() ?? null,
          createdAt: job.createdAt.toISOString(),
          updatedAt: job.updatedAt.toISOString(),
        })),
        total,
        canRetry: retryDecision.allowed,
        requestId: req.id,
      });
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  router.post('/workspaces/:workspaceId/jobs/:jobId/retry', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const jobId = z.uuid().safeParse(req.params['jobId']);
    if (!workspaceId.success || !jobId.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const { actor, decision } = await decide(req, workspaceId.data, 'integration.manage');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }
      if (!dependencies.jobStore) {
        sendStaffAuthError(res, req.id, 'internal_error', 500);
        return;
      }
      const outcome = await dependencies.jobStore.retry({
        workspaceId: workspaceId.data,
        actorId: actor.actorId,
        jobId: jobId.data,
        requestId: req.id,
      });
      if (outcome === 'not_found') {
        sendDomainError(res, req.id, 'job_not_found', 404);
        return;
      }
      if (outcome === 'not_failed') {
        sendDomainError(res, req.id, 'job_not_retryable', 409);
        return;
      }
      res.json({ jobId: jobId.data, status: 'pending', requestId: req.id });
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  // Staff record whether an uncertain job reached the provider.
  router.post('/workspaces/:workspaceId/jobs/:jobId/resolve', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const jobId = z.uuid().safeParse(req.params['jobId']);
    const body = resolveUncertainJobRequestSchema.safeParse(req.body);
    if (!workspaceId.success || !jobId.success || !body.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const { actor, decision } = await decide(req, workspaceId.data, 'integration.manage');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }
      if (!dependencies.jobStore) {
        sendStaffAuthError(res, req.id, 'internal_error', 500);
        return;
      }
      const outcome = await dependencies.jobStore.resolveUncertain({
        workspaceId: workspaceId.data,
        actorId: actor.actorId,
        jobId: jobId.data,
        requestId: req.id,
        delivered: body.data.delivered,
      });
      if (outcome === 'not_found') {
        sendDomainError(res, req.id, 'job_not_found', 404);
        return;
      }
      if (outcome === 'not_uncertain') {
        sendDomainError(res, req.id, 'job_not_uncertain', 409);
        return;
      }
      res.json({ jobId: jobId.data, status: outcome, requestId: req.id });
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  router.post('/workspaces/:workspaceId/invitations', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const body = inviteStaffRequestSchema.safeParse(req.body);
    if (!workspaceId.success || !body.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }

    try {
      const { actor, decision } = await decide(req, workspaceId.data, 'staff.invite');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }

      const membershipId = await dependencies.store.inviteStaff({
        actorId: actor.actorId,
        workspaceId: workspaceId.data,
        normalizedEmail: body.data.email.trim().toLowerCase(),
        roleNames: body.data.roles,
        requestId: req.id,
      });
      res.status(201).json({ membershipId, status: 'pending', requestId: req.id });
    } catch (error) {
      if (!isUniqueViolation(error)) reportFailure(req, error);
      sendStaffAuthError(
        res,
        req.id,
        isUniqueViolation(error) ? 'membership_conflict' : 'internal_error',
        isUniqueViolation(error) ? 409 : 500,
      );
    }
  });

  router.delete('/workspaces/:workspaceId/memberships/:membershipId', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const membershipId = z.uuid().safeParse(req.params['membershipId']);
    if (!workspaceId.success || !membershipId.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }

    try {
      const { actor, decision } = await decide(req, workspaceId.data, 'staff.remove');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }

      const result = await dependencies.store.revokeStaff({
        actorId: actor.actorId,
        workspaceId: workspaceId.data,
        membershipId: membershipId.data,
        requestId: req.id,
      });
      if (result === 'not_found') {
        sendStaffAuthError(res, req.id, 'membership_not_found', 404);
        return;
      }
      if (result === 'self') {
        sendStaffAuthError(res, req.id, 'invalid_request', 400);
        return;
      }
      res.json({ membershipId: membershipId.data, status: 'revoked', requestId: req.id });
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  router.post('/workspaces/:workspaceId/service-credentials', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const body = createServiceCredentialRequestSchema.safeParse(req.body);
    if (!workspaceId.success || !body.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }

    try {
      const { actor, decision } = await decide(req, workspaceId.data, 'integration.manage');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }

      // The plaintext secret exists only in this response; only its hash persists.
      const { secret, secretHash } = generateServiceSecret();
      const record = await dependencies.credentialStore.createCredential({
        actorId: actor.actorId,
        workspaceId: workspaceId.data,
        scopes: body.data.scopes,
        secretHash,
        requestId: req.id,
      });
      res.status(201).json({ credential: credentialSummary(record), secret, requestId: req.id });
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  router.get('/workspaces/:workspaceId/service-credentials', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    if (!workspaceId.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }

    try {
      const { actor, decision } = await decide(req, workspaceId.data, 'integration.manage');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }

      const records = await dependencies.credentialStore.listCredentials({
        actorId: actor.actorId,
        workspaceId: workspaceId.data,
      });
      res.json({ credentials: records.map(credentialSummary), requestId: req.id });
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  router.delete('/workspaces/:workspaceId/service-credentials/:credentialId', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const credentialId = z.uuid().safeParse(req.params['credentialId']);
    if (!workspaceId.success || !credentialId.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }

    try {
      const { actor, decision } = await decide(req, workspaceId.data, 'integration.manage');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }

      const result = await dependencies.credentialStore.revokeCredential({
        actorId: actor.actorId,
        workspaceId: workspaceId.data,
        credentialId: credentialId.data,
        requestId: req.id,
      });
      if (result.status === 'not_found') {
        sendWebsiteError(res, req.id, 'credential_not_found', 404);
        return;
      }
      // Idempotent: revoking an already-revoked credential returns its first revocation time.
      res.json({ id: credentialId.data, revokedAt: result.revokedAt, requestId: req.id });
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  // ---- Documents -----------------------------------------------------------
  // Downloading an original requires the separately-grantable
  // `document.download` permission; approve/reject is a lead-management action.

  router.post('/workspaces/:workspaceId/files/:fileId/review', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const fileId = z.uuid().safeParse(req.params['fileId']);
    const body = reviewFileRequestSchema.safeParse(req.body);
    if (!workspaceId.success || !fileId.success || !body.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const { actor, decision } = await decide(req, workspaceId.data, 'order.manage');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }
      if (!dependencies.documentService) {
        sendDomainError(res, req.id, 'feature_not_ready', 409);
        return;
      }
      const outcome = await dependencies.documentService.review({
        workspaceId: workspaceId.data,
        actorId: actor.actorId,
        requestId: req.id,
        fileId: fileId.data,
        decision: body.data.decision,
        ...(body.data.note ? { note: body.data.note } : {}),
      });
      if (outcome.status === 'not_found') {
        sendDomainError(res, req.id, 'file_not_found', 404);
        return;
      }
      res.json({ file: toStaffFile(outcome.file), requestId: req.id });
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  router.post('/workspaces/:workspaceId/files/:fileId/download-link', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const fileId = z.uuid().safeParse(req.params['fileId']);
    if (!workspaceId.success || !fileId.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      // Download of an original is gated on the explicit document.download
      // permission — not merely workspace membership.
      const { actor, decision } = await decide(req, workspaceId.data, 'document.download');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }
      if (!dependencies.documentService) {
        sendDomainError(res, req.id, 'feature_not_ready', 409);
        return;
      }
      const outcome = await dependencies.documentService.issueDownload({
        workspaceId: workspaceId.data,
        actorId: actor.actorId,
        fileId: fileId.data,
        requestId: req.id,
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
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  return router;
}
