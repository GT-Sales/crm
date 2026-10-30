import { Router, type Request, type Response } from 'express';
import {
  createPlanRequestSchema,
  listPlansQuerySchema,
  updatePlanRequestSchema,
} from '@gt-sales/contracts';
import { z } from 'zod';

import type { VerifiedStaffSession } from '../auth/session.js';
import { sendDomainError } from '../http/domain-errors.js';
import { sendStaffAuthError } from '../http/staff-errors.js';
import type { PlanStore } from '../plans/store.js';
import type { PropertyContext } from '../properties/store.js';
import {
  denyReasonOf,
  type AuthorizationDecision,
  type StaffAction,
} from '../staff/authorization.js';

export interface PlanRouteDependencies {
  store: PlanStore;
  /** The staff router's live authorization decision for this actor and site. */
  decide: (
    req: Request,
    workspaceId: string,
    action: StaffAction,
  ) => Promise<{ actor: VerifiedStaffSession; decision: AuthorizationDecision }>;
  /** The staff router's last-resort failure report (log + error tracker). */
  reportFailure: (req: Request, error: unknown) => void;
}

/**
 * A site's plans, under `/workspaces/:workspaceId/plans`. Everyone who reads
 * the site reads them (a lead's plan choice needs them); `order.manage`
 * (orders and owner) adds and changes them. Plans are never deleted: one no
 * longer sold is made inactive.
 */
export function createPlanRoutes(dependencies: PlanRouteDependencies): Router {
  const router = Router();
  const { store } = dependencies;

  function failed(req: Request, res: Response, error: unknown): void {
    dependencies.reportFailure(req, error);
    sendStaffAuthError(res, req.id, 'internal_error', 500);
  }

  function workspaceIdOf(req: Request): string | undefined {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    return workspaceId.success ? workspaceId.data : undefined;
  }

  /** The store context of a caller allowed `action` on the site, or the 403 already sent. */
  async function allowedContext(
    req: Request,
    res: Response,
    workspaceId: string,
    action: StaffAction,
  ): Promise<PropertyContext | undefined> {
    const { actor, decision } = await dependencies.decide(req, workspaceId, action);
    if (!decision.allowed) {
      sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
      return undefined;
    }
    return { workspaceId, actorId: actor.actorId, requestId: req.id };
  }

  router.get('/workspaces/:workspaceId/plans', async (req, res) => {
    const workspaceId = workspaceIdOf(req);
    const query = listPlansQuerySchema.safeParse(req.query);
    if (!workspaceId || !query.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const ctx = await allowedContext(req, res, workspaceId, 'workspace.read');
      if (!ctx) return;
      const plans = await store.list(ctx, {
        ...(query.data.leadType !== undefined ? { leadType: query.data.leadType } : {}),
        includeInactive: query.data.includeInactive === 'true',
      });
      res.json({ plans, requestId: req.id });
    } catch (error) {
      failed(req, res, error);
    }
  });

  router.post('/workspaces/:workspaceId/plans', async (req, res) => {
    const workspaceId = workspaceIdOf(req);
    const body = createPlanRequestSchema.safeParse(req.body);
    if (!workspaceId || !body.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const ctx = await allowedContext(req, res, workspaceId, 'order.manage');
      if (!ctx) return;
      const outcome = await store.create(ctx, body.data);
      switch (outcome.kind) {
        case 'created':
          res.status(201).json({ plan: outcome.plan, requestId: req.id });
          return;
        case 'name_taken':
          sendDomainError(res, req.id, 'plan_name_taken', 409);
          return;
        case 'limit_reached':
          sendDomainError(res, req.id, 'plan_limit', 409);
          return;
        case 'invalid_custom_value':
          sendDomainError(res, req.id, 'invalid_request', 400, { field: outcome.field });
          return;
      }
    } catch (error) {
      failed(req, res, error);
    }
  });

  router.patch('/workspaces/:workspaceId/plans/:planId', async (req, res) => {
    const workspaceId = workspaceIdOf(req);
    const planId = z.uuid().safeParse(req.params['planId']);
    const body = updatePlanRequestSchema.safeParse(req.body);
    if (!workspaceId || !planId.success || !body.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const ctx = await allowedContext(req, res, workspaceId, 'order.manage');
      if (!ctx) return;
      const outcome = await store.update(ctx, planId.data, body.data);
      switch (outcome.kind) {
        case 'updated':
          res.json({ plan: outcome.plan, requestId: req.id });
          return;
        case 'not_found':
          sendDomainError(res, req.id, 'plan_not_found', 404);
          return;
        case 'version_conflict':
          sendDomainError(res, req.id, 'version_conflict', 409);
          return;
        case 'name_taken':
          sendDomainError(res, req.id, 'plan_name_taken', 409);
          return;
        case 'invalid_custom_value':
          sendDomainError(res, req.id, 'invalid_request', 400, { field: outcome.field });
          return;
      }
    } catch (error) {
      failed(req, res, error);
    }
  });

  return router;
}
