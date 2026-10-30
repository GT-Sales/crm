import { Router, type Request, type Response } from 'express';
import {
  buildPropertyCatalog,
  createCustomPropertySchema,
  defaultPropertyLayout,
  leadTypeCatalog,
  leadTypeEntry,
  propertyKeySchema,
  propertyObjectQuerySchema,
  savePropertyLayoutRequestSchema,
  updatePropertySchema,
  type PropertyCatalog,
  type PropertyLayout,
  type PropertyLayoutRow,
  type PropertyObject,
  type PropertyRow,
  type PropertyUsage,
  type SiteProperty,
} from '@gt-sales/contracts';
import { z } from 'zod';

import type { VerifiedStaffSession } from '../auth/session.js';
import { sendDomainError } from '../http/domain-errors.js';
import { sendStaffAuthError } from '../http/staff-errors.js';
import type { PropertyContext, PropertyStore } from '../properties/store.js';
import {
  decideAccess,
  denyReasonOf,
  type AuthorizationDecision,
  type StaffAccessSnapshot,
  type StaffAction,
} from '../staff/authorization.js';

export interface PropertyRouteDependencies {
  store: PropertyStore;
  /** The staff router's live authorization decision for this actor and site. */
  decide: (
    req: Request,
    workspaceId: string,
    action: StaffAction,
  ) => Promise<{ actor: VerifiedStaffSession; decision: AuthorizationDecision }>;
  /** The staff router's last-resort failure report (log + error tracker). */
  reportFailure: (req: Request, error: unknown) => void;
}

/** The one layout key of an object without lead types (plans). */
const PLAN_LAYOUT_TYPE = '';

/**
 * Only a plan property is shown on the website; turning it on for a lead
 * property is refused (off, the create default, passes).
 */
function refusesWebsiteVisible(
  object: PropertyObject,
  body: { websiteVisible?: boolean },
): boolean {
  return object !== 'plan' && body.websiteVisible === true;
}

/** The `details` of an in-use refusal: the record count and its split (`propertyUsageSchema`). */
function usageDetails(usage: PropertyUsage): PropertyUsage {
  return {
    leadCount: usage.leadCount,
    active: usage.active,
    trashed: usage.trashed,
    restricted: usage.restricted,
    ...(usage.planCount !== undefined ? { planCount: usage.planCount } : {}),
  };
}

/**
 * The wire form of a row the store just wrote: the row resolved as the
 * catalogue resolves it (the order's `plan` property without its options;
 * the admin reloads the model after a change).
 */
function siteProperty(row: PropertyRow): SiteProperty {
  const property = buildPropertyCatalog([row], row.object).get(row.key);
  if (!property) throw new Error('a stored property row did not resolve to a property');
  return property;
}

/**
 * A stored layout with every key the catalogue no longer knows (a deleted
 * custom property) taken out, version unchanged, so the admin can re-save it
 * without an `unknown_property_key`. Hidden keys stay: hiding is reversible.
 */
function withKnownKeys(row: PropertyLayoutRow, catalog: PropertyCatalog): PropertyLayoutRow {
  return {
    ...row,
    layout: {
      sections: row.layout.sections.map((section) => ({
        ...section,
        keys: section.keys.filter((key) => catalog.get(key) !== undefined),
      })),
    },
  };
}

/** The plan record before a site saves its own: every visible plan property in one section. */
function defaultPlanLayout(catalog: PropertyCatalog): PropertyLayout {
  const keys = catalog.all.filter((property) => !property.hidden).map((property) => property.key);
  return { sections: [{ id: 'custom', label: 'Custom', keys }] };
}

/**
 * Every layout of the object: for leads one per lead type, for plans the one
 * keyed `''`; the site's saved one, else the default at version 0.
 */
function layoutsByType(
  object: PropertyObject,
  saved: readonly PropertyLayoutRow[],
  catalog: PropertyCatalog,
): Record<string, PropertyLayoutRow> {
  const layouts: Record<string, PropertyLayoutRow> = {};
  const leadTypes = object === 'plan' ? [PLAN_LAYOUT_TYPE] : Object.keys(leadTypeCatalog);
  for (const row of saved) {
    if (leadTypes.includes(row.leadType)) layouts[row.leadType] = withKnownKeys(row, catalog);
  }
  for (const leadType of leadTypes) {
    if (Object.hasOwn(layouts, leadType)) continue;
    layouts[leadType] = {
      object,
      leadType,
      layout:
        object === 'plan' ? defaultPlanLayout(catalog) : defaultPropertyLayout(leadType, catalog),
      version: 0,
      updatedAt: null,
    };
  }
  return layouts;
}

/**
 * A site's property definitions and record layouts, under
 * `/workspaces/:workspaceId/properties`, for leads or (`?object=plan`) for
 * plans. Everyone who reads the site reads the model (the record page and the
 * list need it); only `property.manage` changes it.
 */
export function createPropertyRoutes(dependencies: PropertyRouteDependencies): Router {
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

  function objectOf(req: Request): PropertyObject | undefined {
    const query = propertyObjectQuerySchema.safeParse({ object: req.query['object'] });
    return query.success ? query.data.object : undefined;
  }

  function keyParams(
    req: Request,
  ): { workspaceId: string; key: string; object: PropertyObject } | undefined {
    const workspaceId = workspaceIdOf(req);
    const key = propertyKeySchema.safeParse(req.params['key']);
    const object = objectOf(req);
    return workspaceId && key.success && object
      ? { workspaceId, key: key.data, object }
      : undefined;
  }

  /** The store context of a caller allowed `action` on the site, or the 403 already sent. */
  async function allowedContext(
    req: Request,
    res: Response,
    workspaceId: string,
    action: StaffAction,
  ): Promise<{ ctx: PropertyContext; access: StaffAccessSnapshot } | undefined> {
    const { actor, decision } = await dependencies.decide(req, workspaceId, action);
    if (!decision.allowed) {
      sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
      return undefined;
    }
    return {
      ctx: { workspaceId, actorId: actor.actorId, requestId: req.id },
      access: decision.access,
    };
  }

  router.get('/workspaces/:workspaceId/properties', async (req, res) => {
    const workspaceId = workspaceIdOf(req);
    const object = objectOf(req);
    if (!workspaceId || !object) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const allowed = await allowedContext(req, res, workspaceId, 'workspace.read');
      if (!allowed) return;
      const model = await store.model(allowed.ctx, object);
      // The catalogue from the same rows, so properties and layouts agree.
      const catalog = buildPropertyCatalog(
        model.rows,
        object,
        model.plans ? { plans: model.plans } : {},
      );
      res.json({
        properties: catalog.all,
        layouts: layoutsByType(object, model.layouts, catalog),
        // Decided on the snapshot this request already loaded: no second membership read.
        capabilities: { canManage: decideAccess(allowed.access, 'property.manage').allowed },
        requestId: req.id,
      });
    } catch (error) {
      failed(req, res, error);
    }
  });

  router.post('/workspaces/:workspaceId/properties', async (req, res) => {
    const workspaceId = workspaceIdOf(req);
    const object = objectOf(req);
    const body = createCustomPropertySchema.safeParse(req.body);
    if (!workspaceId || !object || !body.success || refusesWebsiteVisible(object, body.data)) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const allowed = await allowedContext(req, res, workspaceId, 'property.manage');
      if (!allowed) return;
      const outcome = await store.create(allowed.ctx, object, body.data);
      switch (outcome.kind) {
        case 'created':
          res.status(201).json({ property: siteProperty(outcome.property), requestId: req.id });
          return;
        case 'limit_reached':
          sendDomainError(res, req.id, 'property_limit', 409);
          return;
      }
    } catch (error) {
      failed(req, res, error);
    }
  });

  /**
   * The layout key of the request: a known lead type for leads; for plans no
   * type at all (`/layouts` or `/layouts/`), stored as `''`.
   */
  function layoutTypeOf(object: PropertyObject, leadType: unknown): string | undefined {
    if (object === 'plan') return leadType === undefined ? PLAN_LAYOUT_TYPE : undefined;
    return typeof leadType === 'string' && leadTypeEntry(leadType) !== undefined
      ? leadType
      : undefined;
  }

  // Registered before `/properties/:key`, so `/properties/layouts` (the plan
  // layout) never reaches the property routes.
  router.patch('/workspaces/:workspaceId/properties/layouts{/:leadType}', async (req, res) => {
    const workspaceId = workspaceIdOf(req);
    const object = objectOf(req);
    const leadType = object ? layoutTypeOf(object, req.params['leadType']) : undefined;
    const body = savePropertyLayoutRequestSchema.safeParse(req.body);
    if (!workspaceId || !object || leadType === undefined || !body.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const allowed = await allowedContext(req, res, workspaceId, 'property.manage');
      if (!allowed) return;
      const outcome = await store.saveLayout(
        allowed.ctx,
        object,
        leadType,
        body.data.layout,
        body.data.expectedVersion,
      );
      switch (outcome.kind) {
        case 'saved':
          res.json({ layout: outcome.layout, requestId: req.id });
          return;
        case 'version_conflict':
          sendDomainError(res, req.id, 'version_conflict', 409);
          return;
        case 'unknown_key':
          sendDomainError(res, req.id, 'unknown_property_key', 400, { key: outcome.key });
          return;
      }
    } catch (error) {
      failed(req, res, error);
    }
  });

  router.patch('/workspaces/:workspaceId/properties/:key', async (req, res) => {
    const params = keyParams(req);
    const body = updatePropertySchema.safeParse(req.body);
    if (!params || !body.success || refusesWebsiteVisible(params.object, body.data)) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const allowed = await allowedContext(req, res, params.workspaceId, 'property.manage');
      if (!allowed) return;
      const outcome = await store.update(allowed.ctx, params.object, params.key, body.data);
      switch (outcome.kind) {
        case 'updated':
          res.json({ property: siteProperty(outcome.property), requestId: req.id });
          return;
        case 'not_found':
          sendDomainError(res, req.id, 'property_not_found', 404);
          return;
        case 'version_conflict':
          sendDomainError(res, req.id, 'version_conflict', 409);
          return;
        case 'builtin_locked':
          sendDomainError(res, req.id, 'builtin_property_locked', 400);
          return;
        case 'invalid_options':
          sendStaffAuthError(res, req.id, 'invalid_request', 400);
          return;
        case 'option_in_use':
          sendDomainError(res, req.id, 'property_option_in_use', 409, {
            optionValue: outcome.optionValue,
            ...usageDetails(outcome),
          });
          return;
      }
    } catch (error) {
      failed(req, res, error);
    }
  });

  router.delete('/workspaces/:workspaceId/properties/:key', async (req, res) => {
    const params = keyParams(req);
    if (!params) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const allowed = await allowedContext(req, res, params.workspaceId, 'property.manage');
      if (!allowed) return;
      const outcome = await store.remove(allowed.ctx, params.object, params.key);
      switch (outcome.kind) {
        case 'deleted':
          res.json({ key: params.key, requestId: req.id });
          return;
        case 'not_found':
          sendDomainError(res, req.id, 'property_not_found', 404);
          return;
        case 'builtin':
          sendDomainError(res, req.id, 'builtin_property_locked', 400);
          return;
        case 'in_use':
          sendDomainError(res, req.id, 'property_in_use', 409, usageDetails(outcome));
          return;
      }
    } catch (error) {
      failed(req, res, error);
    }
  });

  return router;
}
