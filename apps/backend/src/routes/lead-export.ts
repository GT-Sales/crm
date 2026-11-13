import { Router } from 'express';
import {
  LEAD_EXPORT_CONTENT_TYPE,
  LEAD_EXPORT_RATE_LIMIT,
  LEAD_EXPORT_ROW_COUNT_HEADER,
  areValidLeadPropertyFilters,
  exportLeadsRequestSchema,
  isValidLeadSort,
  parseLeadSort,
  type PropertyCatalog,
} from '@gt-sales/contracts';
import type { RateLimitInput, RateLimitResult } from '@gt-sales/db';
import { z } from 'zod';

import { sendDomainError } from '../http/domain-errors.js';
import { sendStaffAuthError } from '../http/staff-errors.js';
import type { LeadExportStore } from '../leads/export/store.js';
import { decideAccess, denyReasonOf, type StaffAccessSnapshot } from '../staff/authorization.js';
import type { PlanRouteDependencies } from './plans.js';

export interface LeadExportRouteDependencies {
  store: LeadExportStore;
  decide: PlanRouteDependencies['decide'];
  reportFailure: PlanRouteDependencies['reportFailure'];
  /** Whether the caller sees contact details, as the leads list decides it. */
  canSeeContacts(access: StaffAccessSnapshot): boolean;
  /** The site's property catalogue, as the list reads it. */
  loadCatalog(input: {
    workspaceId: string;
    actorId: string;
    requestId: string;
  }): Promise<PropertyCatalog>;
  /** The distributed limiter; omitted in route tests that do not reach it. */
  rateLimit?: (input: RateLimitInput) => Promise<RateLimitResult>;
}

/**
 * `POST /workspaces/:workspaceId/leads/export`: leads as an `.xlsx` file.
 *
 * - **Who:** `lead.export` on the site named in the URL (never the body): the
 *   roles that see contact details, or the individual `bulk_export`
 *   permission; an individual deny refuses it.
 * - **What:** the main fields and the ones asked for, cut to what the caller's
 *   role sees: no contact, form, custom or order column without contact
 *   access, the commission only with `revenue.view`, and never a sensitive
 *   property, a sealed identity or a document. Restricted leads are never
 *   read, as on the list.
 * - **Which:** the ticked ids (all must be this site's, else nothing is
 *   exported) or the list's own filters, validated exactly as `GET /leads`
 *   validates them; at most `LEAD_EXPORT_MAX_ROWS` leads.
 * - **How often:** `LEAD_EXPORT_RATE_LIMIT` per member and site, counted
 *   before anything is read.
 * - **Trace:** one `lead.exported` audit event per export, written by the
 *   store in the read's own transaction.
 */
export function createLeadExportRoutes(dependencies: LeadExportRouteDependencies): Router {
  const router = Router();

  router.post('/workspaces/:workspaceId/leads/export', async (req, res) => {
    const workspaceId = z.uuid().safeParse(req.params['workspaceId']);
    const body = exportLeadsRequestSchema.safeParse(req.body);
    if (!workspaceId.success || !body.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const { actor, decision } = await dependencies.decide(req, workspaceId.data, 'lead.export');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }
      const contacts = dependencies.canSeeContacts(decision.access);
      const access = {
        contacts,
        revenue: decideAccess(decision.access, 'revenue.view').allowed,
      };
      const { scope, fields } = body.data;
      // As on the list: searching, filtering by a property or sorting by a
      // name or a property reveals what a role without contact access never sees.
      if (scope.kind === 'filter' && !contacts) {
        const sort = scope.filter.sort ? parseLeadSort(scope.filter.sort) : undefined;
        if (
          scope.filter.q !== undefined ||
          scope.filter.where !== undefined ||
          sort?.field === 'fullName' ||
          sort?.propertyKey !== undefined
        ) {
          sendStaffAuthError(res, req.id, 'permission_denied', 403);
          return;
        }
      }

      if (dependencies.rateLimit) {
        let limit: RateLimitResult;
        try {
          limit = await dependencies.rateLimit({
            bucketKey: `lead_export:${actor.actorId}:${workspaceId.data}`,
            windowSeconds: LEAD_EXPORT_RATE_LIMIT.windowSeconds,
            maxCount: LEAD_EXPORT_RATE_LIMIT.maxCount,
          });
        } catch (error) {
          // Without the limiter the export is refused, never run unmetered.
          dependencies.reportFailure(req, error);
          sendDomainError(res, req.id, 'feature_not_ready', 503);
          return;
        }
        if (!limit.allowed) {
          res.setHeader('retry-after', String(limit.retryAfterSeconds));
          sendDomainError(res, req.id, 'rate_limited', 429);
          return;
        }
      }

      const catalog = await dependencies.loadCatalog({
        workspaceId: workspaceId.data,
        actorId: actor.actorId,
        requestId: req.id,
      });
      if (
        scope.kind === 'filter' &&
        ((scope.filter.where !== undefined &&
          !areValidLeadPropertyFilters(scope.filter.where, scope.filter.type, catalog)) ||
          (scope.filter.sort !== undefined &&
            !isValidLeadSort(scope.filter.sort, scope.filter.type, catalog)))
      ) {
        sendStaffAuthError(res, req.id, 'invalid_request', 400);
        return;
      }

      const outcome = await dependencies.store.export({
        workspaceId: workspaceId.data,
        actorId: actor.actorId,
        requestId: req.id,
        scope,
        fields,
        access,
        catalog,
      });
      if (outcome.status === 'leads_not_found') {
        sendDomainError(res, req.id, 'lead_not_found', 404, { missing: outcome.missing });
        return;
      }
      if (outcome.status === 'too_large') {
        sendDomainError(res, req.id, 'export_too_large', 422, {
          total: outcome.total,
          max: outcome.max,
        });
        return;
      }
      res.status(200);
      res.setHeader('content-type', LEAD_EXPORT_CONTENT_TYPE);
      // The name is `[a-z0-9-]` and `.xlsx` only (`leadExportFileName`), safe quoted as it is.
      res.setHeader('content-disposition', `attachment; filename="${outcome.fileName}"`);
      res.setHeader('cache-control', 'no-store');
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader(LEAD_EXPORT_ROW_COUNT_HEADER, String(outcome.rowCount));
      res.setHeader('content-length', String(outcome.file.byteLength));
      res.end(outcome.file);
    } catch (error) {
      dependencies.reportFailure(req, error);
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  });

  return router;
}
