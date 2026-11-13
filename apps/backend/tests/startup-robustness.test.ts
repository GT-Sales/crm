import { FakeErrorTracker } from '@gt-sales/adapters';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { loadMachineRegistryOrDenyAll } from '../src/machines/registry.js';
import { registerProcessHandlers } from '../src/process-handlers.js';
import { createReadyHandler } from '../src/routes/health.js';
import { requestId } from '../src/requestId.js';

afterEach(() => vi.restoreAllMocks());

describe('loadMachineRegistryOrDenyAll (audit L-6)', () => {
  it('answers a deny-all registry for malformed JSON or a bad entry, and logs only a code', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const raw of ['{not json', JSON.stringify({ webhooks: [{ selector: 'x' }] })]) {
      const registry = loadMachineRegistryOrDenyAll(raw);
      expect(registry.resolveScheduler({ selector: 'x', secret: 'y'.repeat(32) })).toEqual({
        ok: false,
        reason: 'machine_unknown',
      });
    }
    const logged = errors.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(logged).toEqual([
      { event: 'machine_registry_invalid', code: 'json_syntax' },
      { event: 'machine_registry_invalid', code: 'schema' },
    ]);
  });
});

describe('registerProcessHandlers (audit L-6)', () => {
  function wire() {
    const listeners = new Map<string, (error: unknown) => void>();
    const tracker = new FakeErrorTracker();
    const shutdown = vi.fn(async () => {});
    const exit = vi.fn();
    registerProcessHandlers({
      tracker,
      shutdown,
      exit,
      on: (event, listener) => listeners.set(event, listener),
    });
    return { listeners, tracker, shutdown, exit };
  }

  it('reports an unhandled rejection by code and keeps running', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { listeners, tracker, exit } = wire();
    listeners.get('unhandledRejection')!(new TypeError('ada@example.test is not a function'));
    expect(JSON.parse(String(errors.mock.calls[0]![0]))).toEqual({
      event: 'unhandled_rejection',
      code: 'TypeError',
    });
    expect(tracker.events[0]!.exception.values[0].value).not.toContain('ada@example.test');
    expect(exit).not.toHaveBeenCalled();
  });

  it('shuts down and exits non-zero on an uncaught exception, once', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { listeners, shutdown, exit } = wire();
    listeners.get('uncaughtException')!(new Error('boom'));
    listeners.get('uncaughtException')!(new Error('again'));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/v1/ready (audit L-7)', () => {
  async function call(ping: (timeoutMs: number) => Promise<void>) {
    const app = express();
    app.use(requestId);
    app.get('/api/v1/ready', createReadyHandler(ping));
    const server = app.listen(0);
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('no port');
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/ready`);
      const body: unknown = await response.json();
      return { status: response.status, body: z.record(z.string(), z.unknown()).parse(body) };
    } finally {
      server.close();
    }
  }

  it('answers 200 once the database answers', async () => {
    const ping = vi.fn(async () => {});
    const result = await call(ping);
    expect(result.status).toBe(200);
    expect(result.body['ok']).toBe(true);
    expect(ping).toHaveBeenCalledWith(3_000);
  });

  it('answers 503 with a fixed code, never the error text', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await call(async () => {
      throw new Error('getaddrinfo ENOTFOUND db.secret-host.example');
    });
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ ok: false, code: 'database_unreachable' });
    expect(JSON.stringify(result.body)).not.toContain('secret-host');
  });
});
