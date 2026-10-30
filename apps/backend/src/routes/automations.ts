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
import type { CustomerEmail } from '../email/senders.js';
import { sendDomainError } from '../http/domain-errors.js';
import { sendStaffAuthError } from '../http/staff-errors.js';
import { decideAccess, denyReasonOf, type StaffAccessSnapshot } from '../staff/authorization.js';
import type { Scope } from '../tenant-scope.js';
import type { PlanRouteDependencies } from './plans.js';

export interface AutomationRouteDependencies {
  store: AutomationStore;
  /** Absent (a deployment built without mail), no site has a sender. */
  customerEmail: Pick<CustomerEmail, 'available'> | undefined;
  decide: PlanRouteDependencies['decide'];
  reportFailure: PlanRouteDependencies['reportFailure'];
  /** Whether the caller may see a lead's name, email and phone. */
  canSeeContacts(access: StaffAccessSnapshot): boolean;
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
        dependencies.customerEmail?.available(scope) ?? false,
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
