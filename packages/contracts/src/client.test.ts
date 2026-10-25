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

const leadCreateBody = { contact: { email: 'a@b.co' }, consentVersion: 'terms-2026-09' };

describe('createBackendClient transport', () => {
  it('reads a personal draft using the grant header without a proof or body', async () => {
    const draft = { leadId: UUID, productId: null, contact: { fullName: 'Saved' }, form: null };
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
  // @ts-expect-error productId must be a string, not a number
  void c.leads.create({ productId: 1 });
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
