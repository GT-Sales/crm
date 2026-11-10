import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeErrorTracker } from '@gt-sales/adapters';
import { apiErrorResponseSchema } from '@gt-sales/contracts';

import { createApp, createLastResortErrorHandler } from '../src/app.js';

/**
 * Audit L-9 and L-11: the last-resort handler says whose fault a failure was,
 * and every /api response carries no-store, nosniff and no framework banner.
 */

describe('last-resort error handler', () => {
  function respond(error: unknown) {
    const tracker = new FakeErrorTracker();
    const res = {
      headersSent: false,
      statusCode: 0,
      headers: {} as Record<string, string>,
      body: undefined as unknown,
      setHeader(name: string, value: string) {
        this.headers[name] = value;
        return this;
      },
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(body: unknown) {
        this.body = body;
        return this;
      },
    };
    const req = { id: '11111111-1111-4111-8111-111111111111', path: '/x', params: {} };
    createLastResortErrorHandler(tracker)(error, req as never, res as never, vi.fn());
    return { res, tracker };
  }
  const code = (body: unknown) => apiErrorResponseSchema.parse(body).error.code;

  it('answers a body the server could not read with 400', () => {
    const { res } = respond(
      Object.assign(new SyntaxError('Unexpected token'), {
        status: 400,
        type: 'entity.parse.failed',
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(code(res.body)).toBe('invalid_request');
  });

  it('answers an oversized body with 413', () => {
    const { res } = respond(
      Object.assign(new Error('request entity too large'), {
        status: 413,
        type: 'entity.too.large',
      }),
    );
    expect(res.statusCode).toBe(413);
    expect(code(res.body)).toBe('payload_too_large');
  });

  it('answers a database that cannot be reached with a retryable 503', () => {
    const { res } = respond(
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    );
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('2');
    expect(code(res.body)).toBe('persistence_unavailable');
  });

  it('answers anything else with 500 and nothing of the error', () => {
    const { res, tracker } = respond(
      new TypeError('Cannot read properties of undefined (reading "id") for jane@example.com'),
    );
    expect(res.statusCode).toBe(500);
    expect(code(res.body)).toBe('internal_error');
    expect(JSON.stringify(res.body)).not.toContain('jane@example.com');
    expect(JSON.stringify(res.body)).not.toContain('Cannot read');
    // Reported to the tracker whatever the answer.
    expect(tracker.events).toHaveLength(1);
  });

  it('treats a non-error throw as a 500, not a client error', () => {
    const { res } = respond('boom');
    expect(res.statusCode).toBe(500);
  });
});

describe('over HTTP', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    server = createApp({ errorTracker: new FakeErrorTracker() }).listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected TCP server');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('answers malformed JSON with 400 and an oversized body with 413', async () => {
    const bad = await fetch(`${baseUrl}/api/v1/website/leads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{nope',
    });
    expect(bad.status).toBe(400);
    expect(code(await bad.json())).toBe('invalid_request');

    const big = await fetch(`${baseUrl}/api/v1/website/leads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filler: 'x'.repeat(70_000) }),
    });
    expect(big.status).toBe(413);
    expect(code(await big.json())).toBe('payload_too_large');
  });

  it('sets no-store, nosniff and no-referrer on /api responses and no X-Powered-By', async () => {
    for (const path of ['/api/v1/health', '/api/v1/website/leads', '/api/v1/nope']) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('x-powered-by')).toBeNull();
    }
  });
});

function code(body: unknown): string {
  return apiErrorResponseSchema.parse(body).error.code;
}
