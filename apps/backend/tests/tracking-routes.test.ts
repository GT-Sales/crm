import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiErrorResponseSchema,
  createUploadIntentResponseSchema,
  trackedChangeResponseSchema,
  trackingCodeResponseSchema,
  trackingOrdersResponseSchema,
  trackingVerifyResponseSchema,
  type TrackingOrder,
} from '@gt-sales/contracts';
import type { RateLimitInput, RateLimitResult, WebsiteCredentialResolution } from '@gt-sales/db';

import { createApp } from '../src/app.js';
import type { StaffSessionVerifier } from '../src/auth/session.js';
import type { DocumentService } from '../src/documents/service.js';
import type { LeadUpdateContext } from '../src/leads/work-store.js';
import type { StaffStore } from '../src/staff/store.js';
import {
  ChangeRequestService,
  type ChangeRequestRow,
  type ChangeRequestStore,
  type CustomerChangeOutcome,
} from '../src/tracking/change-requests.js';
import { signTrackingGrant } from '../src/tracking/secrets.js';
import { TrackingService } from '../src/tracking/service.js';
import type { ConsumeOutcome, TrackedLeadRef, TrackingStore } from '../src/tracking/store.js';
import { generateServiceSecret } from '../src/website/credential.js';
import type { WebsiteCredentialStore } from '../src/website/store.js';

// Ported from the matching cases of Canadian Plans' tracking-routes.test.ts.
const SECRET = 'tracking-routes-test-secret-0123456789abcdef';
const WORKSPACE = '10000000-0000-4000-8000-000000000901';
const OTHER_WORKSPACE = '10000000-0000-4000-8000-000000000902';
const CREDENTIAL = '80000000-0000-4000-8000-000000000901';
const LEAD = '90000000-0000-4000-8000-000000000901';
const UPLOAD = '60000000-0000-4000-8000-000000000901';
const JANE = 'jane.tracking@example.test';
const UNKNOWN = 'nobody.tracking@example.test';
const CODE = '123456';
const MIN_LATENCY_MS = 500;

const { secret: SERVICE_SECRET, secretHash: SECRET_HASH } = generateServiceSecret();

const staffOnly: {
  sessionVerifier: StaffSessionVerifier;
  store: StaffStore;
  credentialStore: WebsiteCredentialStore;
  leadStore: {
    readLead: () => Promise<never>;
    createLead: () => Promise<never>;
    updateLead: () => Promise<never>;
    listLeads: () => Promise<{
      leads: never[];
      page: { page: number; pageSize: number; total: number };
    }>;
  };
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
    readLead: async () => {
      throw new Error('unused');
    },
    createLead: async () => {
      throw new Error('unused');
    },
    updateLead: async () => {
      throw new Error('unused');
    },
    listLeads: async () => ({ leads: [], page: { page: 1, pageSize: 25, total: 0 } }),
  },
};

const order: TrackingOrder = {
  reference: 'MS-901',
  leadType: 'sim_order',
  stage: 'pending',
  stageLabel: 'Received',
  submittedAt: '2026-10-30T12:00:00.000Z',
  plan: null,
  quantity: 1,
  delivery: 'esim',
  courier: null,
  trackingNumber: null,
  dispatchedAt: null,
  simNumber: null,
  details: {
    fullName: 'Jane Doe',
    phone: null,
    arrivalDate: null,
    permitType: null,
    canadaAddress: null,
    shippingAddress: null,
    flightBooked: null,
  },
  documents: [],
  canRequestChange: true,
  pendingChange: null,
};

const savedRequest: ChangeRequestRow = {
  id: '70000000-0000-4000-8000-000000000901',
  leadId: LEAD,
  requestNo: 70,
  status: 'pending',
  requested: { phone: '+1 437 555 0188' },
  stagedFiles: [],
  version: 1,
  createdAt: new Date('2026-10-30T12:00:00.000Z'),
  updatedAt: new Date('2026-10-30T12:00:00.000Z'),
};

const heldFile = {
  id: UPLOAD,
  workspaceId: WORKSPACE,
  recordType: 'lead' as const,
  recordId: LEAD,
  documentType: 'passport',
  bucket: 'documents',
  stagingKey: 'staging/x',
  candidateKey: 'candidate/x',
  objectKey: 'candidate/x',
  declaredContentType: 'application/pdf' as const,
  detectedMime: 'application/pdf' as const,
  declaredSizeBytes: 10,
  sizeBytes: 10,
  checksumSha256: 'a'.repeat(64),
  status: 'available' as const,
  rejectReason: null,
  revision: 1,
  uploadedBy: CREDENTIAL,
  expiresAt: new Date(),
  finalizedAt: new Date(),
  deletedAt: null,
  createdAt: new Date(),
};

/** Counts per bucket like app.rate_limit_hit. */
class FakeRateLimiter {
  readonly counts = new Map<string, number>();
  hit = async (input: RateLimitInput): Promise<RateLimitResult> => {
    const next = (this.counts.get(input.bucketKey) ?? 0) + 1;
    this.counts.set(input.bucketKey, next);
    return { allowed: next <= input.maxCount, retryAfterSeconds: next <= input.maxCount ? 0 : 42 };
  };
}

let server: Server;
let baseUrl: string;
let limiter: FakeRateLimiter;
let scopes: string[];
let trackingStore: {
  [K in keyof TrackingStore]: ReturnType<typeof vi.fn<TrackingStore[K]>>;
};
let changeStore: {
  requestChange: ReturnType<typeof vi.fn<ChangeRequestStore['requestChange']>>;
  attachDocument: ReturnType<typeof vi.fn<ChangeRequestStore['attachDocument']>>;
  pendingForLead: ReturnType<typeof vi.fn<ChangeRequestStore['pendingForLead']>>;
};
let documents: {
  createIntent: ReturnType<typeof vi.fn<DocumentService['createIntent']>>;
  finalize: ReturnType<typeof vi.fn<DocumentService['finalize']>>;
};
let logged: string[];
let resolvedLead: TrackedLeadRef | undefined;

async function start(options: { secret?: string | undefined } = {}) {
  const secret = 'secret' in options ? options.secret : SECRET;
  const resolution = (): WebsiteCredentialResolution => ({
    credentialId: CREDENTIAL,
    workspaceId: WORKSPACE,
    scopes,
    revoked: false,
  });
  const auth = {
    resolveCredential: async (hash: string) => (hash === SECRET_HASH ? resolution() : undefined),
    rateLimit: limiter.hit,
    botCheck: async () => true,
  };
  const context: LeadUpdateContext = {
    emailEnvironment: { providerReady: false, contactHash: () => 'unused' },
    automations: {
      list: async () => [],
      setEnabled: async () => {
        throw new Error('unused');
      },
      recordRun: async () => {
        throw new Error('unused');
      },
      listRuns: async () => [],
    },
  };
  server = createApp({
    staff: staffOnly,
    website: { auth, leads: { store: staffOnly.leadStore } },
    tracking: {
      auth,
      secret,
      minLatencyMs: MIN_LATENCY_MS,
      tracking: new TrackingService({
        store: trackingStore,
        secret,
        contactHash: (email) => `hash:${email.length}`,
      }),
      changeRequests: new ChangeRequestService({ store: changeStore, context }),
      documents: { service: documents },
    },
  }).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected TCP server');
  baseUrl = `http://127.0.0.1:${address.port}`;
}

function request(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(`${baseUrl}/api/v1/website${path}`, {
    method,
    headers: {
      authorization: `Bearer ${SERVICE_SECRET}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const grant = (workspaceId = WORKSPACE, atMs = Date.now()) =>
  signTrackingGrant(SECRET, { workspaceId, normalizedEmail: JANE }, atMs).token;
const withGrant = (token = grant()) => ({ 'x-customer-grant': token });

async function errorOf(response: Response) {
  return apiErrorResponseSchema.parse(await response.json()).error;
}

beforeEach(async () => {
  limiter = new FakeRateLimiter();
  scopes = ['tracking'];
  resolvedLead = { leadId: LEAD, leadType: 'sim_order', stage: 'pending' };
  trackingStore = {
    hasTrackableLeads: vi.fn<TrackingStore['hasTrackableLeads']>(
      async (input) => input.normalizedEmail === JANE,
    ),
    createChallengeAndQueue: vi.fn<TrackingStore['createChallengeAndQueue']>(async () => 'queued'),
    consume: vi.fn<TrackingStore['consume']>(async (): Promise<ConsumeOutcome> => 'verified'),
    listOrders: vi.fn<TrackingStore['listOrders']>(async () => [order]),
    resolveLead: vi.fn<TrackingStore['resolveLead']>(async () => resolvedLead),
  };
  const saved: CustomerChangeOutcome = {
    status: 'saved',
    changeRequest: savedRequest,
    removedObjectKeys: [],
  };
  changeStore = {
    requestChange: vi.fn<ChangeRequestStore['requestChange']>(async () => saved),
    attachDocument: vi.fn<ChangeRequestStore['attachDocument']>(async () => saved),
    pendingForLead: vi.fn<ChangeRequestStore['pendingForLead']>(async () => undefined),
  };
  documents = {
    createIntent: vi.fn<DocumentService['createIntent']>(async () => ({
      status: 'created',
      uploadId: UPLOAD,
      url: 'https://storage.example/upload',
      headers: { 'content-type': 'application/pdf' },
      expiresAt: new Date('2026-10-30T12:15:00.000Z'),
    })),
    finalize: vi.fn<DocumentService['finalize']>(async () => ({ status: 'in_progress' })),
  };
  logged = [];
  const capture = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };
  vi.spyOn(console, 'error').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'info').mockImplementation(capture);
  await start();
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks();
});

describe('the code request', () => {
  it('answers a known and an unknown email the same, each after the floor', async () => {
    const bodies: unknown[] = [];
    for (const email of [JANE, UNKNOWN]) {
      const started = Date.now();
      const response = await request('POST', '/tracking/code', { email });
      expect(response.status).toBe(200);
      expect(Date.now() - started).toBeGreaterThanOrEqual(MIN_LATENCY_MS - 5);
      const body = trackingCodeResponseSchema.parse(await response.json());
      expect(body.status).toBe('code_sent');
      const { requestId: _requestId, ...rest } = body;
      bodies.push(rest);
    }
    expect(bodies[0]).toEqual(bodies[1]);
    expect(trackingStore.createChallengeAndQueue).toHaveBeenCalledTimes(1);
  });

  it('never answers a slow known email later than the floor, nor an unknown one sooner', async () => {
    trackingStore.createChallengeAndQueue.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve('queued'), 1_500)),
    );
    let started = Date.now();
    expect((await request('POST', '/tracking/code', { email: JANE })).status).toBe(200);
    const known = Date.now() - started;
    started = Date.now();
    expect((await request('POST', '/tracking/code', { email: UNKNOWN })).status).toBe(200);
    const unknown = Date.now() - started;
    expect(known).toBeGreaterThanOrEqual(MIN_LATENCY_MS - 5);
    expect(known).toBeLessThan(1_200);
    expect(unknown).toBeGreaterThanOrEqual(MIN_LATENCY_MS - 5);
  });

  it('still answers the sixth request in a window, but asks for a code only five times', async () => {
    for (let index = 0; index < 6; index += 1) {
      expect((await request('POST', '/tracking/code', { email: JANE })).status).toBe(200);
    }
    // The per-email bucket counts the unknown path too, so the store is asked five times.
    expect(trackingStore.hasTrackableLeads).toHaveBeenCalledTimes(5);
    expect(trackingStore.createChallengeAndQueue).toHaveBeenCalledTimes(5);
  });

  it('counts an email with no orders against its own budget too', async () => {
    for (let index = 0; index < 6; index += 1) {
      await request('POST', '/tracking/code', { email: UNKNOWN });
    }
    expect(trackingStore.hasTrackableLeads).toHaveBeenCalledTimes(5);
  });

  it('refuses a malformed body with 400', async () => {
    const response = await request('POST', '/tracking/code', { email: 'not-an-email' });
    expect(response.status).toBe(400);
  });
});

describe('verification', () => {
  it('trades a right code for a grant', async () => {
    const response = await request('POST', '/tracking/verify', { email: JANE, code: CODE });
    expect(response.status).toBe(200);
    const body = trackingVerifyResponseSchema.parse(await response.json());
    expect(body.grant.token.length).toBeGreaterThan(0);
  });

  it.each(['invalid', 'expired', 'exhausted', 'not_found'] as const)(
    'answers %s with the one 400 tracking_challenge_invalid',
    async (outcome) => {
      trackingStore.consume.mockResolvedValueOnce(outcome);
      const response = await request('POST', '/tracking/verify', { email: JANE, code: CODE });
      expect(response.status).toBe(400);
      const error = await errorOf(response);
      expect(error.code).toBe('tracking_challenge_invalid');
      expect(error.message).toBe('The code is wrong or has expired. Request a new code.');
    },
  );

  it('limits verifications per email: the eleventh in a window is 429', async () => {
    trackingStore.consume.mockResolvedValue('invalid');
    for (let index = 0; index < 10; index += 1) {
      expect((await request('POST', '/tracking/verify', { email: JANE, code: CODE })).status).toBe(
        400,
      );
    }
    const eleventh = await request('POST', '/tracking/verify', { email: JANE, code: CODE });
    expect(eleventh.status).toBe(429);
    expect(eleventh.headers.get('retry-after')).toBe('42');
    expect(trackingStore.consume).toHaveBeenCalledTimes(10);
  });
});

describe('the tracking scope and an unconfigured deployment', () => {
  it('refuses a key without the tracking scope', async () => {
    scopes = ['leads:write'];
    for (const [method, path, body] of [
      ['POST', '/tracking/code', { email: JANE }],
      ['POST', '/tracking/verify', { email: JANE, code: CODE }],
      ['GET', '/tracking/orders', undefined],
    ] as const) {
      const response = await request(method, path, body, withGrant());
      expect(response.status).toBe(403);
      expect((await errorOf(response)).code).toBe('scope_denied');
    }
  });

  it('answers the code neutrally and sends nothing, and every other route 409', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await start({ secret: undefined });
    expect((await request('POST', '/tracking/code', { email: JANE })).status).toBe(200);
    expect(trackingStore.hasTrackableLeads).not.toHaveBeenCalled();
    expect(trackingStore.createChallengeAndQueue).not.toHaveBeenCalled();
    for (const [method, path, body] of [
      ['POST', '/tracking/verify', { email: JANE, code: CODE }],
      ['GET', '/tracking/orders', undefined],
      ['POST', '/tracking/orders/MS-901/changes', { fields: { phone: '+1 437 555 0188' } }],
    ] as const) {
      const response = await request(method, path, body, withGrant());
      expect(response.status).toBe(409);
      expect((await errorOf(response)).code).toBe('feature_not_ready');
    }
  });
});

describe('the grant', () => {
  it('lists the verified email’s orders', async () => {
    const response = await request('GET', '/tracking/orders', undefined, withGrant());
    expect(response.status).toBe(200);
    expect(trackingOrdersResponseSchema.parse(await response.json()).orders).toEqual([order]);
    expect(trackingStore.listOrders).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE, normalizedEmail: JANE }),
    );
  });

  it('answers a missing, forged, expired or other site’s grant with 401 not_found', async () => {
    const forged = `${grant().slice(0, -2)}xx`;
    const expired = grant(WORKSPACE, Date.now() - 31 * 60_000);
    for (const headers of [
      {},
      withGrant('not-a-grant'),
      withGrant(forged),
      withGrant(expired),
      withGrant(grant(OTHER_WORKSPACE)),
    ]) {
      const response = await request('GET', '/tracking/orders', undefined, headers);
      expect(response.status).toBe(401);
      expect((await errorOf(response)).code).toBe('not_found');
    }
    expect(trackingStore.listOrders).not.toHaveBeenCalled();
  });
});

describe('change requests', () => {
  const change = (fields: unknown, reference = 'MS-901') =>
    request('POST', `/tracking/orders/${reference}/changes`, { fields }, withGrant());

  it('saves a change for the order the reference and email resolve to', async () => {
    const response = await change({ phone: '+1 437 555 0188' });
    expect(response.status).toBe(201);
    const body = trackedChangeResponseSchema.parse(await response.json());
    expect(body.changeRequest).toMatchObject({
      requestNo: 70,
      fields: { phone: '+1 437 555 0188' },
    });
    expect(trackingStore.resolveLead).toHaveBeenCalledWith(
      expect.objectContaining({ normalizedEmail: JANE, reference: 'MS-901' }),
    );
    expect(changeStore.requestChange).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE, actorId: CREDENTIAL, leadId: LEAD }),
    );
  });

  it('refuses an email change, an empty change and an unknown field with 400', async () => {
    for (const fields of [{ email: 'new@example.test' }, {}, { notes: 'x' }]) {
      expect((await change(fields)).status).toBe(400);
    }
    expect(changeStore.requestChange).not.toHaveBeenCalled();
  });

  it('answers an unknown reference 404 order_not_found', async () => {
    resolvedLead = undefined;
    const response = await change({ phone: '+1 437 555 0188' });
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe('order_not_found');
  });

  it('answers an order that can no longer change 409, and a refused field 400 naming it', async () => {
    changeStore.requestChange.mockResolvedValueOnce({ status: 'not_allowed' });
    const delivered = await change({ phone: '+1 437 555 0188' });
    expect(delivered.status).toBe(409);
    const error = await errorOf(delivered);
    expect(error.code).toBe('change_request_not_allowed');
    expect(error.message).toBe('This order can no longer be changed online.');
    for (const field of ['planId', 'shippingAddress']) {
      changeStore.requestChange.mockResolvedValueOnce({ status: 'invalid_field', field });
      const refused = await change({ delivery: 'pickup' });
      expect(refused.status).toBe(400);
      expect(await errorOf(refused)).toMatchObject({
        code: 'validation_error',
        details: { field },
      });
    }
  });

  it('limits writes per email: the 31st in a window is 429', async () => {
    for (let index = 0; index < 30; index += 1) {
      const response = await change({ phone: '+1 437 555 0188' });
      // The per-visitor endpoint limit (30 per 60 s) admits exactly these thirty too.
      expect(response.status).toBe(201);
    }
    const response = await change({ phone: '+1 437 555 0188' });
    expect(response.status).toBe(429);
    expect(changeStore.requestChange).toHaveBeenCalledTimes(30);
  });
});

describe('documents', () => {
  const intent = (body: unknown) =>
    request('POST', '/tracking/orders/MS-901/uploads/intents', body, withGrant());

  it('creates a held intent on the resolved lead', async () => {
    const response = await intent({
      documentType: 'passport',
      contentType: 'application/pdf',
      sizeBytes: 1000,
    });
    expect(response.status).toBe(201);
    expect(createUploadIntentResponseSchema.parse(await response.json()).uploadId).toBe(UPLOAD);
    expect(documents.createIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        recordType: 'lead',
        recordId: LEAD,
        documentType: 'passport',
        held: true,
      }),
    );
  });

  it('refuses a document type a change request does not take', async () => {
    const response = await intent({
      documentType: 'sim_photo',
      contentType: 'image/jpeg',
      sizeBytes: 1000,
    });
    expect(response.status).toBe(400);
    expect(documents.createIntent).not.toHaveBeenCalled();
  });

  it('refuses an upload for an order that can no longer change', async () => {
    resolvedLead = { leadId: LEAD, leadType: 'sim_order', stage: 'delivered' };
    const response = await intent({
      documentType: 'visa',
      contentType: 'application/pdf',
      sizeBytes: 1000,
    });
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe('change_request_not_allowed');
  });

  it('finalizes the lead’s own upload and joins it to the pending request', async () => {
    documents.finalize.mockResolvedValueOnce({ status: 'available', file: heldFile });
    const response = await request(
      'POST',
      `/tracking/orders/MS-901/uploads/${UPLOAD}/finalize`,
      { checksumSha256: 'a'.repeat(64) },
      withGrant(),
    );
    expect(response.status).toBe(200);
    expect(trackedChangeResponseSchema.parse(await response.json()).changeRequest.requestNo).toBe(
      70,
    );
    expect(documents.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: UPLOAD, ownedLeadId: LEAD }),
    );
    expect(changeStore.attachDocument).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: LEAD, fileId: UPLOAD }),
    );
  });
});

describe('privacy', () => {
  it('never logs the email, the code or the grant', async () => {
    trackingStore.createChallengeAndQueue.mockRejectedValueOnce(new Error(`boom ${JANE}`));
    trackingStore.consume.mockRejectedValueOnce(new Error(`boom ${CODE}`));
    const token = grant();
    await request('POST', '/tracking/code', { email: JANE });
    await request('POST', '/tracking/verify', { email: JANE, code: CODE });
    trackingStore.listOrders.mockRejectedValueOnce(new Error(`boom ${token}`));
    await request('GET', '/tracking/orders', undefined, withGrant(token));
    // Let the code request's background work settle.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const text = logged.join('\n');
    expect(logged.length).toBeGreaterThan(0);
    expect(text).not.toContain(JANE);
    expect(text).not.toContain('jane.tracking');
    expect(text).not.toContain(CODE);
    expect(text).not.toContain(token);
  });
});
