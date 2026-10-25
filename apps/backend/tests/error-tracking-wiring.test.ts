import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeErrorTracker } from '@gt-sales/adapters';

import { createApp } from '../src/app.js';

/**
 * REQ 40's "Done when": an induced error shows in the tracker carrying the
 * request id and no PII. This exercises the actual wiring in `app.ts`
 * (`createInvalidBodyError`) end to end over a real HTTP request, rather than
 * unit-testing the tracker in isolation (already covered in
 * `packages/adapters`/`packages/observability`).
 */

let server: Server;
let baseUrl: string;
let tracker: FakeErrorTracker;

beforeEach(async () => {
  tracker = new FakeErrorTracker();
  server = createApp({ errorTracker: tracker }).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected TCP server');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('backend error tracker wiring', () => {
  it('captures a malformed request with the response request id and no PII', async () => {
    const response = await fetch(`${baseUrl}/api/v1/website/leads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not valid json, email: jane@example.com',
    });
    expect(response.status).toBe(400);
    const requestId = response.headers.get('x-request-id');
    expect(requestId).toBeTruthy();

    expect(tracker.events).toHaveLength(1);
    const event = tracker.events[0]!;
    expect(event.tags.requestId).toBe(requestId);
    expect(JSON.stringify(event)).not.toContain('jane@example.com');
  });
});
