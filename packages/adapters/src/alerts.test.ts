import { describe, expect, test, vi } from 'vitest';

import {
  createOwnerAlertChannelFromEnv,
  EmailOwnerAlertChannel,
  FakeOwnerAlertChannel,
  MultiOwnerAlertChannel,
  NoopOwnerAlertChannel,
  ownerAlertKinds,
  WebhookOwnerAlertChannel,
} from './alerts.js';

const alert = {
  kind: 'synthetic_check_failed' as const,
  detail: 'order_step_failed',
  occurredAt: '2026-09-21T00:00:00.000Z',
};

function requestBody(init: RequestInit | undefined): unknown {
  const body = init?.body;
  if (typeof body !== 'string') throw new Error('expected a string request body');
  return JSON.parse(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('expected an object');
  return value;
}

function requestHeaders(init: RequestInit | undefined): Record<string, string> {
  if (!isRecord(init?.headers)) throw new Error('expected a plain headers object');
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(init.headers)) {
    headers[key] = String(value);
  }
  return headers;
}

describe('EmailOwnerAlertChannel', () => {
  test('sends an email via the Resend HTTP API', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'email-1' }),
    });
    const channel = new EmailOwnerAlertChannel({
      apiKey: 'key',
      ownerEmail: 'owner@example.test',
      fromAddress: 'alerts@example.test',
      fromName: 'GT Sales CRM Alerts',
      fetchImpl,
    });
    await channel.send(alert);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0]!;
    const body = asRecord(requestBody(init));
    expect(body.to).toEqual(['owner@example.test']);
    expect(body.subject).toContain('intake check failed');
  });

  test('names the intake check all-clear', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'email-2' }),
    });
    const channel = new EmailOwnerAlertChannel({
      apiKey: 'key',
      ownerEmail: 'owner@example.test',
      fromAddress: 'alerts@example.test',
      fromName: 'GT Sales CRM Alerts',
      fetchImpl,
    });
    expect(ownerAlertKinds).toContain('synthetic_check_recovered');
    await channel.send({ ...alert, kind: 'synthetic_check_recovered', detail: 'failed_runs:3' });
    const [, init] = fetchImpl.mock.calls[0]!;
    const body = asRecord(requestBody(init));
    expect(body.subject).toBe('GT Sales CRM: intake check passing again');
    expect(body.text).toContain('Detail: failed_runs:3');
  });

  test('throws when the provider responds with an error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const channel = new EmailOwnerAlertChannel({
      apiKey: 'key',
      ownerEmail: 'owner@example.test',
      fromAddress: 'alerts@example.test',
      fromName: 'Alerts',
      fetchImpl,
    });
    await expect(channel.send(alert)).rejects.toThrow();
  });
});

describe('WebhookOwnerAlertChannel', () => {
  test('signs the body when a secret is configured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const channel = new WebhookOwnerAlertChannel({
      url: 'https://hooks.example.test/alert',
      signingSecret: 'a-secret-at-least-this-long',
      fetchImpl,
    });
    await channel.send(alert);
    const [, init] = fetchImpl.mock.calls[0]!;
    const headers = requestHeaders(init);
    expect(headers['X-Alert-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});

describe('MultiOwnerAlertChannel', () => {
  test('succeeds when at least one channel delivers', async () => {
    const good = new FakeOwnerAlertChannel();
    const bad: { send: () => Promise<void> } = { send: () => Promise.reject(new Error('down')) };
    const multi = new MultiOwnerAlertChannel([good, bad]);
    await expect(multi.send(alert)).resolves.toBeUndefined();
    expect(good.sent).toHaveLength(1);
  });

  test('throws only when every channel fails', async () => {
    const bad: { send: () => Promise<void> } = { send: () => Promise.reject(new Error('down')) };
    const multi = new MultiOwnerAlertChannel([bad, bad]);
    await expect(multi.send(alert)).rejects.toThrow();
  });
});

describe('createOwnerAlertChannelFromEnv', () => {
  test('returns a no-op channel when nothing is configured', async () => {
    const channel = createOwnerAlertChannelFromEnv({ env: {} });
    expect(channel).toBeInstanceOf(NoopOwnerAlertChannel);
    await expect(channel.send(alert)).resolves.toBeUndefined();
  });

  test('wires the email channel from env', () => {
    const channel = createOwnerAlertChannelFromEnv({
      env: {
        OWNER_ALERT_EMAIL: 'owner@example.test',
        RESEND_API_KEY: 'key',
        RESEND_FROM_EMAIL: 'alerts@example.test',
        RESEND_FROM_NAME: 'Alerts',
      },
    });
    expect(channel).toBeInstanceOf(EmailOwnerAlertChannel);
  });

  test('wires both channels when a webhook is also configured', () => {
    const channel = createOwnerAlertChannelFromEnv({
      env: {
        OWNER_ALERT_EMAIL: 'owner@example.test',
        RESEND_API_KEY: 'key',
        RESEND_FROM_EMAIL: 'alerts@example.test',
        RESEND_FROM_NAME: 'Alerts',
        OWNER_ALERT_WEBHOOK_URL: 'https://hooks.example.test/alert',
      },
    });
    expect(channel).toBeInstanceOf(MultiOwnerAlertChannel);
  });
});
