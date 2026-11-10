import { OutboxRunner, type OutboxRunSummary } from '@gt-sales/jobs';
import { Router, type RequestHandler } from 'express';

import { loadDeploymentEnvironment } from '../config/deployment.js';
import {
  defaultMachineRateLimit,
  requireMachineAttemptBudget,
  type MachineRateLimit,
} from '../http/machine-attempts.js';
import { sendStaffAuthError } from '../http/staff-errors.js';
import { sendWebsiteError } from '../http/website-errors.js';
import { createOutboxJobHandlers } from '../jobs/providers.js';
import { DatabaseOutboxStore } from '../jobs/store.js';
import { loadMachineRegistryOrDenyAll, type MachineRegistry } from '../machines/registry.js';

export interface JobsRouteDependencies {
  registry: MachineRegistry;
  run(input: {
    authorizedWorkspaceIds: readonly string[];
    actorId: string;
  }): Promise<OutboxRunSummary>;
  selector?: string;
  deploymentEnvironment?: string;
  /** Attempts per client IP, counted before the secret is checked; omitted in route tests. */
  rateLimit?: MachineRateLimit;
}

export function createDefaultJobsRouteDependencies(): JobsRouteDependencies & {
  queueHealth: DatabaseOutboxStore['queueHealth'];
} {
  const store = new DatabaseOutboxStore();
  const runner = new OutboxRunner({
    store,
    handlers: createOutboxJobHandlers(),
  });
  return {
    registry: loadMachineRegistryOrDenyAll(),
    run: (input) => runner.run(input),
    queueHealth: (input) => store.queueHealth(input),
    selector: process.env.JOB_RUNNER_SELECTOR,
    deploymentEnvironment: loadDeploymentEnvironment(),
    rateLimit: defaultMachineRateLimit,
  };
}

function bearerSecret(value: string | undefined): string | undefined {
  const match = /^Bearer ([^\s]+)$/.exec(value ?? '');
  return match?.[1];
}

/** Authenticated scheduled entry point. No tenant is discovered through the database. */
export function createJobsRouter(dependencies: JobsRouteDependencies): Router {
  const router = Router();
  const runJobs: RequestHandler = async (req, res) => {
    // This guard prevents a copied URL/secret from making a preview deployment
    // act as a scheduler. It is platform-neutral: `DEPLOYMENT_ENV` on Railway,
    // with `VERCEL_ENV` still honoured as the fallback during cutover (D6).
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
    if (!identity.hasScope('outbox:run')) {
      sendWebsiteError(res, req.id, 'scope_denied', 403);
      return;
    }
    try {
      const summary = await dependencies.run({
        authorizedWorkspaceIds: identity.workspaceIds,
        actorId: identity.actorId,
      });
      res.json({ ...summary, requestId: req.id });
    } catch {
      sendStaffAuthError(res, req.id, 'internal_error', 500);
    }
  };
  // POST only (audit L-10): a GET with side effects is replayable by anything
  // that logs URLs and headers. The scheduler is in-process (`src/scheduler.ts`)
  // and never calls this over HTTP, so this is the manual entry point.
  router.post('/run', requireMachineAttemptBudget('jobs-run', dependencies.rateLimit), runJobs);
  return router;
}
