import type { ErrorTracker } from '@gt-sales/adapters';
import { Router, type Request, type Response } from 'express';
import {
  BUILT_IN_AUTOMATIONS,
  automationKeySchema,
  updateAutomationRequestSchema,
  type Automation,
  type AutomationKey,
  type BuiltInAutomation,
} from '@gt-sales/contracts';
import { z } from 'zod';

import type { AutomationStore, StoredAutomation } from '../automations/store.js';
import { sendDomainError } from '../http/domain-errors.js';
import { isConnectionLevelError, logRequestError } from '../http/logger.js';
import { sendStaffAuthError } from '../http/staff-errors.js';
import {
  createAuthorize,
  decideAccess,
  denyReasonOf,
  type StaffAccessSnapshot,
  type StaffAccessStore,
} from '../staff/authorization.js';
import type { Scope } from '../tenant-scope.js';
import type { PlanRouteDependencies } from './plans.js';

/**
 * The only thing these routes ask of customer mail: whether this site can
 * send. The staff router's `CustomerEmail.available` takes the site today; a
 * change of its signature (to the site and actor, asynchronously) is absorbed
 * where this is built, not here.
 */
export interface SenderAvailability {
  available(ctx: Scope): boolean | Promise<boolean>;
}

export interface AutomationRouteDependencies {
  store: AutomationStore;
  customerEmail: SenderAvailability;
  decide: PlanRouteDependencies['decide'];
  reportFailure: PlanRouteDependencies['reportFailure'];
  /** Whether the caller may see a lead's name, email and phone. */
  canSeeContacts(access: StaffAccessSnapshot): boolean;
}

/** The staff router's contact-detail rule: roles that work leads or money. */
export function canSeeContacts(access: StaffAccessSnapshot): boolean {
  return (['lead.manage', 'order.manage', 'financial.read'] as const).some(
    (action) => decideAccess(access, action).allowed,
  );
}

const RUN_LIST_LIMIT = 50;

function triggerOf(trigger: BuiltInAutomation['trigger']): Automation['trigger'] {
  return trigger.kind === 'lead_submitted'
    ? { kind: trigger.kind, leadTypes: [...trigger.leadTypes] }
    : { ...trigger };
}

function withState(stored: StoredAutomation): Automation | undefined {
  const definition = BUILT_IN_AUTOMATIONS.find(({ key }) => key === stored.key);
  if (!definition) return undefined;
  return {
    key: definition.key,
    label: definition.label,
    trigger: triggerOf(definition.trigger),
    action: { ...definition.action },
    enabled: stored.enabled,
    lastRunAt: stored.lastRunAt === null ? null : stored.lastRunAt.toISOString(),
    runCount: stored.runCount,
  };
}

/**
 * The site's six built-in automation rules, under
 * `/workspaces/:workspaceId/automations`. Everyone who reads the site sees
 * them and their runs (lead names only with contact access); switching one
 * needs `integration.manage` (the owner).
 */
export function createAutomationRoutes(dependencies: AutomationRouteDependencies): Router {
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

  /** The rule the path names, or the 404 already sent. */
  function keyOf(req: Request, res: Response): AutomationKey | undefined {
    const key = automationKeySchema.safeParse(req.params['key']);
    if (!key.success) {
      sendDomainError(res, req.id, 'automation_not_found', 404);
      return undefined;
    }
    return key.data;
  }

  router.get('/workspaces/:workspaceId/automations', async (req, res) => {
    const workspaceId = workspaceIdOf(req);
    if (!workspaceId) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const { actor, decision } = await dependencies.decide(req, workspaceId, 'workspace.read');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }
      const scope: Scope = { workspaceId, actorId: actor.actorId };
      const [rules, hasSender] = await Promise.all([
        store.list(scope),
        dependencies.customerEmail.available(scope),
      ]);
      res.json({
        automations: rules.flatMap((rule) => withState(rule) ?? []),
        canManage: decideAccess(decision.access, 'integration.manage').allowed,
        hasSender,
        requestId: req.id,
      });
    } catch (error) {
      failed(req, res, error);
    }
  });

  router.put('/workspaces/:workspaceId/automations/:key', async (req, res) => {
    const workspaceId = workspaceIdOf(req);
    const body = updateAutomationRequestSchema.safeParse(req.body);
    if (!workspaceId || !body.success) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const { actor, decision } = await dependencies.decide(req, workspaceId, 'integration.manage');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }
      // After the permission check, so a caller who may not switch rules
      // learns nothing about which keys exist.
      const key = keyOf(req, res);
      if (!key) return;
      const saved = await store.setEnabled(
        { workspaceId, actorId: actor.actorId, requestId: req.id },
        key,
        body.data.enabled,
      );
      const automation = withState(saved);
      if (!automation) throw new Error('automation has no built-in definition');
      res.json({ automation, requestId: req.id });
    } catch (error) {
      failed(req, res, error);
    }
  });

  router.get('/workspaces/:workspaceId/automations/:key/runs', async (req, res) => {
    const workspaceId = workspaceIdOf(req);
    if (!workspaceId) {
      sendStaffAuthError(res, req.id, 'invalid_request', 400);
      return;
    }
    try {
      const { actor, decision } = await dependencies.decide(req, workspaceId, 'workspace.read');
      if (!decision.allowed) {
        sendStaffAuthError(res, req.id, denyReasonOf(decision), 403);
        return;
      }
      const key = keyOf(req, res);
      if (!key) return;
      const runs = await store.listRuns({ workspaceId, actorId: actor.actorId }, key, {
        limit: RUN_LIST_LIMIT,
        includeLeadNames: dependencies.canSeeContacts(decision.access),
      });
      res.json({
        runs: runs.map((run) => ({
          id: run.id,
          leadId: run.leadId,
          leadName: run.leadName,
          outcome: run.outcome,
          reason: run.reason,
          createdAt: run.createdAt.toISOString(),
        })),
        requestId: req.id,
      });
    } catch (error) {
      failed(req, res, error);
    }
  });

  return router;
}

export interface StaffAutomationRouteOptions {
  store: AutomationStore;
  customerEmail: SenderAvailability;
  /** Reads the caller's live membership, as the staff router does. */
  accessStore: StaffAccessStore;
  errorTracker?: ErrorTracker | undefined;
}

/**
 * The automation routes for the staff API, with the same live authorization
 * and last-resort failure report as the staff router. Mounted after it on
 * `/api/v1/staff`, so its session check (and rate limit) has already run for
 * every request that reaches these routes.
 */
export function createStaffAutomationRoutes(options: StaffAutomationRouteOptions): Router {
  const authorize = createAuthorize({ accessStore: options.accessStore });
  return createAutomationRoutes({
    store: options.store,
    customerEmail: options.customerEmail,
    canSeeContacts,
    async decide(req, workspaceId, action) {
      const actor = req.staffSession;
      if (!actor) throw new Error('staff session middleware did not run');
      const decision = await authorize({ actorId: actor.actorId, workspaceId, action });
      return { actor, decision };
    },
    reportFailure(req, error) {
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
      options.errorTracker?.captureException(error, {
        requestId: req.id,
        workspaceId,
        actorId: req.staffSession?.actorId,
        route,
        release: process.env['RELEASE_SHA'] ?? 'unknown',
        environment: process.env['DEPLOYMENT_ENV'] ?? process.env['NODE_ENV'],
      });
    },
  });
}
