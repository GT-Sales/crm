import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiErrorResponseSchema,
  createLeadResponseSchema,
  readLeadResponseSchema,
  updateLeadResponseSchema,
} from '@gt-sales/contracts';
import type { WebsiteCredentialResolution } from '@gt-sales/db';

import { createApp } from '../src/app.js';
import type { StaffSessionVerifier } from '../src/auth/session.js';
import type {
  CreateLeadInput,
  CreateLeadResult,
  LeadStore,
  UpdateLeadInput,
  UpdateLeadOutcome,
} from '../src/leads/store.js';
import {
  IdempotencyError,
  idempotencyKeyHash,
  requestFingerprint,
} from '../src/leads/idempotency.js';
import { OrderIntakeError } from '../src/leads/store.js';
import { checkLeadForm } from '../src/leads/types.js';
import type { StaffStore } from '../src/staff/store.js';
import type { WebsiteCredentialStore } from '../src/website/store.js';
import { generateServiceSecret } from '../src/website/credential.js';

const WORKSPACE = '10000000-0000-4000-8000-000000000301';
const CREDENTIAL = '80000000-0000-4000-8000-000000000301';
const LEAD_A = '90000000-0000-4000-8000-000000000301';
const LEAD_B = '90000000-0000-4000-8000-000000000302';
const VALID_GRANT_A = 'gtdg_valid-grant-for-lead-a';

const { secret: SECRET, secretHash: SECRET_HASH } = generateServiceSecret();

const resolution: WebsiteCredentialResolution = {
  credentialId: CREDENTIAL,
  workspaceId: WORKSPACE,
  scopes: ['leads:write'],
  revoked: false,
};

/**
 * A faithful in-memory re-implementation of the grant-matching rules
 * `DatabaseLeadStore` enforces in SQL: a token must hash-match AND belong to
 * the exact lead in the URL, and must be neither expired nor revoked. This
 * lets the route's handling of each outcome be tested without a live
 * database (see `apps/backend/tests/leads-store.integration.test.ts` for
 * coverage of the real SQL these rules mirror).
 */
class FakeLeadStore implements LeadStore {
  readLead: LeadStore['readLead'] = async () => ({ status: 'grant_invalid' });
  readonly createCalls: CreateLeadInput[] = [];
  readonly updateCalls: UpdateLeadInput[] = [];
  grants = new Map<string, { leadId: string; expiresAt: number; revoked: boolean }>([
    [VALID_GRANT_A, { leadId: LEAD_A, expiresAt: Date.now() + 60_000, revoked: false }],
  ]);
  leadStatus = new Map<string, 'incomplete' | 'submitted'>([
    [LEAD_A, 'incomplete'],
    [LEAD_B, 'incomplete'],
  ]);
  /** The type each lead was created as; the real store reads it from the lead row. */
  leadType = new Map<string, string>([
    [LEAD_A, 'sim_order'],
    [LEAD_B, 'sim_order'],
  ]);

  /** What the next create throws, as the real store does inside its transaction. */
  createError: Error | undefined;
  /** Whether the next create answers as a replay of the first outcome. */
  createReplayed = false;
  /** The order number the store gives a create that names none, as the site counter does. */
  nextExternalRef: string | null = null;
  /** What the next update answers once its grant checks pass. */
  updateOutcome: UpdateLeadOutcome | undefined;

  async createLead(input: CreateLeadInput): Promise<CreateLeadResult> {
    this.createCalls.push(input);
    if (this.createError) throw this.createError;
    if (input.submit) {
      return {
        lead: {
          id: LEAD_A,
          workspaceId: input.workspaceId,
          status: 'submitted',
          externalRef: input.externalRef ?? this.nextExternalRef,
          updatedAt: NOW,
        },
        grant: null,
        replayed: this.createReplayed,
      };
    }
    return {
      lead: {
        id: LEAD_A,
        workspaceId: input.workspaceId,
        status: 'incomplete',
        externalRef: input.externalRef ?? this.nextExternalRef,
        updatedAt: NOW,
      },
      grant: { token: VALID_GRANT_A, expiresAt: new Date(Date.now() + 60_000).toISOString() },
      replayed: this.createReplayed,
    };
  }

  async updateLead(input: UpdateLeadInput): Promise<UpdateLeadOutcome> {
    this.updateCalls.push(input);
    const grant = this.grants.get(input.grantToken);
    if (!grant || grant.leadId !== input.leadId) return { status: 'grant_invalid' };
    if (grant.revoked || grant.expiresAt <= Date.now()) return { status: 'grant_expired' };
    if (this.leadStatus.get(input.leadId) !== 'incomplete') return { status: 'draft_submitted' };
    const form = checkLeadForm(this.leadType.get(input.leadId) ?? '', input.form);
    if (!form.ok) return { status: 'submission_incomplete', problem: form.problem };
    if (this.updateOutcome) return this.updateOutcome;
    return {
      status: 'updated',
      lead: {
        id: input.leadId,
        workspaceId: input.workspaceId,
        status: 'incomplete',
        externalRef: null,
        updatedAt: NOW,
      },
    };
  }

  async listLeads() {
    return { leads: [], page: { page: 1, pageSize: 25, total: 0 } };
  }
}

const NOW = '2026-09-16T00:00:00.000Z';

const staffOnly: {
  sessionVerifier: StaffSessionVerifier;
  store: StaffStore;
  credentialStore: WebsiteCredentialStore;
  leadStore: LeadStore;
} = {
  sessionVerifier: { verify: async () => undefined },
  store: {
    bootstrapStaff: async () => [],
    loadStaffAccess: async () => undefined,
    inviteStaff: async () => {
      throw new Error('unused');
    },
    revokeStaff: async () => 'not_found',
    listAssignableMembers: async () => [],
    setDisplayName: async () => 0,
  },
  credentialStore: {
    createCredential: async () => {
      throw new Error('unused');
    },
    listCredentials: async () => [],
    revokeCredential: async () => ({ status: 'not_found' }),
  },
  leadStore: {
    readLead: async () => ({ status: 'grant_invalid' }),
    createLead: async () => {
      throw new Error('unused');
    },
    updateLead: async () => {
      throw new Error('unused');
    },
    listLeads: async () => ({ leads: [], page: { page: 1, pageSize: 25, total: 0 } }),
  },
};

let server: Server;
let baseUrl: string;
let leadStore: FakeLeadStore;

function request(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${SECRET}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(async () => {
  leadStore = new FakeLeadStore();
  server = createApp({
    staff: staffOnly,
    website: {
      auth: {
        resolveCredential: async (hash) => (hash === SECRET_HASH ? resolution : undefined),
        rateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
        botCheck: async () => true,
      },
      leads: { store: leadStore },
    },
  }).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected TCP server');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const CANADAWIDE_CONTACT = {
  fullName: 'Avery Example',
  email: 'avery@example.test',
  phone: '403 555 0101',
  countryCode: 'CA',
};

const INTERNET_PAYLOAD = {
  planId: 'ab-1gbps',
  planLabel: '1Gbps',
  landingCity: 'calgary',
  dateOfBirth: '1990-04-12',
  streetAddress: '12 Example Street',
  city: 'Calgary',
  postalCode: 'T2P 1J9',
  consent: true,
  consentedAt: '2026-10-26T10:00:00.000Z',
};

const MOBILITY_PAYLOAD = {
  planId: 'cw-100gb',
  planLabel: '100 GB $40',
  lineCount: 2,
  firstName: 'Avery',
  lastName: 'Example',
  keepNumber: true,
  simType: 'esim',
  currentProvider: 'Rogers',
  streetAddress: '12 Example Street',
  city: 'Calgary',
  postalCode: 'T2P 1J9',
};

function oneShot(leadType: string, payload: unknown, extra: Record<string, unknown> = {}) {
  return {
    leadType,
    submit: true,
    contact: CANADAWIDE_CONTACT,
    form: { schemaVersion: 1, payload },
    consentVersion: 'cw-internet-v1',
    ...extra,
  };
}

describe('lead-type registry at intake', () => {
  async function refusal(body: unknown) {
    const response = await request('POST', '/api/v1/website/leads', {}, body);
    expect(response.status).toBe(400);
    const error = apiErrorResponseSchema.parse(await response.json()).error;
    expect(error.code).toBe('validation_error');
    return error.details;
  }

  it('creates a one-shot internet lead submitted, with no draft grant', async () => {
    const response = await request(
      'POST',
      '/api/v1/website/leads',
      {},
      oneShot('internet', INTERNET_PAYLOAD),
    );
    expect(response.status).toBe(201);
    const body = createLeadResponseSchema.parse(await response.json());
    expect(body.lead.status).toBe('submitted');
    expect(body.draftGrant).toBeNull();
    expect(leadStore.createCalls[0]).toMatchObject({ leadType: 'internet', submit: true });
  });

  it('accepts a complete mobility lead', async () => {
    const response = await request(
      'POST',
      '/api/v1/website/leads',
      {},
      oneShot('mobility', MOBILITY_PAYLOAD),
    );
    expect(response.status).toBe(201);
  });

  it('accepts any contact the website itself accepts', async () => {
    const response = await request(
      'POST',
      '/api/v1/website/leads',
      {},
      oneShot('internet', INTERNET_PAYLOAD, {
        contact: {
          ...CANADAWIDE_CONTACT,
          email: "o'brien+promo!@mail.example.ca",
          phone: '+1 (403) 555-0101 ext. 12345, cell',
        },
      }),
    );
    expect(response.status).toBe(201);
  });

  it('refuses a type the registry does not list', async () => {
    expect(await refusal(oneShot('pizza_order', INTERNET_PAYLOAD))).toEqual({
      field: 'leadType',
    });
  });

  it('refuses a one-shot type sent as a resumable draft', async () => {
    expect(await refusal(oneShot('internet', INTERNET_PAYLOAD, { submit: undefined }))).toEqual({
      field: 'submit',
    });
  });

  it('refuses a payload with a missing, wrong or unmodelled field', async () => {
    const { city: _city, ...withoutCity } = INTERNET_PAYLOAD;
    for (const payload of [
      withoutCity,
      { ...INTERNET_PAYLOAD, consent: false },
      { ...INTERNET_PAYLOAD, dateOfBirth: '12/04/1990' },
      { ...INTERNET_PAYLOAD, postalCode: '90210' },
      { ...INTERNET_PAYLOAD, sin: '046454286' },
    ]) {
      expect(await refusal(oneShot('internet', payload))).toEqual({ field: 'form' });
    }
    expect(
      await refusal({
        ...oneShot('internet', INTERNET_PAYLOAD),
        form: { schemaVersion: 2, payload: INTERNET_PAYLOAD },
      }),
    ).toEqual({ field: 'form' });
  });

  it('refuses a modelled lead without the contact it is stored by', async () => {
    expect(
      await refusal({
        ...oneShot('mobility', MOBILITY_PAYLOAD),
        contact: { email: 'a@example.test' },
      }),
    ).toEqual({ field: 'contact' });
  });

  it('never echoes a submitted value in the refusal', async () => {
    const response = await request(
      'POST',
      '/api/v1/website/leads',
      {},
      oneShot('internet', { ...INTERNET_PAYLOAD, dateOfBirth: 'secret-1990' }),
    );
    expect(await response.text()).not.toContain('secret-1990');
    expect(leadStore.createCalls).toHaveLength(0);
  });
});

describe('POST /api/v1/website/leads', () => {
  it('requires a lead type and a consent version', async () => {
    for (const body of [{}, { leadType: 'sim_order' }, { consentVersion: 'terms-2026-09' }]) {
      const response = await request('POST', '/api/v1/website/leads', {}, body);
      expect(response.status).toBe(400);
      expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe(
        'validation_error',
      );
    }
    expect(leadStore.createCalls).toHaveLength(0);
  });

  it('creates a lead and returns a draft grant when consent version is present', async () => {
    const response = await request(
      'POST',
      '/api/v1/website/leads',
      {},
      { leadType: 'sim_order', consentVersion: 'terms-2026-09' },
    );
    expect(response.status).toBe(201);
    const body = createLeadResponseSchema.parse(await response.json());
    expect(body.lead.id).toBe(LEAD_A);
    expect(body.draftGrant?.token).toBe(VALID_GRANT_A);
  });

  it('answers a dropped database connection with a logged, retryable 503', async () => {
    leadStore.createLead = async () => {
      throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await request(
        'POST',
        '/api/v1/website/leads',
        {},
        { leadType: 'sim_order', consentVersion: 'terms-2026-09' },
      );
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('2');
      expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe(
        'persistence_unavailable',
      );
      const records = logged.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(records).toContainEqual(
        expect.objectContaining({
          event: 'request_error',
          route: '/api/v1/website/leads',
          code: 'persistence_unavailable',
        }),
      );
    } finally {
      logged.mockRestore();
    }
  });

  it('logs a non-connection failure and answers a non-retryable 500', async () => {
    leadStore.createLead = async () => {
      throw new Error('unexpected bug');
    };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await request(
        'POST',
        '/api/v1/website/leads',
        {},
        { leadType: 'sim_order', consentVersion: 'terms-2026-09' },
      );
      expect(response.status).toBe(500);
      const records = logged.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(records).toContainEqual(
        expect.objectContaining({ event: 'request_error', code: 'internal_error' }),
      );
      expect(JSON.stringify(records)).not.toContain('unexpected bug');
    } finally {
      logged.mockRestore();
    }
  });

  it('rejects a malformed lead type instead of forwarding it to the store', async () => {
    for (const leadType of ['Sim Order', 'sim-order', '', 'x'.repeat(65)]) {
      const response = await request(
        'POST',
        '/api/v1/website/leads',
        {},
        { consentVersion: 'terms-2026-09', leadType },
      );
      expect(response.status).toBe(400);
    }
    expect(leadStore.createCalls).toHaveLength(0);
  });

  it('forwards the lead type and external reference to the store', async () => {
    const response = await request(
      'POST',
      '/api/v1/website/leads',
      {},
      { leadType: 'sim_order', externalRef: 'MS-1042', consentVersion: 'terms-2026-09' },
    );
    expect(response.status).toBe(201);
    expect(leadStore.createCalls[0]).toMatchObject({
      leadType: 'sim_order',
      externalRef: 'MS-1042',
    });
  });
});

describe('GET /api/v1/website/leads/:leadId', () => {
  it('requires the exact draft grant and does not cache personal data', async () => {
    const draft = {
      leadId: LEAD_A,
      leadType: 'sim_order',
      contact: { fullName: 'Saved customer' },
      form: null,
    };
    leadStore.readLead = async ({ grantToken, leadId }) =>
      grantToken === VALID_GRANT_A && leadId === LEAD_A
        ? { status: 'read', draft }
        : { status: 'grant_invalid' };
    const response = await request('GET', `/api/v1/website/leads/${LEAD_A}`, {
      'x-draft-grant': VALID_GRANT_A,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toMatchObject({ draft });
    const rejectedHeaders: Record<string, string>[] = [
      {},
      { 'x-draft-grant': 'gtdg_forged-grant-000000000' },
      { 'x-draft-grant': VALID_GRANT_A, authorization: 'Bearer invalid' },
    ];
    for (const headers of rejectedHeaders) {
      expect((await request('GET', `/api/v1/website/leads/${LEAD_A}`, headers)).status).toBe(401);
    }
    expect(
      (await request('GET', `/api/v1/website/leads/${LEAD_B}`, { 'x-draft-grant': VALID_GRANT_A }))
        .status,
    ).toBe(401);
  });

  it('returns the plan and quantity a draft order was saved with', async () => {
    const draft = {
      leadId: LEAD_A,
      leadType: 'sim_order',
      contact: { fullName: 'Saved customer' },
      form: null,
      order: { planId: '70000000-0000-4000-8000-000000000001', quantity: 2 },
    };
    leadStore.readLead = async () => ({ status: 'read', draft });
    const response = await request('GET', `/api/v1/website/leads/${LEAD_A}`, {
      'x-draft-grant': VALID_GRANT_A,
    });
    expect(response.status).toBe(200);
    const body = readLeadResponseSchema.parse(await response.json());
    expect(body.draft.order).toEqual({
      planId: '70000000-0000-4000-8000-000000000001',
      quantity: 2,
    });
  });

  it.each(['grant_expired', 'draft_submitted'] as const)(
    'does not expose a %s draft',
    async (status) => {
      leadStore.readLead = async () => ({ status });
      const response = await request('GET', `/api/v1/website/leads/${LEAD_A}`, {
        'x-draft-grant': VALID_GRANT_A,
      });
      expect(response.status).toBe(status === 'grant_expired' ? 401 : 409);
      expect(await response.json()).not.toHaveProperty('draft');
    },
  );
});

describe('PATCH /api/v1/website/leads/:leadId', () => {
  it('fails a forged grant', async () => {
    const response = await request(
      'PATCH',
      `/api/v1/website/leads/${LEAD_A}`,
      { 'x-draft-grant': 'gtdg_totally-forged-1234567890' },
      { contact: { fullName: 'Jane Doe' } },
    );
    expect(response.status).toBe(401);
    expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe('draft_not_found');
  });

  it('fails when the grant header is missing entirely', async () => {
    const response = await request('PATCH', `/api/v1/website/leads/${LEAD_A}`, {}, {});
    expect(response.status).toBe(401);
    expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe('draft_not_found');
    expect(leadStore.updateCalls).toHaveLength(0);
  });

  it('fails a grant that belongs to a different lead', async () => {
    const response = await request(
      'PATCH',
      `/api/v1/website/leads/${LEAD_B}`,
      { 'x-draft-grant': VALID_GRANT_A },
      { contact: { fullName: 'Jane Doe' } },
    );
    expect(response.status).toBe(401);
    expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe('draft_not_found');
  });

  it('fails an expired grant', async () => {
    leadStore.grants.set(VALID_GRANT_A, {
      leadId: LEAD_A,
      expiresAt: Date.now() - 1,
      revoked: false,
    });
    const response = await request(
      'PATCH',
      `/api/v1/website/leads/${LEAD_A}`,
      { 'x-draft-grant': VALID_GRANT_A },
      { contact: { fullName: 'Jane Doe' } },
    );
    expect(response.status).toBe(401);
    expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe('draft_expired');
  });

  it('fails a revoked grant', async () => {
    leadStore.grants.set(VALID_GRANT_A, {
      leadId: LEAD_A,
      expiresAt: Date.now() + 60_000,
      revoked: true,
    });
    const response = await request(
      'PATCH',
      `/api/v1/website/leads/${LEAD_A}`,
      { 'x-draft-grant': VALID_GRANT_A },
      { contact: { fullName: 'Jane Doe' } },
    );
    expect(response.status).toBe(401);
    expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe('draft_expired');
  });

  it('rejects an edit to a submitted draft with 409 draft_already_submitted', async () => {
    leadStore.leadStatus.set(LEAD_A, 'submitted');
    const response = await request(
      'PATCH',
      `/api/v1/website/leads/${LEAD_A}`,
      { 'x-draft-grant': VALID_GRANT_A },
      { contact: { fullName: 'Too late' } },
    );
    expect(response.status).toBe(409);
    expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe(
      'draft_already_submitted',
    );
  });

  it('updates the same lead on repeated saves with a valid grant', async () => {
    const first = await request(
      'PATCH',
      `/api/v1/website/leads/${LEAD_A}`,
      { 'x-draft-grant': VALID_GRANT_A },
      { contact: { fullName: 'Jane Doe' } },
    );
    expect(first.status).toBe(200);
    const second = await request(
      'PATCH',
      `/api/v1/website/leads/${LEAD_A}`,
      { 'x-draft-grant': VALID_GRANT_A },
      { contact: { email: 'jane@example.test' } },
    );
    expect(second.status).toBe(200);

    expect(leadStore.updateCalls).toHaveLength(2);
    expect(leadStore.updateCalls.every((call) => call.leadId === LEAD_A)).toBe(true);
    expect(leadStore.updateCalls[0]?.contact).toEqual({ fullName: 'Jane Doe' });
    expect(leadStore.updateCalls[1]?.contact).toEqual({ email: 'jane@example.test' });
  });
});

describe('Idempotency-Key on website submission', () => {
  const KEY = 'cp_9f2c:retry.1';
  const POST_BODY = {
    leadType: 'sim_order',
    consentVersion: 'terms-2026-09',
    submit: true,
    contact: { fullName: 'Jane Doe', email: 'jane@example.test' },
    form: { schemaVersion: 1, payload: { delivery: 'esim' } },
    order: { planId: '93000000-0000-4000-8000-000000000303', quantity: 1 },
  };
  const PATCH_BODY = { contact: { fullName: 'Jane Doe' }, submit: true };
  const post = (headers: Record<string, string>, body: unknown = POST_BODY) =>
    request('POST', '/api/v1/website/leads', headers, body);
  const patch = (headers: Record<string, string>, body: unknown = PATCH_BODY) =>
    request(
      'PATCH',
      `/api/v1/website/leads/${LEAD_A}`,
      { 'x-draft-grant': VALID_GRANT_A, ...headers },
      body,
    );

  /** Every line the process logged while `run` ran, whichever console method wrote it. */
  async function captureLogs(run: () => Promise<void>): Promise<string> {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    try {
      await run();
      return JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  }

  it('sends the store nothing without the header', async () => {
    expect((await post({})).status).toBe(201);
    expect((await patch({})).status).toBe(200);
    expect(leadStore.createCalls[0]?.idempotency).toBeUndefined();
    expect(leadStore.updateCalls[0]?.idempotency).toBeUndefined();
  });

  it('forwards only the hashed key and the body fingerprint on a create', async () => {
    const response = await post({ 'idempotency-key': KEY });
    expect(response.status).toBe(201);
    const call = leadStore.createCalls[0];
    expect(call?.idempotency).toEqual({
      keyHash: idempotencyKeyHash(KEY),
      fingerprint: requestFingerprint(POST_BODY),
    });
    expect(JSON.stringify(call)).not.toContain(KEY);
  });

  it('forwards the lead id and body fingerprint on a submitting update', async () => {
    const response = await patch({ 'idempotency-key': KEY });
    expect(response.status).toBe(200);
    const call = leadStore.updateCalls[0];
    expect(call?.idempotency).toEqual({
      keyHash: idempotencyKeyHash(KEY),
      fingerprint: requestFingerprint({ leadId: LEAD_A, body: PATCH_BODY }),
    });
    expect(call?.idempotency?.fingerprint).not.toBe(requestFingerprint(PATCH_BODY));
    expect(JSON.stringify(call)).not.toContain(KEY);
  });

  it('ignores the key on an update that does not submit', async () => {
    const response = await patch({ 'idempotency-key': KEY }, { contact: { fullName: 'Jane Doe' } });
    expect(response.status).toBe(200);
    expect(leadStore.updateCalls[0]?.idempotency).toBeUndefined();
  });

  it('marks a replayed create 201 with replayed true, and a first create without it', async () => {
    const first = createLeadResponseSchema.parse(await (await post({})).json());
    expect(first.replayed).toBeUndefined();

    leadStore.createReplayed = true;
    const response = await post({ 'idempotency-key': KEY });
    expect(response.status).toBe(201);
    const replay = createLeadResponseSchema.parse(await response.json());
    expect(replay.replayed).toBe(true);
    expect(replay.lead.id).toBe(LEAD_A);
  });

  it('marks a replayed update 200 with replayed true', async () => {
    leadStore.updateOutcome = {
      status: 'updated',
      lead: {
        id: LEAD_A,
        workspaceId: WORKSPACE,
        status: 'submitted',
        externalRef: null,
        updatedAt: NOW,
      },
      replayed: true,
    };
    const response = await patch({ 'idempotency-key': KEY });
    expect(response.status).toBe(200);
    const body = updateLeadResponseSchema.parse(await response.json());
    expect(body.replayed).toBe(true);
    expect(body.lead.status).toBe('submitted');
  });

  it('answers a key reused with another request 409 idempotency_conflict', async () => {
    leadStore.createError = new IdempotencyError('idempotency_conflict');
    const created = await post({ 'idempotency-key': KEY });
    expect(created.status).toBe(409);
    expect(created.headers.get('retry-after')).toBeNull();
    expect(apiErrorResponseSchema.parse(await created.json()).error.code).toBe(
      'idempotency_conflict',
    );

    leadStore.updateOutcome = { status: 'idempotency_conflict' };
    const updated = await patch({ 'idempotency-key': KEY });
    expect(updated.status).toBe(409);
    expect(apiErrorResponseSchema.parse(await updated.json()).error.code).toBe(
      'idempotency_conflict',
    );
  });

  it('answers a key still being processed 409 idempotency_in_progress with Retry-After', async () => {
    leadStore.createError = new IdempotencyError('idempotency_in_progress');
    const created = await post({ 'idempotency-key': KEY });
    expect(created.status).toBe(409);
    expect(created.headers.get('retry-after')).toBe('2');
    const createdBody = apiErrorResponseSchema.parse(await created.json());
    expect(createdBody.error.code).toBe('idempotency_in_progress');
    expect(createdBody.error.message).toBe(
      'A request with this idempotency key is still being processed. Retry shortly.',
    );

    leadStore.updateOutcome = { status: 'idempotency_in_progress' };
    const updated = await patch({ 'idempotency-key': KEY });
    expect(updated.status).toBe(409);
    expect(updated.headers.get('retry-after')).toBe('2');
    expect(apiErrorResponseSchema.parse(await updated.json()).error.code).toBe(
      'idempotency_in_progress',
    );
  });

  it('refuses a malformed key with a 400 naming the header, before the store is reached', async () => {
    for (const bad of [
      'short',
      'has spaces in it',
      `${'a'.repeat(201)}`,
      'bad/key/chars!',
      'a, b,c,d,e,f',
    ]) {
      for (const response of [
        await post({ 'idempotency-key': bad }),
        await patch({ 'idempotency-key': bad }),
      ]) {
        expect(response.status).toBe(400);
        const text = await response.text();
        const body = apiErrorResponseSchema.parse(JSON.parse(text));
        expect(body.error.code).toBe('validation_error');
        expect(body.error.details).toEqual({ field: 'Idempotency-Key' });
        expect(text).not.toContain(bad);
      }
    }
    expect(leadStore.createCalls).toHaveLength(0);
    expect(leadStore.updateCalls).toHaveLength(0);
  });

  it('never logs or echoes the raw key', async () => {
    const secretKey = 'raw-key-must-stay-secret-0001';
    const bodies: string[] = [];
    const logs = await captureLogs(async () => {
      // A malformed key, a refused key, a store failure and a success.
      bodies.push(await (await post({ 'idempotency-key': 'bad key!' })).text());
      leadStore.createError = new IdempotencyError('idempotency_conflict');
      bodies.push(await (await post({ 'idempotency-key': secretKey })).text());
      leadStore.createError = new Error(`boom ${secretKey}`);
      bodies.push(await (await post({ 'idempotency-key': secretKey })).text());
      leadStore.createError = Object.assign(new Error('connection refused'), {
        code: 'ECONNREFUSED',
      });
      bodies.push(await (await post({ 'idempotency-key': secretKey })).text());
      leadStore.createError = undefined;
      bodies.push(await (await post({ 'idempotency-key': secretKey })).text());
      bodies.push(await (await patch({ 'idempotency-key': secretKey })).text());
    });
    expect(logs).toContain('request_error');
    expect(logs).not.toContain(secretKey);
    expect(logs).not.toContain('bad key!');
    for (const body of bodies) expect(body).not.toContain(secretKey);
  });
});

describe('SIM order intake', () => {
  const PLAN = '93000000-0000-4000-8000-000000000302';
  const submitted = {
    leadType: 'sim_order',
    consentVersion: 'getcanadasim-order-2026-10',
    submit: true,
    contact: { fullName: 'Nadia Khan', email: 'nadia@example.test' },
    form: { schemaVersion: 1, payload: { delivery: 'esim', arrivalDate: '2026-11-20' } },
  };
  const save = (body: unknown) =>
    request('PATCH', `/api/v1/website/leads/${LEAD_A}`, { 'x-draft-grant': VALID_GRANT_A }, body);

  async function errorOf(response: Response) {
    expect(response.status).toBe(400);
    return apiErrorResponseSchema.parse(await response.json()).error;
  }

  it("returns the order's number on the created lead", async () => {
    leadStore.nextExternalRef = 'MS-153';
    const response = await request(
      'POST',
      '/api/v1/website/leads',
      {},
      { leadType: 'sim_order', consentVersion: 'gcs-v1', contact: { fullName: 'Nadia Khan' } },
    );
    expect(response.status).toBe(201);
    expect(createLeadResponseSchema.parse(await response.json()).lead.externalRef).toBe('MS-153');
  });

  it('saves a draft with only a name', async () => {
    const response = await request(
      'POST',
      '/api/v1/website/leads',
      {},
      { leadType: 'sim_order', consentVersion: 'gcs-v1', contact: { fullName: 'Nadia Khan' } },
    );
    expect(response.status).toBe(201);
    expect(leadStore.createCalls).toHaveLength(1);
  });

  it('refuses a submission without a plan before the store, naming only the part', async () => {
    const response = await request('POST', '/api/v1/website/leads', {}, submitted);
    expect(await errorOf(response)).toMatchObject({
      code: 'validation_error',
      details: { field: 'order' },
    });
    expect(leadStore.createCalls).toHaveLength(0);

    const complete = await request(
      'POST',
      '/api/v1/website/leads',
      {},
      { ...submitted, order: { planId: PLAN } },
    );
    expect(complete.status).toBe(201);
  });

  it("refuses a save whose form is not the type's, without echoing it", async () => {
    const response = await save({
      form: { schemaVersion: 1, payload: { delivery: 'esim', simNumber: '+16475550123' } },
    });
    const text = await response.clone().text();
    expect(await errorOf(response)).toMatchObject({
      code: 'validation_error',
      details: { field: 'form' },
    });
    expect(text).not.toContain('6475550123');
  });

  it('answers an incomplete submission 400 with the part it lacks', async () => {
    for (const problem of ['contact', 'order', 'form'] as const) {
      leadStore.updateOutcome = { status: 'submission_incomplete', problem };
      expect(await errorOf(await save({ submit: true }))).toMatchObject({
        code: 'validation_error',
        details: { field: problem },
      });
    }
  });
});

describe('order intake', () => {
  const PLAN = '93000000-0000-4000-8000-000000000301';
  const simOrder = (extra: Record<string, unknown> = {}) => ({
    leadType: 'sim_order',
    consentVersion: 'gcs-v1',
    contact: { fullName: 'Nadia Khan', email: 'traveller@example.test' },
    form: { schemaVersion: 1, payload: { delivery: 'esim' } },
    ...extra,
  });

  async function errorOf(response: Response) {
    return apiErrorResponseSchema.parse(await response.json()).error;
  }

  it('passes the plan through with quantity 1 by default, never a price', async () => {
    const response = await request(
      'POST',
      '/api/v1/website/leads',
      {},
      simOrder({ submit: true, order: { planId: PLAN } }),
    );
    expect(response.status).toBe(201);
    expect(leadStore.createCalls[0]?.order).toEqual({ planId: PLAN, quantity: 1 });

    for (const order of [
      { planId: PLAN, priceMinor: 100 },
      { planId: PLAN, quantity: 0 },
      { planId: 'not-a-uuid' },
    ]) {
      const refused = await request('POST', '/api/v1/website/leads', {}, simOrder({ order }));
      expect(refused.status).toBe(400);
    }
    expect(leadStore.createCalls).toHaveLength(1);
  });

  it('refuses a plan on a type that takes no order before the store', async () => {
    const response = await request(
      'POST',
      '/api/v1/website/leads',
      {},
      simOrder({ leadType: 'contact_message', order: { planId: PLAN } }),
    );
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toMatchObject({
      code: 'invalid_request',
      details: { field: 'order' },
    });
    expect(leadStore.createCalls).toHaveLength(0);
  });

  it('answers a plan the site does not sell with 400 plan_not_available', async () => {
    leadStore.createError = new OrderIntakeError('plan_not_available');
    const response = await request(
      'POST',
      '/api/v1/website/leads',
      {},
      simOrder({ submit: true, order: { planId: PLAN, quantity: 2 } }),
    );
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toMatchObject({
      code: 'plan_not_available',
      details: { field: 'order' },
    });
  });

  it('passes the plan and the submission of a draft save through, and maps the refusals', async () => {
    const save = (body: unknown) =>
      request('PATCH', `/api/v1/website/leads/${LEAD_A}`, { 'x-draft-grant': VALID_GRANT_A }, body);
    expect((await save({ order: { planId: PLAN, quantity: 3 }, submit: true })).status).toBe(200);
    expect(leadStore.updateCalls[0]).toMatchObject({
      order: { planId: PLAN, quantity: 3 },
      submit: true,
    });

    for (const [status, code] of [
      ['plan_not_available', 'plan_not_available'],
      ['order_not_allowed', 'invalid_request'],
    ] as const) {
      leadStore.updateOutcome = { status };
      const response = await save({ order: { planId: PLAN } });
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toMatchObject({ code, details: { field: 'order' } });
    }
  });
});
