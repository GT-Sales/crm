import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAiAutomationRoutes } from '../src/routes/ai-automations.js';
import {
  AutomationAuthoringError,
  AutomationAuthoringStore,
} from '../src/ai/automation-authoring.js';
import type { StaffAccessSnapshot } from '../src/staff/authorization.js';
const SITE = '18000000-0000-4000-8000-000000009401';
const ACTOR = '28000000-0000-4000-8000-000000009401';
let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server) server.close(() => resolve());
    else resolve();
  });
  vi.restoreAllMocks();
});
async function setup(
  options: { enabled?: boolean; roles?: StaffAccessSnapshot['roles']; allowed?: boolean } = {},
) {
  const store = new AutomationAuthoringStore();
  const save = vi
    .spyOn(store, 'save')
    .mockResolvedValue({ status: 'saved', key: 'flow_abcdefghijklmnop', revision: 2 });
  const revise = vi.spyOn(store, 'revise');
  const load = vi.spyOn(store, 'load');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.id = '58000000-0000-4000-8000-000000009401';
    req.staffSession = { actorId: ACTOR, verifiedEmail: 'synthetic@example.test' };
    next();
  });
  app.use(
    createAiAutomationRoutes({
      config: {
        enabled: true,
        apiKey: 'test-key',
        signingKey: 'test-key',
        workspaceIds: new Set([SITE]),
        automationWorkspaceIds: new Set(options.enabled === false ? [] : [SITE]),
      },
      loadAccess: async () => ({
        membershipId: ACTOR,
        status: 'active',
        roles: options.roles ?? ['owner'],
        permissions: [],
      }),
      siteContext: {
        siteContext: async () => ({
          siteId: SITE,
          name: 'Test',
          slug: 'test',
          leadTypes: ['sim_order'],
        }),
      },
      rateLimit: async () => ({ allowed: options.allowed ?? true, retryAfterSeconds: 60 }),
      automationAuthoring: store,
      reportFailure: () => {},
    }),
  );
  server = app.listen(0);
  await new Promise<void>((resolve) => server?.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return {
    save,
    revise,
    load,
    url: `http://127.0.0.1:${address.port}/workspaces/${SITE}/ai/automations`,
  };
}
describe('AI automation confirmation routes', () => {
  it('saves only on explicit endpoint invocation and uses server scope', async () => {
    const ctx = await setup();
    expect(ctx.save).not.toHaveBeenCalled();
    const result = await fetch(ctx.url + '/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'signed' }),
    });
    expect(result.status).toBe(200);
    expect(ctx.save.mock.calls[0]?.[0]).toMatchObject({ workspaceId: SITE, actorId: ACTOR });
  });
  it.each(['save', 'revise', 'simulate'])(
    'refuses %s when the per-site capability is disabled',
    async (operation) => {
      const ctx = await setup({ enabled: false });
      const result = await fetch(ctx.url + '/' + operation, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'signed' }),
      });
      expect(result.status).toBe(503);
      expect(ctx.save).not.toHaveBeenCalled();
      expect(ctx.revise).not.toHaveBeenCalled();
      expect(ctx.load).not.toHaveBeenCalled();
    },
  );
  it.each(['viewer', 'leads', 'orders'] as const)(
    'refuses writes for a %s without integration.manage',
    async (role) => {
      const ctx = await setup({ roles: [role] });
      const result = await fetch(ctx.url + '/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'signed' }),
      });
      expect(result.status).toBe(403);
      expect(ctx.save).not.toHaveBeenCalled();
    },
  );
  it('rejects an attempt to substitute a draft at confirmation', async () => {
    const ctx = await setup();
    const result = await fetch(ctx.url + '/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'signed', draft: { name: 'Substitution' } }),
    });
    expect(result.status).toBe(400);
    expect(ctx.save).not.toHaveBeenCalled();
  });
  it('fails closed on rate limiting', async () => {
    const ctx = await setup({ allowed: false });
    const result = await fetch(ctx.url + '/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'signed' }),
    });
    expect(result.status).toBe(429);
    expect(ctx.save).not.toHaveBeenCalled();
  });
  it.each([
    ['not_found', 404],
    ['expired', 410],
    ['invalid', 400],
  ] as const)('answers a %s proposal with %i (AUTH-7)', async (code, status) => {
    const ctx = await setup();
    ctx.save.mockRejectedValueOnce(new AutomationAuthoringError(code));
    const result = await fetch(ctx.url + '/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'signed' }),
    });
    expect(result.status).toBe(status);
  });
});
