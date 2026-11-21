import { Router } from 'express';
import {
  createServiceCredentialRequestSchema,
  inviteStaffRequestSchema,
  resolveUncertainJobRequestSchema,
  MAILBOX_PAGE_SIZE,
  mailboxQuerySchema,
  webAnalyticsQuerySchema,
} from '@gt-sales/contracts';
import { z } from 'zod';
import { sendStaffAuthError } from '../http/staff-errors.js';
import { sendDomainError } from '../http/domain-errors.js';
import { sendWebsiteError } from '../http/website-errors.js';
import { denyReasonOf } from '../staff/authorization.js';
import { generateServiceSecret } from '../website/credential.js';
import {
  CredentialLeadTypesUnavailableError,
  type ServiceCredentialRecord,
} from '../website/store.js';
import { DatabaseMailbox } from '../email/mailbox.js';
import { session, leadAccessOf, type StaffRouteContext } from './staff-context.js';

function credentialSummary(record: ServiceCredentialRecord) {
  return {
    id: record.id,
    scopes: record.scopes,
    leadTypes: record.leadTypes,
    createdAt: record.createdAt,
    revokedAt: record.revokedAt,
  };
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ('code' in error && error.code === '23505') return true;
  if (!('cause' in error) || typeof error.cause !== 'object' || error.cause === null) return false;
  return 'code' in error.cause && error.cause.code === '23505';
}

/**
 * A site's own administration and site-wide reads under
 * `/workspaces/:workspaceId`: assignable members, background jobs,
 * invitations and memberships, website keys, website traffic and the sent box.
 */
export function createStaffSiteRoutes(context: StaffRouteContext): Router {
  const { dependencies, authorize, decide, reportFailure, replyAddressing, defaultWebAnalytics } =
    context;
  const router = Router();

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
      if (result === 'self' || result === 'last_owner') {
        sendStaffAuthError(res, req.id, 'invalid_request', 400);
        return;
      }
      if (result === 'forbidden') {
        // Removed from the site, or no longer an owner, since the check above.
        sendStaffAuthError(res, req.id, 'permission_denied', 403);
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
        leadTypes: body.data.leadTypes,
        secretHash,
        requestId: req.id,
      });
      res.status(201).json({ credential: credentialSummary(record), secret, requestId: req.id });
    } catch (error) {
      if (error instanceof CredentialLeadTypesUnavailableError) {
        // Migration 0043 is not applied yet: a clean refusal, never a 500.
        sendDomainError(res, req.id, 'credential_lead_types_unavailable', 503);
        return;
      }
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

  // The site's website traffic (Analytics page), read from Umami. Totals only,
  // no customer details, so any member of the site may read it.
  router.get('/workspaces/:workspaceId/web-analytics', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const query = webAnalyticsQuerySchema.safeParse(req.query);
    if (!workspaceId.success || !query.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const { decision } = await decide(req, workspaceId.data, 'workspace.read');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }
      const reader = dependencies.webAnalytics ?? defaultWebAnalytics;
      const outcome = await reader.read({
        workspaceId: workspaceId.data,
        days: query.data.days ?? 30,
      });
      res.json(
        outcome.status === 'ok'
          ? { report: outcome.report, requestId: req.id }
          : { report: null, unavailable: outcome.status, requestId: req.id },
      );
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  // The site's sent box (Mail page): every mail queued to a customer. It names
  // customers and carries what was written, so it needs contact access.
  router.get('/workspaces/:workspaceId/mail', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const query = mailboxQuerySchema.safeParse(req.query);
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
      if (!leadAccessOf(decision.access).contacts) {
        sendStaffAuthError(res, req.id, 'permission_denied', 403);
        return;
      }
      const page = query.data.page ?? 1;
      const mailbox = dependencies.mailbox ?? new DatabaseMailbox();
      const result = await mailbox.list(
        { workspaceId: workspaceId.data, actorId: actor.actorId },
        { page, ...(query.data.leadId ? { leadId: query.data.leadId } : {}) },
      );
      res.json({
        items: result.items,
        page: { page, pageSize: MAILBOX_PAGE_SIZE, total: result.total },
        repliesEnabled: replyAddressing?.enabledFor(workspaceId.data) ?? false,
        requestId: req.id,
      });
    } catch (error) {
      reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  return router;
}
