import { Router, type Request, type Response } from 'express';
import {
  cleanSavedViewState,
  createSavedViewRequestSchema,
  listSavedViewsQuerySchema,
  updateSavedViewRequestSchema,
  type PropertyCatalog,
  type SavedView,
} from '@gt-sales/contracts';
import type { TenantContext } from '@gt-sales/db';
import { z } from 'zod';

import type { VerifiedStaffSession } from '../auth/session.js';
import { sendDomainError } from '../http/domain-errors.js';
import { sendStaffAuthError } from '../http/staff-errors.js';
import {
  denyReasonOf,
  type AuthorizationDecision,
  type StaffAccessSnapshot,
  type StaffAction,
} from '../staff/authorization.js';
import type { SavedViewStore } from '../views/store.js';

export interface SavedViewRouteDependencies {
  store: SavedViewStore;
  /** The site's property catalogue, which every returned view's state is cleaned against. */
  loadCatalog: (ctx: TenantContext) => Promise<PropertyCatalog>;
  /** The staff router's live authorization decision for this actor and site. */
  decide: (
    req: Request,
    workspaceId: string,
    action: StaffAction,
  ) => Promise<{ actor: VerifiedStaffSession; decision: AuthorizationDecision }>;
  /** Whether the access lets its holder see contact and form details. */
  canSeeContacts: (access: StaffAccessSnapshot) => boolean;
  /** The staff router's last-resort failure report (log + error tracker). */
  reportFailure: (req: Request, error: unknown) => void;
}

/**
 * A staff member's private saved views of the leads list, under
 * `/workspaces/:workspaceId/views`. A view holds filters, sort and property
 * columns, so only roles that may see contact and form details use them.
 * A create or update stores the state cleaned against the site's current
 * catalogue, so no filter, column or sort on a sensitive, hidden or unknown
 * key is ever written; every view returned is cleaned again, so a property
 * hidden since the view was saved drops out of what is applied.
 */
export function createSavedViewRoutes(dependencies: SavedViewRouteDependencies): Router {
  const router = Router();

  /** The tenant context of a caller allowed to use saved views, or the 403 already sent. */
  async function allowedContext(
    req: Request,
    res: Response,
    workspaceId: string,
  ): Promise<TenantContext | undefined> {
    const { actor, decision } = await dependencies.decide(req, workspaceId, 'workspace.read');
    if (!decision.allowed) {
      sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
      return undefined;
    }
    if (!dependencies.canSeeContacts(decision.access)) {
      sendStaffAuthError(res, req.id, 'permission_denied', 403);
      return undefined;
    }
    return { workspaceId, actorId: actor.actorId };
  }

  function cleaned(catalog: PropertyCatalog, view: SavedView): SavedView {
    return { ...view, state: cleanSavedViewState(view.state, catalog) };
  }

  function failed(req: Request, res: Response, error: unknown): void {
    dependencies.reportFailure(req, error);
    sendStaffAuthError(res, req.id, 'internal_error', 500);
  }

  function workspaceIdOf(req: Request): string | undefined {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    return workspaceId.success ? workspaceId.data : undefined;
  }

  function viewParams(req: Request): { workspaceId: string; viewId: string } | undefined {
    const workspaceId = workspaceIdOf(req);
    const viewId = z.uuid().safeParse(req.params['viewId']);
    return workspaceId && viewId.success ? { workspaceId, viewId: viewId.data } : undefined;
  }

  router.get('/workspaces/:workspaceId/views', async (req, res) => {
    const workspaceId = workspaceIdOf(req);
    const query = listSavedViewsQuerySchema.safeParse(req.query);
    if (!workspaceId || !query.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const ctx = await allowedContext(req, res, workspaceId);
      if (!ctx) return;
      const views = await dependencies.store.list(ctx, query.data.object);
      const catalog = await dependencies.loadCatalog(ctx);
      res.json({ views: views.map((view) => cleaned(catalog, view)), requestId: req.id });
    } catch (error) {
      failed(req, res, error);
    }
  });

  router.post('/workspaces/:workspaceId/views', async (req, res) => {
    const workspaceId = workspaceIdOf(req);
    const body = createSavedViewRequestSchema.safeParse(req.body);
    if (!workspaceId || !body.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const ctx = await allowedContext(req, res, workspaceId);
      if (!ctx) return;
      const catalog = await dependencies.loadCatalog(ctx);
      const outcome = await dependencies.store.create(ctx, {
        ...body.data,
        state: cleanSavedViewState(body.data.state, catalog),
      });
      switch (outcome.kind) {
        case 'created':
          res.status(201).json({ view: cleaned(catalog, outcome.view), requestId: req.id });
          return;
        case 'name_taken':
          sendDomainError(res, req.id, 'saved_view_name_taken', 409);
          return;
        case 'limit_reached':
          sendDomainError(res, req.id, 'saved_view_limit', 409);
          return;
      }
    } catch (error) {
      failed(req, res, error);
    }
  });

  router.patch('/workspaces/:workspaceId/views/:viewId', async (req, res) => {
    const params = viewParams(req);
    const body = updateSavedViewRequestSchema.safeParse(req.body);
    if (!params || !body.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const ctx = await allowedContext(req, res, params.workspaceId);
      if (!ctx) return;
      const catalog = await dependencies.loadCatalog(ctx);
      const { state, ...change } = body.data;
      const outcome = await dependencies.store.update(ctx, params.viewId, {
        ...change,
        ...(state === undefined ? {} : { state: cleanSavedViewState(state, catalog) }),
      });
      switch (outcome.kind) {
        case 'updated':
          res.json({ view: cleaned(catalog, outcome.view), requestId: req.id });
          return;
        case 'not_found':
          sendDomainError(res, req.id, 'saved_view_not_found', 404);
          return;
        case 'name_taken':
          sendDomainError(res, req.id, 'saved_view_name_taken', 409);
          return;
        case 'version_conflict':
          sendDomainError(res, req.id, 'version_conflict', 409);
          return;
      }
    } catch (error) {
      failed(req, res, error);
    }
  });

  router.delete('/workspaces/:workspaceId/views/:viewId', async (req, res) => {
    const params = viewParams(req);
    if (!params) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const ctx = await allowedContext(req, res, params.workspaceId);
      if (!ctx) return;
      const outcome = await dependencies.store.delete(ctx, params.viewId);
      if (outcome.kind === 'not_found') {
        sendDomainError(res, req.id, 'saved_view_not_found', 404);
        return;
      }
      res.json({ viewId: params.viewId, requestId: req.id });
    } catch (error) {
      failed(req, res, error);
    }
  });

  return router;
}
