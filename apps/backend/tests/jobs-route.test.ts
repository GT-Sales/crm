import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadDeploymentEnvironment } from '../src/config/deployment.js';
import { MachineRegistry } from '../src/machines/registry.js';
import { requestId } from '../src/requestId.js';
import { createJobsRouter } from '../src/routes/jobs.js';

const WORKSPACE = '10000000-0000-4000-8000-000000000771';
const ACTOR = '20000000-0000-4000-8000-000000000771';
const SECRET = 'cron-secret-value-000000000771';

describe('/api/internal/jobs/run', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  });

  async function setup(
    options: { scope?: 'outbox:run' | 'reconcile:run'; environment?: string } = {},
  ) {
    const run = vi.fn(async () => ({
      workspaces: 1,
      claimed: 1,
      completed: 1,
      retried: 0,
      failed: 0,
      uncertain: 0,
      leaseLost: 0,
    }));
    const registry = new MachineRegistry({
      webhooks: [],
      schedulers: [
        {
          selector: 'outbox-runner',
          secret: SECRET,
          actorId: ACTOR,
          workspaceIds: [WORKSPACE],
          scopes: [options.scope ?? 'outbox:run'],
          revoked: false,
        },
      ],
    });
    const app = express();
    app.use(requestId);
    app.use(
      '/api/internal/jobs',
      createJobsRouter({
        registry,
        run,
        selector: 'outbox-runner',
        deploymentEnvironment: options.environment ?? 'production',
      }),
    );
    server = app.listen(0);
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP server');
    return { run, url: `http://127.0.0.1:${address.port}/api/internal/jobs/run` };
  }

  it('runs only the registry-authorized workspace set', async () => {
    const { run, url } = await setup();
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(response.status).toBe(200);
    expect(run).toHaveBeenCalledWith({ authorizedWorkspaceIds: [WORKSPACE], actorId: ACTOR });
  });

  it('denies a wrong secret and a scheduler without outbox scope', async () => {
    let setupResult = await setup();
    let response = await fetch(setupResult.url, {
      method: 'POST',
      headers: { authorization: 'Bearer definitely-wrong-secret' },
    });
    expect(response.status).toBe(401);
    expect(setupResult.run).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;

    setupResult = await setup({ scope: 'reconcile:run' });
    response = await fetch(setupResult.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(response.status).toBe(403);
    expect(setupResult.run).not.toHaveBeenCalled();
  });

  it('refuses to schedule work on a preview deployment', async () => {
    const { run, url } = await setup({ environment: 'preview' });
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(response.status).toBe(403);
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses a preview deployment resolved from DEPLOYMENT_ENV', async () => {
    const { run, url } = await setup({
      environment: loadDeploymentEnvironment({ DEPLOYMENT_ENV: 'preview' }),
    });
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(response.status).toBe(403);
    expect(run).not.toHaveBeenCalled();
  });

  it('honours the VERCEL_ENV fallback when DEPLOYMENT_ENV is unset', async () => {
    const { run, url } = await setup({
      environment: loadDeploymentEnvironment({ VERCEL_ENV: 'preview' }),
    });
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(response.status).toBe(403);
    expect(run).not.toHaveBeenCalled();
  });
});
