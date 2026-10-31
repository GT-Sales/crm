import { Router, type RequestHandler } from 'express';
import { z } from 'zod';

import { loadDeploymentEnvironment } from '../config/deployment.js';
import { sendDomainError } from '../http/domain-errors.js';
import { sendStaffAuthError } from '../http/staff-errors.js';
import { sendWebsiteError } from '../http/website-errors.js';
import {
  runIntakeCheck,
  type IntakeCheckResult,
  type IntakeCheckRunInput,
} from '../intake-check/check.js';
import { DatabaseIntakeCheckStore } from '../intake-check/store.js';
import { DatabaseLeadStore } from '../leads/store.js';
import { loadMachineRegistry, type MachineRegistry } from '../machines/registry.js';

/**
 * `POST /api/internal/jobs/intake-check`: one intake check run by hand, for a
 * scheduler identity holding `synthetic:check`. It returns the result and
 * never alerts: the alert state belongs to the scheduled task (R6). It stays
 * out of the endpoint registry, as `/api/internal/jobs/run` does (R10).
 */

export interface IntakeCheckRouteDependencies {
  registry: MachineRegistry;
  /** `INTAKE_CHECK_WORKSPACE_ID`; absent or not a uuid, the route answers 404 `intake_check_off`. */
  workspaceId?: string;
  run(input: IntakeCheckRunInput): Promise<IntakeCheckResult>;
  /** `JOB_RUNNER_SELECTOR`, used when the request sends no `X-Scheduler-Selector`. */
  selector?: string;
  deploymentEnvironment?: string;
}

export function createDefaultIntakeCheckRouteDependencies(): IntakeCheckRouteDependencies {
  const check = { leads: new DatabaseLeadStore(), store: new DatabaseIntakeCheckStore() };
  return {
    registry: loadMachineRegistry(),
    workspaceId: process.env.INTAKE_CHECK_WORKSPACE_ID,
    run: (input) => runIntakeCheck(check, input),
    selector: process.env.JOB_RUNNER_SELECTOR,
    deploymentEnvironment: loadDeploymentEnvironment(),
  };
}

function bearerSecret(value: string | undefined): string | undefined {
  const match = /^Bearer ([^\s]+)$/.exec(value ?? '');
  return match?.[1];
}

export function createIntakeCheckRouter(dependencies: IntakeCheckRouteDependencies): Router {
  const router = Router();
  const configuredSite = z.uuid().safeParse(dependencies.workspaceId);
  const runCheck: RequestHandler = async (req, res) => {
    // The same order as `routes/jobs.ts`: a preview never acts as a scheduler.
    if (dependencies.deploymentEnvironment === 'preview') {
      sendWebsiteError(res, req.id, 'machine_unknown', 403);
      return;
    }
    const selector = req.get('x-scheduler-selector') ?? dependencies.selector;
    const secret = bearerSecret(req.get('authorization'));
    if (!selector || !secret) {
      sendWebsiteError(res, req.id, 'machine_unknown', 401);
      return;
    }
    const identity = dependencies.registry.resolveScheduler({ selector, secret });
    if (!identity.ok) {
      sendWebsiteError(res, req.id, identity.reason, 401);
      return;
    }
    if (!identity.hasScope('synthetic:check')) {
      sendWebsiteError(res, req.id, 'scope_denied', 403);
      return;
    }
    // After authentication, so a stranger learns nothing about the configuration.
    if (!configuredSite.success) {
      sendDomainError(res, req.id, 'intake_check_off', 404);
      return;
    }
    try {
      // The site and the actor come from deployment config and the registry,
      // never from the request.
      const result = await dependencies.run({
        workspaceId: configuredSite.data,
        actorId: identity.actorId,
        requestId: req.id,
      });
      res.json({ ...result, requestId: req.id });
    } catch {
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  };
  router.post('/intake-check', runCheck);
  return router;
}
