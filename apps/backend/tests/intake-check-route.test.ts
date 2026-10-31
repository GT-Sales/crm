import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MachineScopeName } from '@gt-sales/types';

import type { IntakeCheckResult, IntakeCheckRunInput } from '../src/intake-check/check.js';
import { MachineRegistry } from '../src/machines/registry.js';
import { requestId } from '../src/requestId.js';
import {
  createIntakeCheckRouter,
  type IntakeCheckRouteDependencies,
} from '../src/routes/intake-check.js';

const WORKSPACE = '10000000-0000-4000-8000-00000000f771';
const TEST_SITE = '16000000-0000-4000-8000-00000000f771';
const OTHER_SITE = '16000000-0000-4000-8000-00000000f772';
const ACTOR = '26000000-0000-4000-8000-00000000f771';
const SECRET = 'intake-check-secret-0000000000f771';

describe('POST /api/internal/jobs/intake-check', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  });

  async function setup(
    options: {
      scopes?: MachineScopeName[];
      environment?: string;
      result?: IntakeCheckResult;
      workspaceId?: string | null;
      run?: IntakeCheckRouteDependencies['run'];
    } = {},
  ) {
    const run = vi.fn(
      options.run ??
        (async (_input: IntakeCheckRunInput): Promise<IntakeCheckResult> =>
          options.result ?? { status: 'ok', durationMs: 42 }),
    );
    const registry = new MachineRegistry({
      webhooks: [],
      schedulers: [
        {
          selector: 'job-runner',
          secret: SECRET,
          actorId: ACTOR,
          workspaceIds: [WORKSPACE],
          scopes: options.scopes ?? ['outbox:run', 'synthetic:check'],
          revoked: false,
        },
      ],
    });
    const app = express();
    app.use(requestId);
    app.use(express.json());
    app.use(
      '/api/internal/jobs',
      createIntakeCheckRouter({
        registry,
        run,
        ...(options.workspaceId === null ? {} : { workspaceId: options.workspaceId ?? TEST_SITE }),
        selector: 'job-runner',
        deploymentEnvironment: options.environment ?? 'production',
      }),
    );
    server = app.listen(0);
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP server');
    return { run, url: `http://127.0.0.1:${address.port}/api/internal/jobs/intake-check` };
  }

  const post = (url: string, init: { secret?: string; body?: unknown } = {}) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(init.secret === undefined ? {} : { authorization: `Bearer ${init.secret}` }),
      },
      body: JSON.stringify(init.body ?? {}),
    });

  async function errorCode(response: Response): Promise<unknown> {
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || !('error' in body)) return undefined;
    const error = body.error;
    if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
    return error.code;
  }

  it('refuses a caller with no secret', async () => {
    const { run, url } = await setup();
    const response = await post(url);
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe('machine_unknown');
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses a wrong secret', async () => {
    const { run, url } = await setup();
    const response = await post(url, { secret: 'definitely-the-wrong-secret' });
    expect(response.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses an identity without synthetic:check', async () => {
    const { run, url } = await setup({ scopes: ['outbox:run'] });
    const response = await post(url, { secret: SECRET });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('scope_denied');
    expect(run).not.toHaveBeenCalled();
  });

  it('answers intake_check_off when no test site is configured, after authentication', async () => {
    for (const workspaceId of [null, '', 'not-a-uuid']) {
      const { run, url } = await setup({ workspaceId });
      const response = await post(url, { secret: SECRET });
      expect(response.status).toBe(404);
      expect(await errorCode(response)).toBe('intake_check_off');
      expect(run).not.toHaveBeenCalled();
      const stranger = await post(url);
      expect(stranger.status).toBe(401);
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });

  it('returns a failed run as 200 with its step and code', async () => {
    const { url } = await setup({
      result: { status: 'failed', step: 'create', code: 'sqlstate_23503', durationMs: 7 },
    });
    const response = await post(url, { secret: SECRET });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'failed',
      step: 'create',
      code: 'sqlstate_23503',
      durationMs: 7,
      requestId: expect.any(String),
    });
  });

  it('returns an ok run as 200', async () => {
    const { url } = await setup();
    const response = await post(url, { secret: SECRET });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      durationMs: 42,
      requestId: expect.any(String),
    });
  });

  it('runs as the registry actor on the configured site, never one from the request', async () => {
    const { run, url } = await setup();
    const response = await post(url, {
      secret: SECRET,
      body: { workspaceId: OTHER_SITE, actorId: OTHER_SITE },
    });
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({
      workspaceId: TEST_SITE,
      actorId: ACTOR,
      requestId: expect.any(String),
    });
    expect(body).toMatchObject({ requestId: run.mock.calls[0]?.[0].requestId });
  });

  it('refuses a preview deployment', async () => {
    const { run, url } = await setup({ environment: 'preview' });
    const response = await post(url, { secret: SECRET });
    expect(response.status).toBe(403);
    expect(run).not.toHaveBeenCalled();
  });

  it('answers 500 internal_error when the run throws', async () => {
    const { url } = await setup({
      run: async () => {
        throw new Error('unexpected');
      },
    });
    const response = await post(url, { secret: SECRET });
    expect(response.status).toBe(500);
    expect(await errorCode(response)).toBe('internal_error');
  });

  it('takes POST only', async () => {
    const { run, url } = await setup();
    const response = await fetch(url, { headers: { authorization: `Bearer ${SECRET}` } });
    expect(response.status).toBe(404);
    expect(run).not.toHaveBeenCalled();
  });
});
