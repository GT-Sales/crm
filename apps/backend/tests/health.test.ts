import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { healthResponseSchema } from '@gt-sales/contracts';
import { createApp } from '../src/app.js';

let server: Server;
let baseUrl: string;

beforeEach(async () => {
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected server.address() to return an AddressInfo');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('GET /api/v1/health', () => {
  it('allows the shared client request headers through browser preflight', async () => {
    const response = await fetch(`${baseUrl}/api/v1/staff/workspaces`, {
      method: 'OPTIONS',
      headers: {
        origin: process.env.ADMIN_ORIGIN ?? 'http://localhost:3000',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization,content-type,x-request-id',
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-headers')).toContain('x-request-id');
  });

  it('allows every method the staff routes use through browser preflight', async () => {
    // PUT saves an automation switch and Settings → Email; the admin is on another origin.
    const response = await fetch(`${baseUrl}/api/v1/staff/workspaces`, {
      method: 'OPTIONS',
      headers: {
        origin: process.env.ADMIN_ORIGIN ?? 'http://localhost:3000',
        'access-control-request-method': 'PUT',
      },
    });
    expect(response.status).toBe(204);
    const allowed = (response.headers.get('access-control-allow-methods') ?? '').split(/,\s*/);
    expect(allowed).toEqual(expect.arrayContaining(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']));
  });

  it('returns ok: true with a UUID requestId', async () => {
    const res = await fetch(`${baseUrl}/api/v1/health`);
    const body = healthResponseSchema.parse(await res.json());

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it('echoes the generated requestId on the x-request-id response header', async () => {
    const res = await fetch(`${baseUrl}/api/v1/health`);
    const body = healthResponseSchema.parse(await res.json());

    expect(res.headers.get('x-request-id')).toBe(body.requestId);
  });

  it('never trusts a client-supplied x-request-id header', async () => {
    const forged = '00000000-0000-0000-0000-000000000000';
    const res = await fetch(`${baseUrl}/api/v1/health`, {
      headers: { 'x-request-id': forged },
    });
    const body = healthResponseSchema.parse(await res.json());

    expect(body.requestId).not.toBe(forged);
    expect(res.headers.get('x-request-id')).not.toBe(forged);
  });

  it('two requests never share a requestId', async () => {
    const [first, second] = await Promise.all([
      fetch(`${baseUrl}/api/v1/health`)
        .then((r) => r.json())
        .then((json) => healthResponseSchema.parse(json)),
      fetch(`${baseUrl}/api/v1/health`)
        .then((r) => r.json())
        .then((json) => healthResponseSchema.parse(json)),
    ]);

    expect(first.requestId).not.toBe(second.requestId);
  });
});

describe('unknown routes', () => {
  it('returns 404 for a path that does not exist', async () => {
    const res = await fetch(`${baseUrl}/api/v1/does-not-exist`);

    expect(res.status).toBe(404);
  });

  it('returns 404 for the wrong method on a known path', async () => {
    const res = await fetch(`${baseUrl}/api/v1/health`, { method: 'POST' });

    expect(res.status).toBe(404);
  });
});
