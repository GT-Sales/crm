import { apiErrorResponseSchema } from '@gt-sales/contracts';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isJwtShaped,
  requireStaffSession,
  SupabaseStaffSessionVerifier,
  type StaffRateLimit,
  type StaffSessionVerifier,
} from '../src/auth/session.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const FORGED_PAYLOAD =
  'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiIyMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEiLCJhYWwiOiJhYWwyIn0';

function stubSupabaseRejecting() {
  vi.stubEnv('SUPABASE_URL', 'https://staff-auth.example.test');
  vi.stubEnv('SUPABASE_ANON_KEY', 'publishable-test-key');
  const request = vi.fn(
    async () =>
      new Response(JSON.stringify({ message: 'invalid token' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', request);
  return request;
}

describe('Supabase staff session verification', () => {
  it('lets Supabase reject a well-formed token with a forged payload', async () => {
    const request = stubSupabaseRejecting();
    const forged = `${FORGED_PAYLOAD}.c2lnbmF0dXJl`;
    await expect(new SupabaseStaffSessionVerifier().verify(forged)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledOnce();
  });

  it('rejects an unsigned or non-JWT token without calling Supabase (REL-17)', async () => {
    const request = stubSupabaseRejecting();
    for (const token of [`${FORGED_PAYLOAD}.`, 'not-a-jwt', 'a.b', 'a.b.c.d', 'a.b.c$']) {
      await expect(new SupabaseStaffSessionVerifier().verify(token)).resolves.toBeUndefined();
    }
    expect(request).not.toHaveBeenCalled();
    expect(isJwtShaped(`${FORGED_PAYLOAD}.c2lnbmF0dXJl`)).toBe(true);
  });
});

describe('staff route rate limit (REL-17)', () => {
  async function serve(rateLimit: StaffRateLimit | undefined, verifier: StaffSessionVerifier) {
    const app = express();
    app.use((req, _res, next) => {
      req.id = '70000000-0000-4000-8000-000000000017';
      next();
    });
    app.use(requireStaffSession(verifier, rateLimit));
    app.get('/', (_req, res) => {
      res.json({ ok: true });
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const address: AddressInfo | string | null = server.address();
    if (!address || typeof address === 'string') throw new Error('server has no port');
    return { url: `http://127.0.0.1:${address.port}/`, close: () => server.close() };
  }
  const verifier = (): StaffSessionVerifier & { verify: ReturnType<typeof vi.fn> } => ({
    verify: vi.fn(async () => ({
      actorId: '20000000-0000-4000-8000-000000000001',
      verifiedEmail: 'owner@example.test',
    })),
  });

  it('answers 429 with retry-after before checking the session', async () => {
    const sessions = verifier();
    const rateLimit = vi.fn<StaffRateLimit>(async () => ({
      allowed: false,
      retryAfterSeconds: 42,
    }));
    const app = await serve(rateLimit, sessions);
    try {
      const response = await fetch(app.url, { headers: { authorization: 'Bearer a.b.c' } });
      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('42');
      expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe('rate_limited');
      expect(rateLimit).toHaveBeenCalledWith(
        expect.objectContaining({
          bucketKey: expect.stringMatching(/^staff:ip:/),
          windowSeconds: 60,
          maxCount: 300,
        }),
      );
      expect(sessions.verify).not.toHaveBeenCalled();
    } finally {
      app.close();
    }
  });

  it('lets staff through when the limiter allows or fails', async () => {
    for (const rateLimit of [
      vi.fn<StaffRateLimit>(async () => ({ allowed: true, retryAfterSeconds: 0 })),
      vi.fn<StaffRateLimit>(async () => {
        throw new Error('database unavailable');
      }),
    ]) {
      const app = await serve(rateLimit, verifier());
      try {
        const response = await fetch(app.url, { headers: { authorization: 'Bearer a.b.c' } });
        expect(response.status).toBe(200);
      } finally {
        app.close();
      }
    }
  });
});
