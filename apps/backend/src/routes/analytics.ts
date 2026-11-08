import { Router } from 'express';
import { analyticsQuerySchema } from '@gt-sales/contracts';
import { z } from 'zod';

import { withoutMoney, type AnalyticsStore } from '../analytics/store.js';
import { sendStaffAuthError } from '../http/staff-errors.js';
import { decideAccess, denyReasonOf } from '../staff/authorization.js';
import type { PlanRouteDependencies } from './plans.js';

export interface AnalyticsRouteDependencies {
  store: AnalyticsStore;
  decide: PlanRouteDependencies['decide'];
  reportFailure: PlanRouteDependencies['reportFailure'];
}

/**
 * The analytics dashboard, `GET /workspaces/:workspaceId/analytics`. Counts
 * only for every role that reads the site; the money figures (commission
 * earned, expected and over time) go only to a caller with `revenue.view`,
 * and are left out of the response (the keys, not nulls) for anyone else.
 */
export function createAnalyticsRoutes(dependencies: AnalyticsRouteDependencies): Router {
  const router = Router();

  router.get('/workspaces/:workspaceId/analytics', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const query = analyticsQuerySchema.safeParse(req.query);
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
      const figures = await dependencies.store.analytics({
        workspaceId: workspaceId.data,
        actorId: actor.actorId,
        ...query.data,
      });
      const revenue = decideAccess(decision.access, 'revenue.view').allowed;
      res.json({ ...(revenue ? figures : withoutMoney(figures)), requestId: req.id });
    } catch (error) {
      dependencies.reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  return router;
}
