import { Router } from 'express';
import { sourceReportQuerySchema } from '@gt-sales/contracts';
import { z } from 'zod';

import { sendStaffAuthError } from '../http/staff-errors.js';
import type { ReportStore } from '../reports/store.js';
import { denyReasonOf } from '../staff/authorization.js';
import type { PlanRouteDependencies } from './plans.js';

export interface ReportRouteDependencies {
  store: ReportStore;
  decide: PlanRouteDependencies['decide'];
  reportFailure: PlanRouteDependencies['reportFailure'];
}

/**
 * A site's reports, under `/workspaces/:workspaceId/reports`. Counts only (no
 * lead, no contact), so every role that reads the site may see them, as the
 * dashboard's stats.
 */
export function createReportRoutes(dependencies: ReportRouteDependencies): Router {
  const router = Router();

  router.get('/workspaces/:workspaceId/reports/sources', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const query = sourceReportQuerySchema.safeParse(req.query);
    if (!workspaceId.success || !query.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const { actor, decision } = await dependencies.decide(
        req,
        workspaceId.data,
        'workspace.read',
      );
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }
      const report = await dependencies.store.sourceReport({
        workspaceId: workspaceId.data,
        actorId: actor.actorId,
        leadType: query.data.leadType,
        days: query.data.days,
      });
      res.json({
        leadType: query.data.leadType,
        days: query.data.days ?? null,
        ...report,
        requestId: req.id,
      });
    } catch (error) {
      dependencies.reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  return router;
}
