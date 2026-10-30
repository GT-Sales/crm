import { describe, expect, it } from 'vitest';

import { BackendError, createBackendClient, type BackendClient } from './index';

const UUID = '00000000-0000-4000-8000-000000000001';

interface Captured {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
}

/** Builds a client whose fetch records the request and returns a canned response. */
function harness(status: number, body: unknown) {
  const calls: Captured[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = createBackendClient({
    baseUrl: 'https://api.example.test',
    credential: 'gtsk_test',
    fetch: fetchImpl,
  });
  return { client, calls };
}

const leadCreateBody = {
  leadType: 'sim_order',
  contact: { email: 'a@b.co' },
  consentVersion: 'terms-2026-09',
};

describe('createBackendClient transport', () => {
  it('reads a personal draft using the grant header without a proof or body', async () => {
    const draft = {
      leadId: UUID,
      leadType: 'sim_order',
      contact: { fullName: 'Saved' },
      form: null,
    };
    const { client, calls } = harness(200, { draft, requestId: UUID });
    expect(await client.leads.read(UUID, { draftGrant: 'private-grant' })).toEqual({
      draft,
      requestId: UUID,
    });
    expect(calls[0]?.headers.get('x-draft-grant')).toBe('private-grant');
    expect(calls[0]?.headers.has('x-turnstile-token')).toBe(false);
    expect(calls[0]?.body).toBeUndefined();
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe(`https://api.example.test/api/v1/website/leads/${UUID}`);
  });
  it('sends a bearer credential, JSON accept and a request id, and validates the response', async () => {
    const { client, calls } = harness(200, { ok: true, requestId: UUID });
    const result = await client.health();
    expect(result).toEqual({ ok: true, requestId: UUID });

    const call = calls[0];
    expect(call?.url).toBe('https://api.example.test/api/v1/health');
    expect(call?.headers.get('authorization')).toBe('Bearer gtsk_test');
    expect(call?.headers.get('accept')).toBe('application/json');
    expect(call?.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('serialises a JSON body with content-type on writes', async () => {
    const { client, calls } = harness(201, {
      lead: {
        id: UUID,
        workspaceId: UUID,
        status: 'incomplete',
        externalRef: null,
        updatedAt: '2026-09-14T00:00:00.000Z',
      },
      draftGrant: { token: 't', expiresAt: '2026-09-14T00:00:00.000Z' },
      requestId: UUID,
    });
    await client.leads.create(leadCreateBody);
    const call = calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(call?.body ?? '{}')).toEqual(leadCreateBody);
  });

  it('attaches the draft grant as a header when resuming a draft', async () => {
    const { client, calls } = harness(200, {
      lead: {
        id: UUID,
        workspaceId: UUID,
        status: 'incomplete',
        externalRef: null,
        updatedAt: '2026-09-14T00:00:00.000Z',
      },
      requestId: UUID,
    });
    await client.leads.update(
      UUID,
      { contact: { fullName: 'A B' } },
      { draftGrant: 'grant-token' },
    );
    const call = calls[0];
    expect(call?.method).toBe('PATCH');
    expect(call?.url).toBe(`https://api.example.test/api/v1/website/leads/${UUID}`);
    expect(call?.headers.get('x-draft-grant')).toBe('grant-token');
  });

  it('sends the Idempotency-Key header on create and update only when given', async () => {
    const summary = {
      id: UUID,
      workspaceId: UUID,
      status: 'submitted',
      externalRef: 'MS-153',
      updatedAt: '2026-09-14T00:00:00.000Z',
    };
    const created = harness(201, { lead: summary, draftGrant: null, requestId: UUID });
    await created.client.leads.create(leadCreateBody);
    await created.client.leads.create(leadCreateBody, {
      turnstileToken: 'proof',
      idempotencyKey: 'cp_9f2c:retry.1',
    });
    expect(created.calls[0]?.headers.has('idempotency-key')).toBe(false);
    expect(created.calls[1]?.headers.get('idempotency-key')).toBe('cp_9f2c:retry.1');
    expect(created.calls[1]?.headers.get('x-turnstile-token')).toBe('proof');

    const updated = harness(200, { lead: summary, replayed: true, requestId: UUID });
    await updated.client.leads.update(UUID, { submit: true }, { draftGrant: 'g' });
    const replay = await updated.client.leads.update(
      UUID,
      { submit: true },
      { draftGrant: 'g', idempotencyKey: 'cp_9f2c:retry.1' },
    );
    expect(updated.calls[0]?.headers.has('idempotency-key')).toBe(false);
    expect(updated.calls[1]?.headers.get('idempotency-key')).toBe('cp_9f2c:retry.1');
    expect(replay.replayed).toBe(true);
  });

  it('refuses a malformed idempotency key before sending', async () => {
    const { client, calls } = harness(201, {});
    expect(() => client.leads.create(leadCreateBody, { idempotencyKey: 'short' })).toThrow();
    expect(calls).toHaveLength(0);
  });

  it('calls the email settings, template and automation endpoints', async () => {
    const settings = {
      fromName: 'Get Canada Sim',
      fromAddress: 'orders@example.com',
      replyTo: null,
      logoUrl: null,
      siteUrl: null,
    };
    const saved = await harness(200, {
      settings: {
        ...settings,
        brandColor: '#d72638',
        footerText: '',
        updatedAt: '2026-10-30T12:00:00.000Z',
        updatedBy: UUID,
      },
      fallback: null,
      requestId: UUID,
    });
    await saved.client.staff.getEmailSettings(UUID);
    await saved.client.staff.updateEmailSettings(UUID, settings);
    expect(saved.calls.map((call) => [call.method, call.url])).toEqual([
      ['GET', `https://api.example.test/api/v1/staff/workspaces/${UUID}/email/settings`],
      ['PUT', `https://api.example.test/api/v1/staff/workspaces/${UUID}/email/settings`],
    ]);
    expect(JSON.parse(saved.calls[1]?.body ?? '{}')).toEqual({
      ...settings,
      brandColor: '#d72638',
      footerText: '',
    });

    const template = {
      key: 'dispatched',
      subject: 'On its way',
      body: 'Hi {first name}',
      version: 1,
      updatedAt: '2026-10-30T12:00:00.000Z',
      updatedBy: UUID,
    };
    const templates = harness(200, { template, requestId: UUID });
    await templates.client.staff.updateEmailTemplate(UUID, 'dispatched', {
      expectedVersion: 0,
      subject: 'On its way',
      body: 'Hi {first name}',
    });
    expect(templates.calls[0]?.method).toBe('PUT');
    expect(templates.calls[0]?.url).toBe(
      `https://api.example.test/api/v1/staff/workspaces/${UUID}/email/templates/dispatched`,
    );

    const rule = {
      key: 'order_received',
      label: 'When an order is submitted on the website → send the Order received email',
      trigger: { kind: 'lead_submitted', leadTypes: ['sim_order'] },
      action: { kind: 'send_email', template: 'order_received' },
      enabled: true,
      lastRunAt: null,
      runCount: 0,
    };
    const automations = harness(200, { automation: rule, requestId: UUID });
    await automations.client.staff.updateAutomation(UUID, 'order_received', { enabled: true });
    expect(automations.calls[0]?.method).toBe('PUT');
    expect(automations.calls[0]?.url).toBe(
      `https://api.example.test/api/v1/staff/workspaces/${UUID}/automations/order_received`,
    );
    expect(JSON.parse(automations.calls[0]?.body ?? '{}')).toEqual({ enabled: true });

    const runs = harness(200, { runs: [], requestId: UUID });
    await runs.client.staff.listAutomationRuns(UUID, 'order_received');
    expect(runs.calls[0]?.url).toBe(
      `https://api.example.test/api/v1/staff/workspaces/${UUID}/automations/order_received/runs`,
    );

    const preview = harness(200, { subject: 'S', html: '<p>x</p>', text: 'x', requestId: UUID });
    await preview.client.staff.previewEmailTemplate(UUID, 'dispatched', {
      subject: 'S',
      body: 'B',
    });
    expect(preview.calls[0]?.method).toBe('POST');
    expect(preview.calls[0]?.url).toBe(
      `https://api.example.test/api/v1/staff/workspaces/${UUID}/email/templates/dispatched/preview`,
    );

    const test = harness(202, { queued: true, requestId: UUID });
    await test.client.staff.sendTestEmail(UUID, 'dispatched');
    expect(test.calls[0]?.method).toBe('POST');
    expect(test.calls[0]?.url).toBe(
      `https://api.example.test/api/v1/staff/workspaces/${UUID}/email/templates/dispatched/test`,
    );
    expect(test.calls[0]?.body).toBeUndefined();
  });

  it('throws a BackendError carrying the code and request id from the error envelope', async () => {
    const { client } = harness(409, {
      error: { code: 'draft_already_submitted', message: 'submitted', requestId: UUID },
    });
    await expect(
      client.leads.update(UUID, { contact: { fullName: 'A B' } }, { draftGrant: 'g' }),
    ).rejects.toMatchObject({
      name: 'BackendError',
      code: 'draft_already_submitted',
      status: 409,
      requestId: UUID,
    });
  });

  it('carries the error envelope details on the BackendError', async () => {
    const { client } = harness(409, {
      error: {
        code: 'property_in_use',
        message: 'in use',
        requestId: UUID,
        details: { leadCount: 3 },
      },
    });
    await expect(client.health()).rejects.toMatchObject({
      code: 'property_in_use',
      details: { leadCount: 3 },
    });
  });

  it('rejects a 200 response that does not match the contract', async () => {
    const { client } = harness(200, { ok: 'yes' });
    await expect(client.health()).rejects.toThrow();
  });

  it('falls back to internal_error when the error body is unparseable', async () => {
    const { client } = harness(500, { unexpected: true });
    await expect(client.health()).rejects.toBeInstanceOf(BackendError);
  });

  /** A client whose fetch answers with a raw (non-JSON) body. */
  function rawClient(response: () => Response) {
    return createBackendClient({
      baseUrl: 'https://api.example.test',
      credential: 'gtsk_test',
      fetch: async () => response(),
    });
  }

  it('turns an HTML 404 into a BackendError with the real status, not a SyntaxError', async () => {
    const client = rawClient(
      () =>
        new Response('<html>Cannot GET /api/v1/health</html>', {
          status: 404,
          headers: { 'content-type': 'text/html' },
        }),
    );
    const error: unknown = await client.health().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(BackendError);
    expect(error).toMatchObject({ code: 'internal_error', status: 404 });
  });

  it('turns an empty edge 502 into a BackendError carrying the sent request id', async () => {
    const client = rawClient(() => new Response('', { status: 502 }));
    const error: unknown = await client.health().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(BackendError);
    expect(error).toMatchObject({
      status: 502,
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  it('keeps transport failures distinct from HTTP answers so callers can retry safely', async () => {
    const client = createBackendClient({
      baseUrl: 'https://api.example.test',
      credential: 'gtsk_test',
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    const error: unknown = await client.health().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(BackendError);
  });
});

/**
 * Compile-time proof that method types are derived from the schemas: a schema
 * change breaks these call sites at build time. Never executed; each call is a
 * single line so the `@ts-expect-error` covers the offending token.
 */
function _typeContracts(c: BackendClient): void {
  // @ts-expect-error leadType must be a string, not a number
  void c.leads.create({ leadType: 1, consentVersion: 'v1' });
  // @ts-expect-error `teleport` is not a review decision
  void c.staff.reviewFile('w', 'f', { decision: 'teleport' });
}

describe('website proof transport', () => {
  it('forwards a fresh proof per call in a fixed header, without putting it in the body', async () => {
    const { client, calls } = harness(201, {
      lead: {
        id: UUID,
        workspaceId: UUID,
        status: 'incomplete',
        externalRef: null,
        updatedAt: '2026-09-14T00:00:00.000Z',
      },
      draftGrant: { token: 't', expiresAt: '2026-09-14T00:00:00.000Z' },
      requestId: UUID,
    });
    for (const turnstileToken of ['proof-first', 'proof-second']) {
      await client.leads.create(leadCreateBody, { turnstileToken });
    }
    expect(calls.map((entry) => entry.headers.get('x-turnstile-token'))).toEqual([
      'proof-first',
      'proof-second',
    ]);
    expect(calls.every((entry) => !entry.body?.includes('proof-'))).toBe(true);
    expect(() =>
      client.leads.create(leadCreateBody, { turnstileToken: 'x'.repeat(2049) }),
    ).toThrow();
    expect(calls).toHaveLength(2);
  });
  it('adds only a validated server-owned visitor assertion', async () => {
    const requests: Headers[] = [];
    let assertion = 'a'.repeat(64);
    const client = createBackendClient({
      baseUrl: 'https://api.example.test',
      credential: 'synthetic',
      websiteVisitorId: async () => assertion,
      fetch: async (_url, options) => {
        requests.push(new Headers(options?.headers));
        return Response.json({ ok: true, requestId: UUID });
      },
    });
    await client.health();
    expect(requests[0]?.get('x-website-visitor-id')).toBe(assertion);
    assertion = 'untrusted-header';
    await expect(client.health()).rejects.toThrow('Invalid website visitor assertion');
    expect(requests).toHaveLength(1);
  });
});

describe('createBackendClient ID step', () => {
  // A made-up number that passes the Luhn check, never a real person's.
  const sin = {
    idType: 'sin',
    sin: '046454286',
    dateOfBirth: '1990-01-31',
    creditCheckConsent: true,
  } as const;

  it('sends a SIN to the lead it belongs to and never sends one that fails its check', async () => {
    const { client, calls } = harness(201, {
      identity: { id: UUID, idType: 'sin', createdAt: '2026-10-27T12:00:00.000Z' },
      requestId: UUID,
    });
    await client.leads.submitIdentity(UUID, sin);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe(`https://api.example.test/api/v1/website/leads/${UUID}/identity`);

    expect(() => client.leads.submitIdentity(UUID, { ...sin, sin: '046454287' })).toThrow();
    expect(calls).toHaveLength(1);
  });

  it('asks for a licence upload and reveals a SIN at their own paths', async () => {
    const upload = harness(201, {
      uploadId: UUID,
      url: 'https://storage.example.test/put',
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg' },
      expiresAt: '2026-10-27T12:10:00.000Z',
      requestId: UUID,
    });
    await upload.client.leads.createIdentityUpload(UUID, {
      contentType: 'image/jpeg',
      sizeBytes: 10,
    });
    expect(upload.calls[0]?.url).toBe(
      `https://api.example.test/api/v1/website/leads/${UUID}/identity/uploads`,
    );

    const reveal = harness(200, { sin: '046454286', requestId: UUID });
    expect(await reveal.client.staff.revealLeadIdentity(UUID, UUID, UUID)).toEqual({
      sin: '046454286',
      requestId: UUID,
    });
    expect(reveal.calls[0]?.method).toBe('POST');
    expect(reveal.calls[0]?.url).toBe(
      `https://api.example.test/api/v1/staff/workspaces/${UUID}/leads/${UUID}/identities/${UUID}/reveal`,
    );
  });
});

describe('property client methods', () => {
  const layout = {
    object: 'plan',
    leadType: '',
    layout: { sections: [{ id: 'main', label: 'Main', keys: [] }] },
    version: 1,
    updatedAt: '2026-10-30T00:00:00.000Z',
  };

  it('sends object=plan when asked and nothing for leads', async () => {
    const model = {
      properties: [],
      layouts: {},
      capabilities: { canManage: true },
      requestId: UUID,
    };
    const plan = harness(200, model);
    await plan.client.staff.getPropertyModel(UUID, { object: 'plan' });
    expect(plan.calls[0]?.url).toBe(
      `https://api.example.test/api/v1/staff/workspaces/${UUID}/properties?object=plan`,
    );
    const lead = harness(200, model);
    await lead.client.staff.getPropertyModel(UUID);
    expect(lead.calls[0]?.url).toBe(
      `https://api.example.test/api/v1/staff/workspaces/${UUID}/properties`,
    );

    const removed = harness(200, { key: 'custom_network', requestId: UUID });
    await removed.client.staff.deleteProperty(UUID, 'custom_network', { object: 'plan' });
    expect(removed.calls[0]?.url).toBe(
      `https://api.example.test/api/v1/staff/workspaces/${UUID}/properties/custom_network?object=plan`,
    );
  });

  it('saves the plan layout under no lead type', async () => {
    const saved = harness(200, { layout, requestId: UUID });
    await saved.client.staff.savePropertyLayout(
      UUID,
      '',
      { layout: layout.layout },
      { object: 'plan' },
    );
    expect(saved.calls[0]?.method).toBe('PATCH');
    expect(saved.calls[0]?.url).toBe(
      `https://api.example.test/api/v1/staff/workspaces/${UUID}/properties/layouts/?object=plan`,
    );
  });
});
