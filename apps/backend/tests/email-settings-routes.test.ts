import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiErrorResponseSchema,
  codePropertyCatalog,
  emailSettingsResponseSchema,
  listSiteEmailTemplatesResponseSchema,
  previewEmailTemplateResponseSchema,
  siteEmailTemplateResponseSchema,
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
  ListedEmailTemplate,
  StoredEmailSettings,
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

const template: ListedEmailTemplate = {
  key: 'order_received',
  name: null,
  archived: false,
  subject: 'We got your order',
  body: 'Hi {first name},\n\nThanks.',
  version: 3,
  updatedAt: NOW,
  updatedBy: ACTOR,
  usedBy: [{ key: 'order_received', name: 'Order received email' }],
};

const SITE_MADE = 'tpl_routetemplate001';
const siteMade: ListedEmailTemplate = {
  ...template,
  key: SITE_MADE,
  name: 'Size note',
  subject: 'About {prop:custom_size}',
  version: 1,
  usedBy: [],
};

function memoryEmailStore() {
  return {
    getSettings: vi.fn<EmailSettingsStore['getSettings']>(async () => settings),
    putSettings: vi.fn<EmailSettingsStore['putSettings']>(async () => settings),
    listTemplates: vi.fn<EmailSettingsStore['listTemplates']>(async () => [template]),
    listArchivedTemplates: vi.fn<EmailSettingsStore['listArchivedTemplates']>(async () => ({
      templates: [{ ...siteMade, archived: true }],
      nextBefore: SITE_MADE,
    })),
    putTemplate: vi.fn<EmailSettingsStore['putTemplate']>(async () => ({
      kind: 'saved',
      template,
    })),
    createTemplate: vi.fn<EmailSettingsStore['createTemplate']>(async () => ({
      kind: 'saved',
      template: siteMade,
    })),
    setTemplateArchived: vi.fn<EmailSettingsStore['setTemplateArchived']>(
      async (_ctx, _key, archived) => ({ kind: 'saved', template: { ...siteMade, archived } }),
    ),
  } satisfies EmailSettingsStore;
}

const environment: CustomerEmailEnvironment = {
  providerReady: true,
  contactHash: () => 'hash',
};

function customerEmailWith(): CustomerEmail {
  return { environment, available: async () => true };
}

// Compose and queue are mocked, so the transaction is only passed through.
const fakeTx: TenantTransaction = Object.create(null);
const withTenantTx: DatabaseClient['withTenantTx'] = vi.fn(async (_ctx, fn) => fn(fakeTx));

const loadCatalog = vi.fn(async () => codePropertyCatalog);

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
      loadPropertyCatalog: loadCatalog,
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
  ['POST template', '/templates', 'POST', { name: 'Size note', subject: 'Hi', body: 'Hi' }],
  ['POST archive', `/templates/${SITE_MADE}/archive`, 'POST', undefined],
  ['POST restore', `/templates/${SITE_MADE}/restore`, 'POST', undefined],
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

  it('GET settings is null until the owner saves, with no fallback sender', async () => {
    emails.getSettings.mockResolvedValue(undefined);
    const raw: unknown = await (await call(emailUrl('/settings'))).json();
    expect(raw).not.toHaveProperty('fallback');
    expect(emailSettingsResponseSchema.parse(raw).settings).toBeNull();
  });

  it('GET templates returns them as the store has them, named, with the flows that send them', async () => {
    const response = await call(emailUrl('/templates'));
    expect(response.status).toBe(200);
    const body = listSiteEmailTemplatesResponseSchema.parse(await response.json());
    expect(body.nextBefore).toBeNull();
    expect(body.templates).toEqual([
      {
        key: 'order_received',
        name: 'Order received',
        subject: 'We got your order',
        body: 'Hi {first name},\n\nThanks.',
        version: 3,
        updatedAt: NOW.toISOString(),
        updatedBy: ACTOR,
        archived: false,
        usedBy: [{ key: 'order_received', name: 'Order received email' }],
      },
    ]);
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
    expect(siteEmailTemplateResponseSchema.parse(await ok.json()).template.version).toBe(3);
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
    expect((await errorOf(unknown)).code).toBe('email_template_not_found');
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

  it('preview brands an unsaved site as "Your site"', async () => {
    emails.getSettings.mockResolvedValue(undefined);
    const plain = await call(emailUrl('/templates/order_received/preview'), {
      method: 'POST',
      body: { subject: 'Hi', body: 'Welcome to {site name}' },
    });
    expect(previewEmailTemplateResponseSchema.parse(await plain.json()).text).toContain(
      'Welcome to Your site',
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

  it('POST templates creates a site-made template with the catalogue, and maps each refusal', async () => {
    const body = { name: '  Size note ', subject: 'About {prop:custom_size}', body: 'Hi' };
    const created = await call(emailUrl('/templates'), { method: 'POST', body });
    expect(created.status).toBe(201);
    expect(siteEmailTemplateResponseSchema.parse(await created.json()).template).toMatchObject({
      key: SITE_MADE,
      name: 'Size note',
      archived: false,
      usedBy: [],
    });
    expect(emails.createTemplate).toHaveBeenCalledWith(
      { workspaceId: WORKSPACE, actorId: ACTOR, requestId: expect.any(String) },
      { name: 'Size note', subject: 'About {prop:custom_size}', body: 'Hi' },
      codePropertyCatalog,
    );

    emails.createTemplate.mockResolvedValueOnce({ kind: 'limit_reached' });
    const limit = await call(emailUrl('/templates'), { method: 'POST', body });
    expect(limit.status).toBe(409);
    expect((await errorOf(limit)).code).toBe('email_template_limit_reached');

    emails.createTemplate.mockResolvedValueOnce({
      kind: 'invalid',
      error: 'invalid_fill_in',
      fillIn: 'prop:custom_secret',
      where: 'subject',
    });
    const refused = await call(emailUrl('/templates'), { method: 'POST', body });
    expect(refused.status).toBe(400);
    expect(await errorOf(refused)).toMatchObject({
      code: 'invalid_fill_in',
      details: { fillIn: 'prop:custom_secret', where: 'subject' },
    });

    for (const bad of [
      { ...body, name: '' },
      { ...body, extra: 1 },
      { name: 'x', subject: '' },
    ]) {
      const response = await call(emailUrl('/templates'), { method: 'POST', body: bad });
      expect(response.status).toBe(400);
      expect((await errorOf(response)).code).toBe('invalid_request');
    }
  });

  it('archive and restore map each outcome; the key is checked after the permission', async () => {
    const archived = await call(emailUrl(`/templates/${SITE_MADE}/archive`), { method: 'POST' });
    expect(archived.status).toBe(200);
    expect(siteEmailTemplateResponseSchema.parse(await archived.json()).template.archived).toBe(
      true,
    );
    expect(emails.setTemplateArchived).toHaveBeenLastCalledWith(
      { workspaceId: WORKSPACE, actorId: ACTOR, requestId: expect.any(String) },
      SITE_MADE,
      true,
    );
    const restored = await call(emailUrl(`/templates/${SITE_MADE}/restore`), { method: 'POST' });
    expect(siteEmailTemplateResponseSchema.parse(await restored.json()).template.archived).toBe(
      false,
    );

    for (const [outcome, status, code] of [
      ['builtin', 409, 'email_template_builtin'],
      ['not_found', 404, 'email_template_not_found'],
      ['limit_reached', 409, 'email_template_limit_reached'],
    ] as const) {
      emails.setTemplateArchived.mockResolvedValueOnce({ kind: outcome });
      const response = await call(emailUrl(`/templates/${SITE_MADE}/restore`), { method: 'POST' });
      expect(response.status, outcome).toBe(status);
      expect((await errorOf(response)).code).toBe(code);
    }

    const calls = emails.setTemplateArchived.mock.calls.length;
    asRole('viewer');
    const refused = await call(emailUrl('/templates/nope/archive'), { method: 'POST' });
    expect(refused.status).toBe(403);
    asRole('owner');
    const unknown = await call(emailUrl('/templates/nope/archive'), { method: 'POST' });
    expect(unknown.status).toBe(404);
    expect((await errorOf(unknown)).code).toBe('email_template_not_found');
    expect(emails.setTemplateArchived).toHaveBeenCalledTimes(calls);
  });

  it('GET templates?archived=1 pages the archived site-made templates', async () => {
    const response = await call(emailUrl(`/templates?archived=1&before=${SITE_MADE}`));
    expect(response.status).toBe(200);
    const body = listSiteEmailTemplatesResponseSchema.parse(await response.json());
    expect(body).toMatchObject({
      nextBefore: SITE_MADE,
      templates: [{ key: SITE_MADE, archived: true }],
    });
    expect(emails.listArchivedTemplates).toHaveBeenCalledWith(
      { workspaceId: WORKSPACE, actorId: ACTOR, requestId: expect.any(String) },
      { before: SITE_MADE },
    );
    expect(emails.listTemplates).not.toHaveBeenCalled();
    expect((await call(emailUrl('/templates?archived=yes'))).status).toBe(400);
    expect((await call(emailUrl('/templates?before=dispatched'))).status).toBe(400);
  });

  it('PUT and preview take a site-made key: the save checks it against the catalogue', async () => {
    const saved = await call(emailUrl(`/templates/${SITE_MADE}`), {
      method: 'PUT',
      body: templateBody,
    });
    expect(saved.status).toBe(200);
    expect(emails.putTemplate).toHaveBeenLastCalledWith(
      { workspaceId: WORKSPACE, actorId: ACTOR, requestId: expect.any(String) },
      SITE_MADE,
      templateBody,
      codePropertyCatalog,
    );
    emails.putTemplate.mockResolvedValueOnce({ kind: 'not_found' });
    const gone = await call(emailUrl(`/templates/${SITE_MADE}`), {
      method: 'PUT',
      body: templateBody,
    });
    expect(gone.status).toBe(404);
    expect((await errorOf(gone)).code).toBe('email_template_not_found');

    // A built-in key is saved without reading the catalogue.
    loadCatalog.mockClear();
    await call(emailUrl('/templates/order_received'), { method: 'PUT', body: templateBody });
    expect(loadCatalog).not.toHaveBeenCalled();

    const preview = await call(emailUrl(`/templates/${SITE_MADE}/preview`), {
      method: 'POST',
      body: { subject: 'Your {prop:custom_size}', body: 'Order {order number}' },
    });
    expect(preview.status).toBe(200);
    const rendered = previewEmailTemplateResponseSchema.parse(await preview.json());
    expect(rendered.subject).toBe('Your [custom_size]');
    expect(rendered.text).toContain('Order MS-1042');
  });

  it('a test mail of a site-made template that is gone is 404, one with properties 409', async () => {
    compose.mockResolvedValueOnce({
      kind: 'skipped',
      reason: 'template_unavailable',
    } satisfies ComposeOutcome);
    const gone = await call(emailUrl(`/templates/${SITE_MADE}/test`), { method: 'POST' });
    expect(gone.status).toBe(404);
    expect((await errorOf(gone)).code).toBe('email_template_not_found');

    compose.mockResolvedValueOnce({
      kind: 'skipped',
      reason: 'missing_fill_in',
      missing: ['prop:custom_size'],
    } satisfies ComposeOutcome);
    const props = await call(emailUrl(`/templates/${SITE_MADE}/test`), { method: 'POST' });
    expect(props.status).toBe(409);
    expect(await errorOf(props)).toMatchObject({
      code: 'feature_not_ready',
      details: { reason: 'property_fill_ins' },
    });
    expect(queue).not.toHaveBeenCalled();
  });
});
