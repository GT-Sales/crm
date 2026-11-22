import { Router } from 'express';
import { createDownloadLinkRequestSchema, reviewFileRequestSchema } from '@gt-sales/contracts';
import { z } from 'zod';
import { toStaffFile } from '../documents/summary.js';
import { sendStaffAuthError } from '../http/staff-errors.js';
import { sendDomainError } from '../http/domain-errors.js';
import { denyReasonOf } from '../staff/authorization.js';
import { type StaffRouteContext } from './staff-context.js';

/** A lead's documents under `/workspaces/:workspaceId/files`: staff review and download links. */
export function createStaffFileRoutes(context: StaffRouteContext): Router {
  const { dependencies, decide, reportFailure } = context;
  const router = Router();

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
    // A body is optional: without one the link downloads, as it always did.
    const body = createDownloadLinkRequestSchema.safeParse(req.body ?? {});
    if (!workspaceId.success || !fileId.success || !body.success) {
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
        disposition: body.data.disposition ?? 'attachment',
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
