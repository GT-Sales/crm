import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiErrorResponseSchema,
  emailSettingsResponseSchema,
  emailTemplateResponseSchema,
  previewEmailTemplateResponseSchema,
  sendTestEmailResponseSchema,
  type StaffWorkspace,
} from '@gt-sales/contracts';
import type { DatabaseClient, TenantTransaction } from '@gt-sales/db';
import type { StaffRoleName } from '@gt-sales/types';

import { createApp } from '../src/app.js';
import type { StaffSessionVerifier, VerifiedStaffSession } from '../src/auth/session.js';
import type { ComposeOutcome } from '../src/email/compose.js';
import type { CustomerEmail, CustomerEmailEnvironment } from '../src/email/senders.js';
import type {
  EmailSettingsStore,
  StoredEmailSettings,
  StoredEmailTemplate,
} from '../src/email/settings-store.js';
import type { LeadStore } from '../src/leads/store.js';
import type { StaffAccessSnapshot } from '../src/staff/authorization.js';
import type { StaffStore } from '../src/staff/store.js';
import type { WebsiteCredentialStore } from '../src/website/store.js';

const compose = vi.hoisted(() => vi.fn());
const queue = vi.hoisted(() => vi.fn());
vi.mock('../src/email/compose.js', () => ({ composeCustomerEmail: compose }));
vi.mock('../src/email/queue.js', () => ({ queueComposedEmail: queue }));

const ACTOR = '20000000-0000-4000-8000-000000000d13';
const WORKSPACE = '10000000-0000-4000-8000-000000000d13';
const MEMBERSHIP = '30000000-0000-4000-8000-000000000d13';
const NOW = new Date('2026-10-30T12:34:56.000Z');
const VERIFIED_EMAIL = 'owner@example.test';

const workspace: StaffWorkspace = {
  id: WORKSPACE,
  slug: 'getcanadasim',
  name: 'Get Canada Sim',
  membershipId: MEMBERSHIP,
  roles: ['owner'],
};

class TokenVerifier implements StaffSessionVerifier {
  readonly sessions = new Map<string, VerifiedStaffSession>([
    ['token', { actorId: ACTOR, verifiedEmail: VERIFIED_EMAIL }],
  ]);
  async verify(accessToken: string) {
    return this.sessions.get(accessToken);
  }
}

class MemoryStaffStore implements StaffStore {
  access: StaffAccessSnapshot = {
    membershipId: MEMBERSHIP,
    status: 'active',
    roles: ['owner'],
    permissions: [],
  };
  setDisplayName = vi.fn(async () => 1);
  async bootstrapStaff() {
    return [workspace];
  }
  async loadStaffAccess(actorId: string, workspaceId: string) {
    return actorId === ACTOR && workspaceId === WORKSPACE ? this.access : undefined;
  }
  async inviteStaff(): Promise<string> {
    throw new Error('unused');
  }
  async revokeStaff() {
    return 'not_found' as const;
  }
  async listAssignableMembers() {
    return [];
  }
}

// A lead read would go through the lead stores; none of them may be reached.
const leadStore: LeadStore = {
  readLead: vi.fn(async () => ({ status: 'grant_invalid' as const })),
  createLead: vi.fn(),
  updateLead: vi.fn(),
  listLeads: vi.fn(),
};

const noopCredentialStore: WebsiteCredentialStore = {
  createCredential: async () => {
    throw new Error('unused');
  },
  listCredentials: async () => [],
  revokeCredential: async () => ({ status: 'not_found' }),
};

const settings: StoredEmailSettings = {
  fromName: 'Get Canada Sim',
  fromAddress: 'hello@getcanadasim.example',
  replyTo: null,
  logoUrl: null,
  brandColor: '#0a7f4f',
  footerText: 'Get Canada Sim, Toronto',
  siteUrl: 'https://getcanadasim.example',
  updatedAt: NOW,
  updatedBy: ACTOR,
};

const template: StoredEmailTemplate = {
  key: 'order_received',
  subject: 'We got your order',
  body: 'Hi {first name},\n\nThanks.',
  version: 3,
  updatedAt: NOW,
  updatedBy: ACTOR,
};

function memoryEmailStore() {
  return {
    getSettings: vi.fn<EmailSettingsStore['getSettings']>(async () => settings),
    putSettings: vi.fn<EmailSettingsStore['putSettings']>(async () => settings),
    listTemplates: vi.fn<EmailSettingsStore['listTemplates']>(async () => [template]),
    putTemplate: vi.fn<EmailSettingsStore['putTemplate']>(async () => ({
      kind: 'saved',
      template,
    })),
  } satisfies EmailSettingsStore;
}

const environment: CustomerEmailEnvironment = {
  providerReady: true,
  contactHash: () => 'hash',
  fallbackSenders: { forWorkspace: () => undefined },
};

function customerEmailWith(
  fallback: ReturnType<CustomerEmail['fallback']> = undefined,
): CustomerEmail {
  return {
    environment,
    available: async () => true,
    fallback: () => fallback,
  };
}

// Compose and queue are mocked, so the transaction is only passed through.
const fakeTx: TenantTransaction = Object.create(null);
const withTenantTx: DatabaseClient['withTenantTx'] = vi.fn(async (_ctx, fn) => fn(fakeTx));

let server: Server;
let baseUrl: string;
let staff: MemoryStaffStore;
let emails: ReturnType<typeof memoryEmailStore>;

async function start(customerEmail: CustomerEmail) {
  staff = new MemoryStaffStore();
  emails = memoryEmailStore();
  server = createApp({
    staff: {
      sessionVerifier: new TokenVerifier(),
      store: staff,
      credentialStore: noopCredentialStore,
      leadStore,
      emailSettingsStore: emails,
      customerEmail,
      withTenantTx,
    },
  }).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected TCP server');
  baseUrl = `http://127.0.0.1:${address.port}`;
}

beforeEach(async () => {
  compose.mockReset();
  queue.mockReset();
  vi.mocked(withTenantTx).mockClear();
  vi.mocked(leadStore.readLead).mockClear();
  await start(customerEmailWith());
});

afterEach(async () => {
  vi.useRealTimers();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const emailUrl = (suffix: string) =>
  `${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/email${suffix}`;

function call(url: string, init: { method?: string; body?: unknown } = {}) {
  return fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      authorization: 'Bearer token',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function errorOf(response: Response) {
  return apiErrorResponseSchema.parse(await response.json()).error;
}

const asRole = (role: StaffRoleName) => {
  staff.access = { ...staff.access, roles: [role] };
};

const settingsBody = {
  fromName: 'Get Canada Sim',
  fromAddress: 'hello@getcanadasim.example',
  replyTo: null,
  logoUrl: null,
  brandColor: '#0A7F4F',
  footerText: 'Get Canada Sim, Toronto',
  siteUrl: 'https://getcanadasim.example',
};
const templateBody = { expectedVersion: 3, subject: 'We got your order', body: 'Hi {first name}' };

const routes = [
  ['GET settings', '/settings', 'GET', undefined],
  ['PUT settings', '/settings', 'PUT', settingsBody],
  ['GET templates', '/templates', 'GET', undefined],
  ['PUT template', '/templates/order_received', 'PUT', templateBody],
  [
    'POST preview',
    '/templates/order_received/preview',
    'POST',
    { subject: 'Hi', body: 'Hi {first name}' },
  ],
  ['POST test', '/templates/order_received/test', 'POST', undefined],
] as const;

describe('staff email settings routes', () => {
  it('every route needs integration.manage: owner allowed, orders refused', async () => {
    compose.mockResolvedValue({ kind: 'skipped', reason: 'no_sender' } satisfies ComposeOutcome);
    for (const [name, suffix, method, body] of routes) {
      asRole('orders');
      const refused = await call(emailUrl(suffix), { method, body });
      expect(refused.status, `${name} as orders`).toBe(403);
      expect((await errorOf(refused)).code).toBe('permission_denied');

      asRole('owner');
      const allowed = await call(emailUrl(suffix), { method, body });
      expect(allowed.status, `${name} as owner`).not.toBe(403);
      expect(allowed.status, `${name} as owner`).toBeLessThan(500);
    }
    expect(emails.putSettings).toHaveBeenCalledTimes(1);
    expect(emails.putTemplate).toHaveBeenCalledTimes(1);
    expect(compose).toHaveBeenCalledTimes(1);
  });

  it('PUT settings passes the parsed form, with the actor, and refuses a non-https logo', async () => {
    const response = await call(emailUrl('/settings'), { method: 'PUT', body: settingsBody });
    expect(response.status).toBe(200);
    expect(emailSettingsResponseSchema.parse(await response.json()).settings?.fromName).toBe(
      'Get Canada Sim',
    );
    expect(emails.putSettings).toHaveBeenCalledWith(
      { workspaceId: WORKSPACE, actorId: ACTOR, requestId: expect.any(String) },
      { ...settingsBody, brandColor: '#0a7f4f' },
    );

    for (const body of [
      { ...settingsBody, logoUrl: 'http://logo.example/logo.png' },
      { ...settingsBody, siteUrl: 'http://getcanadasim.example' },
      { ...settingsBody, fromAddress: 'nope' },
      { ...settingsBody, extra: true },
    ]) {
      const bad = await call(emailUrl('/settings'), { method: 'PUT', body });
      expect(bad.status).toBe(400);
      expect((await errorOf(bad)).code).toBe('invalid_request');
    }
    expect(emails.putSettings).toHaveBeenCalledTimes(1);
  });

  it('GET settings is null with the deployment sender until the owner saves', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await start(
      customerEmailWith({
        fromName: 'Env Sender',
        fromAddress: 'env@example.test',
        siteUrl: 'https://env.example',
      }),
    );
    emails.getSettings.mockResolvedValue(undefined);
    const body = emailSettingsResponseSchema.parse(
      await (await call(emailUrl('/settings'))).json(),
    );
    expect(body.settings).toBeNull();
    expect(body.fallback).toEqual({
      fromName: 'Env Sender',
      fromAddress: 'env@example.test',
      siteUrl: 'https://env.example',
    });
  });

  it('GET templates returns the seven as the store has them', async () => {
    const response = await call(emailUrl('/templates'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.templates).toHaveLength(1);
    expect(body.templates[0]).toEqual({
      key: 'order_received',
      subject: 'We got your order',
      body: 'Hi {first name},\n\nThanks.',
      version: 3,
      updatedAt: NOW.toISOString(),
      updatedBy: ACTOR,
    });
    expect(emails.listTemplates).toHaveBeenCalledWith({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      requestId: expect.any(String),
    });
  });

  it('PUT template maps each outcome and passes expectedVersion', async () => {
    const ok = await call(emailUrl('/templates/order_received'), {
      method: 'PUT',
      body: templateBody,
    });
    expect(ok.status).toBe(200);
    expect(emailTemplateResponseSchema.parse(await ok.json()).template.version).toBe(3);
    expect(emails.putTemplate).toHaveBeenLastCalledWith(
      { workspaceId: WORKSPACE, actorId: ACTOR, requestId: expect.any(String) },
      'order_received',
      templateBody,
    );

    emails.putTemplate.mockResolvedValueOnce({ kind: 'version_conflict' });
    const conflict = await call(emailUrl('/templates/order_received'), {
      method: 'PUT',
      body: templateBody,
    });
    expect(conflict.status).toBe(409);
    expect((await errorOf(conflict)).code).toBe('version_conflict');

    emails.putTemplate.mockResolvedValueOnce({
      kind: 'invalid',
      error: 'invalid_fill_in',
      fillIn: 'tracking nmber',
      where: 'body',
    });
    const fillIn = await call(emailUrl('/templates/order_received'), {
      method: 'PUT',
      body: templateBody,
    });
    expect(fillIn.status).toBe(400);
    const fillInError = await errorOf(fillIn);
    expect(fillInError.code).toBe('invalid_fill_in');
    expect(fillInError.details).toEqual({ fillIn: 'tracking nmber', where: 'body' });

    emails.putTemplate.mockResolvedValueOnce({
      kind: 'invalid',
      error: 'invalid_email_markup',
      reason: 'two_buttons',
    });
    const markup = await call(emailUrl('/templates/order_received'), {
      method: 'PUT',
      body: templateBody,
    });
    expect(markup.status).toBe(400);
    const markupError = await errorOf(markup);
    expect(markupError.code).toBe('invalid_email_markup');
    expect(markupError.details).toEqual({ reason: 'two_buttons' });
  });

  it('PUT template refuses an enabled key, a bad body and an unknown template key', async () => {
    const calls = emails.putTemplate.mock.calls.length;
    for (const body of [
      { ...templateBody, enabled: true },
      { ...templateBody, expectedVersion: -1 },
      { expectedVersion: 1, subject: '', body: 'x' },
    ]) {
      const bad = await call(emailUrl('/templates/order_received'), { method: 'PUT', body });
      expect(bad.status).toBe(400);
      expect((await errorOf(bad)).code).toBe('invalid_request');
    }
    const unknown = await call(emailUrl('/templates/not_a_template'), {
      method: 'PUT',
      body: templateBody,
    });
    expect(unknown.status).toBe(404);
    expect((await errorOf(unknown)).code).toBe('not_found');
    expect(emails.putTemplate).toHaveBeenCalledTimes(calls);
  });

  it('preview renders the posted words with sample values and the site look, never a lead', async () => {
    const response = await call(emailUrl('/templates/order_received/preview'), {
      method: 'POST',
      body: {
        subject: 'Thanks, {first name}',
        body: 'Hi {first name}\n\n[button: Track your order]({tracking link})',
      },
    });
    expect(response.status).toBe(200);
    const body = previewEmailTemplateResponseSchema.parse(await response.json());
    expect(body.subject).toBe('Thanks, Nadia');
    expect(body.text).toContain('Hi Nadia');
    expect(body.html).toContain('Hi Nadia');
    expect(body.html).toContain('#0a7f4f');
    expect(body.html).toContain('>Track your order</a>');
    expect(body.html).toContain('Get Canada Sim');

    expect(withTenantTx).not.toHaveBeenCalled();
    expect(leadStore.readLead).not.toHaveBeenCalled();
    expect(emails.putTemplate).not.toHaveBeenCalled();
  });

  it('preview brands from the deployment sender, else "Your site"', async () => {
    emails.getSettings.mockResolvedValue(undefined);
    const plain = await call(emailUrl('/templates/order_received/preview'), {
      method: 'POST',
      body: { subject: 'Hi', body: 'Welcome to {site name}' },
    });
    expect(previewEmailTemplateResponseSchema.parse(await plain.json()).text).toContain(
      'Welcome to Your site',
    );

    await new Promise<void>((resolve) => server.close(() => resolve()));
    await start(customerEmailWith({ fromName: 'Env Sender', fromAddress: 'env@example.test' }));
    emails.getSettings.mockResolvedValue(undefined);
    const env = await call(emailUrl('/templates/order_received/preview'), {
      method: 'POST',
      body: { subject: 'Hi', body: 'Welcome to {site name}' },
    });
    expect(previewEmailTemplateResponseSchema.parse(await env.json()).text).toContain(
      'Welcome to Env Sender',
    );
  });

  it('preview names a markup error with 400 and refuses an unknown template', async () => {
    const bad = await call(emailUrl('/templates/dispatched/preview'), {
      method: 'POST',
      body: { subject: 'Sent', body: 'Your parcel {tracking nmber}' },
    });
    expect(bad.status).toBe(400);
    const error = await errorOf(bad);
    expect(error.code).toBe('invalid_fill_in');
    expect(error.details).toEqual({ fillIn: 'tracking nmber', where: 'body' });

    const braces = await call(emailUrl('/templates/dispatched/preview'), {
      method: 'POST',
      body: { subject: 'Sent', body: '[Track](https://a.test/t?p={plan})' },
    });
    expect(braces.status).toBe(400);
    const bracesError = await errorOf(braces);
    expect(bracesError.code).toBe('invalid_email_markup');
    expect(bracesError.details).toEqual({ reason: 'bad_link' });

    const label = await call(emailUrl('/templates/dispatched/preview'), {
      method: 'POST',
      body: { subject: 'Sent', body: '[button: Track {frist name}]({tracking link})' },
    });
    expect(label.status).toBe(400);
    expect((await errorOf(label)).details).toEqual({ fillIn: 'frist name', where: 'body' });

    const unknown = await call(emailUrl('/templates/nope/preview'), {
      method: 'POST',
      body: { subject: 'Sent', body: 'x' },
    });
    expect(unknown.status).toBe(404);
    expect(withTenantTx).not.toHaveBeenCalled();
  });

  it('test send composes the saved version to the caller and queues it once a minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-30T12:34:56.000Z'));
    const payload = { template: 'order_received', toAddress: VERIFIED_EMAIL };
    compose.mockResolvedValue({ kind: 'ready', payload });
    queue.mockResolvedValueOnce({ queued: true, jobId: 'job', activity: null });
    queue.mockResolvedValueOnce({ queued: false, jobId: null, activity: null });

    const first = await call(emailUrl('/templates/order_received/test'), { method: 'POST' });
    expect(first.status).toBe(202);
    expect(sendTestEmailResponseSchema.parse(await first.json()).queued).toBe(true);
    expect(compose).toHaveBeenCalledWith(fakeTx, environment, {
      workspaceId: WORKSPACE,
      template: 'order_received',
      recipient: { kind: 'staff_test', toAddress: VERIFIED_EMAIL },
    });
    expect(queue).toHaveBeenLastCalledWith(fakeTx, {
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      requestId: expect.any(String),
      leadId: null,
      dedupeKey: `test:order_received:${ACTOR}:202610301234`,
      payload,
      automation: null,
    });

    const second = await call(emailUrl('/templates/order_received/test'), { method: 'POST' });
    expect(second.status).toBe(202);
    expect(sendTestEmailResponseSchema.parse(await second.json()).queued).toBe(false);
    expect(leadStore.readLead).not.toHaveBeenCalled();
  });

  it('test send is 409 feature_not_ready with no sender or provider, and queues nothing', async () => {
    compose.mockResolvedValue({ kind: 'skipped', reason: 'no_sender' } satisfies ComposeOutcome);
    const response = await call(emailUrl('/templates/order_received/test'), { method: 'POST' });
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe('feature_not_ready');
    expect(queue).not.toHaveBeenCalled();

    const unknown = await call(emailUrl('/templates/nope/test'), { method: 'POST' });
    expect(unknown.status).toBe(404);
    expect(compose).toHaveBeenCalledTimes(1);
  });
});
