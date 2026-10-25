import { OutboxRunner, type OutboxRunSummary } from '@gt-sales/jobs';
import { Router, type RequestHandler } from 'express';

import { loadDeploymentEnvironment } from '../config/deployment.js';
import { sendStaffAuthError } from '../http/staff-errors.js';
import { sendWebsiteError } from '../http/website-errors.js';
import { createOutboxJobHandlers } from '../jobs/providers.js';
import { DatabaseOutboxStore } from '../jobs/store.js';
import { loadMachineRegistry, type MachineRegistry } from '../machines/registry.js';

export interface JobsRouteDependencies {
  registry: MachineRegistry;
  run(input: {
    authorizedWorkspaceIds: readonly string[];
    actorId: string;
  }): Promise<OutboxRunSummary>;
  selector?: string;
  deploymentEnvironment?: string;
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
    registry: loadMachineRegistry(),
    run: (input) => runner.run(input),
    queueHealth: (input) => store.queueHealth(input),
    selector: process.env.JOB_RUNNER_SELECTOR,
    deploymentEnvironment: loadDeploymentEnvironment(),
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
  // The scheduler issues GET. POST remains available for an authenticated
  // manual staging invocation of the identical path.
  router.get('/run', runJobs);
  router.post('/run', runJobs);
  return router;
}
