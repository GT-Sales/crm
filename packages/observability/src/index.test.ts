import { describe, expect, test } from 'vitest';

import { buildErrorEvent, buildLogRecord, FakeErrorTracker, scrubValue } from './index.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('expected an object');
  return value;
}

function asString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('expected a string');
  return value;
}

describe('scrubValue', () => {
  test('redacts fields whose name marks them as PII, regardless of casing/separators', () => {
    const input = {
      fullName: 'Jane Doe',
      full_name: 'Jane Doe',
      FirstName: 'Jane',
      email: 'jane@example.com',
      Email: 'jane@example.com',
      phone: '+1 604 555 1212',
      passportNumber: 'A1234567',
      documentUrl: 'https://r2.example/private/doc.pdf',
      token: 'abc.def.ghi',
      apiKey: 'sk_live_123',
      password: 'hunter2',
    };
    const scrubbed = asRecord(scrubValue(input));
    for (const key of Object.keys(input)) {
      expect(scrubbed[key]).toBe('[redacted]');
    }
  });

  test('redacts email- and phone-shaped substrings inside otherwise-safe fields', () => {
    const scrubbed = asRecord(
      scrubValue({
        note: 'Customer reachable at jane@example.com or +1 (604) 555-1212 after 5pm.',
      }),
    );
    const note = asString(scrubbed.note);
    expect(note).not.toContain('jane@example.com');
    expect(note).not.toContain('555-1212');
    expect(note).toContain('[redacted]');
  });

  test('leaves non-PII fields untouched', () => {
    const input = { orderReference: 'CP-1029', status: 'submitted', total: 4999, ok: true };
    expect(scrubValue(input)).toEqual(input);
  });

  test('recurses through nested objects and arrays', () => {
    const scrubbed = asRecord(
      scrubValue({
        order: {
          customer: { email: 'jane@example.com', reference: 'CP-1029' },
          items: [{ documentUrl: 'https://r2.example/a.pdf' }, { label: 'SIM kit' }],
        },
      }),
    );
    const order = asRecord(scrubbed.order);
    const customer = asRecord(order.customer);
    const items = order.items;
    if (!Array.isArray(items)) throw new Error('expected an array');
    expect(customer.email).toBe('[redacted]');
    expect(customer.reference).toBe('CP-1029');
    expect(asRecord(items[0]).documentUrl).toBe('[redacted]');
    expect(asRecord(items[1]).label).toBe('SIM kit');
  });

  test('bounds unreasonable depth instead of recursing indefinitely', () => {
    let deep: Record<string, unknown> = { leaf: 'value' };
    for (let index = 0; index < 20; index += 1) deep = { nested: deep };
    expect(() => scrubValue(deep)).not.toThrow();
  });

  test('truncates very long strings', () => {
    const scrubbed = asString(scrubValue('x'.repeat(5000)));
    expect(scrubbed.length).toBeLessThan(2100);
    expect(scrubbed.endsWith('…[truncated]')).toBe(true);
  });

  test('never serializes functions or symbols as-is', () => {
    expect(scrubValue(() => 'x')).toBe('[redacted]');
    expect(scrubValue(Symbol('x'))).toBe('[redacted]');
  });
});

describe('buildLogRecord', () => {
  test('carries requestId, workspaceId, actorId, route and durationMs', () => {
    const record = buildLogRecord({
      event: 'http_request',
      requestId: 'req-123',
      workspaceId: 'ws-abc',
      actorId: 'actor-1',
      route: '/api/v1/website/leads',
      durationMs: 42.7,
    });
    expect(record).toMatchObject({
      event: 'http_request',
      requestId: 'req-123',
      workspaceId: 'ws-abc',
      actorId: 'actor-1',
      route: '/api/v1/website/leads',
      durationMs: 43,
    });
  });

  test('scrubs extra fields before they can reach the log line', () => {
    const record = buildLogRecord({
      event: 'lead_created',
      requestId: 'req-123',
      route: '/api/v1/website/leads',
      extra: { email: 'jane@example.com', leadId: 'lead-1' },
    });
    expect(record.email).toBe('[redacted]');
    expect(record.leadId).toBe('lead-1');
  });

  test('falls back to safe defaults for missing or malformed identifiers', () => {
    const record = buildLogRecord({
      event: 'weird event!',
      requestId: 'has spaces',
      route: '/ok',
    });
    expect(record.event).toBe('unknown_event');
    expect(record.requestId).toBe('unknown');
    expect(record.workspaceId).toBe('unknown');
    expect(record.actorId).toBe('unknown');
  });
});

describe('buildErrorEvent / FakeErrorTracker', () => {
  test('captured event carries the request id and no PII from the error message', () => {
    const tracker = new FakeErrorTracker();
    const error = new Error('Failed to email jane@example.com about order CP-1029');
    tracker.captureException(error, {
      requestId: 'req-999',
      workspaceId: 'ws-1',
      actorId: 'actor-1',
      route: '/api/v1/orders',
      release: 'abc1234',
      environment: 'production',
    });

    expect(tracker.events).toHaveLength(1);
    const event = tracker.events[0]!;
    expect(event.tags.requestId).toBe('req-999');
    expect(event.tags.workspaceId).toBe('ws-1');
    expect(event.tags.route).toBe('/api/v1/orders');
    expect(event.release).toBe('abc1234');
    expect(event.exception.values[0].value).not.toContain('jane@example.com');
    expect(event.exception.values[0].value).toContain('[redacted]');
  });

  test('non-Error throws are still captured safely', () => {
    const event = buildErrorEvent('plain string failure', {
      requestId: 'req-1',
      release: 'v1',
    });
    expect(event.exception.values[0].type).toBe('Error');
    expect(event.exception.values[0].value).toContain('plain string failure');
  });
});
