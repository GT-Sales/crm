import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiErrorResponseSchema } from '@gt-sales/contracts';
import type { RateLimitInput, WebsiteCredentialResolution } from '@gt-sales/db';

import { createApp } from '../src/app.js';
import type { StaffSessionVerifier, VerifiedStaffSession } from '../src/auth/session.js';
import type { DocumentService } from '../src/documents/service.js';
import type { FileRow } from '../src/documents/store.js';
import type {
  IdentityEligibility,
  IdentityStore,
  RecordIdentityOutcome,
  RevealIdentityOutcome,
} from '../src/leads/identity-store.js';
import type { LeadStore } from '../src/leads/store.js';
import type { StaffAccessSnapshot } from '../src/staff/authorization.js';
import type { StaffStore } from '../src/staff/store.js';
import { generateServiceSecret } from '../src/website/credential.js';
import type { WebsiteCredentialStore } from '../src/website/store.js';

const WORKSPACE = '10000000-0000-4000-8000-0000000000a1';
const CREDENTIAL = '80000000-0000-4000-8000-0000000000a1';
const ACTOR = '20000000-0000-4000-8000-0000000000a1';
const LEAD = '90000000-0000-4000-8000-0000000000a1';
const FILE = '50000000-0000-4000-8000-0000000000a1';
const IDENTITY = '60000000-0000-4000-8000-0000000000a1';
const NOW = '2026-10-27T12:00:00.000Z';
// A made-up number that passes the Luhn check, never a real person's.
const SIN = '046454286';
const CHECKSUM = 'a'.repeat(64);
const { secret: SECRET, secretHash: SECRET_HASH } = generateServiceSecret();

const resolution: WebsiteCredentialResolution = {
  credentialId: CREDENTIAL,
  workspaceId: WORKSPACE,
  scopes: ['leads:write'],
  revoked: false,
};

const unusedLeadStore: LeadStore = {
  readLead: async () => ({ status: 'grant_invalid' }),
  createLead: async () => {
    throw new Error('unused');
  },
  updateLead: async () => {
    throw new Error('unused');
  },
  listLeads: async () => ({ leads: [], page: { page: 1, pageSize: 25, total: 0 } }),
};

const noopCredentialStore: WebsiteCredentialStore = {
  createCredential: async () => {
    throw new Error('unused');
  },
  listCredentials: async () => [],
  revokeCredential: async () => ({ status: 'not_found' }),
};

class AccessStore implements StaffStore {
  access: StaffAccessSnapshot = {
    membershipId: '30000000-0000-4000-8000-0000000000a1',
    status: 'active',
    roles: ['owner'],
    permissions: [],
  };
  bootstrapStaff = async () => [];
  inviteStaff = async () => {
    throw new Error('unused');
  };
  revokeStaff = async () => 'revoked' as const;
  listAssignableMembers = async () => [];
  setDisplayName = async () => 0;
  async loadStaffAccess(actorId: string, workspaceId: string) {
    return actorId === ACTOR && workspaceId === WORKSPACE ? this.access : undefined;
  }
}

class TokenVerifier implements StaffSessionVerifier {
  readonly sessions = new Map<string, VerifiedStaffSession>([
    ['owner-token', { actorId: ACTOR, verifiedEmail: 'owner@example.test' }],
  ]);
  async verify(token: string) {
    return this.sessions.get(token);
  }
}

function recorded(overrides: Partial<Extract<RecordIdentityOutcome, { status: 'recorded' }>> = {}) {
  return {
    status: 'recorded' as const,
    identity: { id: IDENTITY, idType: 'sin' as const, createdAt: NOW },
    mirrored: true,
    replayed: false,
    ...overrides,
  };
}

function identityStore() {
  return {
    eligibility: vi.fn<IdentityStore['eligibility']>(async (): Promise<IdentityEligibility> => ({
      status: 'eligible',
      legacy: false,
    })),
    recordSin: vi.fn<IdentityStore['recordSin']>(async () => recorded()),
    recordLicence: vi.fn<IdentityStore['recordLicence']>(async () =>
      recorded({ identity: { id: IDENTITY, idType: 'drivers_licence', createdAt: NOW } }),
    ),
    revealSin: vi.fn<IdentityStore['revealSin']>(async (): Promise<RevealIdentityOutcome> => ({
      status: 'revealed',
      sin: SIN,
    })),
  } satisfies IdentityStore;
}

const licenceFile: FileRow = {
  id: FILE,
  workspaceId: WORKSPACE,
  recordType: 'lead',
  recordId: LEAD,
  documentType: 'drivers_licence',
  bucket: 'documents',
  stagingKey: 'staging/x',
  candidateKey: null,
  objectKey: 'candidate/x',
  declaredContentType: 'image/jpeg',
  detectedMime: 'image/jpeg',
  declaredSizeBytes: 1000,
  sizeBytes: 1000,
  checksumSha256: CHECKSUM,
  status: 'available',
  rejectReason: null,
  revision: 2,
  uploadedBy: CREDENTIAL,
  expiresAt: new Date(NOW),
  finalizedAt: new Date(NOW),
  deletedAt: null,
  createdAt: new Date(NOW),
};

type IdentityDocuments = Pick<
  DocumentService,
  'createIntent' | 'finalize' | 'issueDownload' | 'copyAvailableToBucket' | 'removeBucketCopy'
>;

function documentService() {
  return {
    createIntent: vi.fn<IdentityDocuments['createIntent']>(async () => ({
      status: 'created',
      uploadId: FILE,
      url: 'memory://upload',
      headers: { 'content-type': 'image/jpeg' },
      expiresAt: new Date(Date.now() + 600_000),
    })),
    finalize: vi.fn<IdentityDocuments['finalize']>(async () => ({
      status: 'available',
      file: licenceFile,
    })),
    issueDownload: vi.fn<IdentityDocuments['issueDownload']>(async () => ({
      status: 'not_found',
    })),
    copyAvailableToBucket: vi.fn<IdentityDocuments['copyAvailableToBucket']>(async () => undefined),
    removeBucketCopy: vi.fn<IdentityDocuments['removeBucketCopy']>(async () => undefined),
  } satisfies IdentityDocuments;
}

let server: Server;
let baseUrl: string;
let identities: ReturnType<typeof identityStore> | undefined;
let documents: ReturnType<typeof documentService>;
let accessStore: AccessStore;
let rateLimitKeys: string[];

async function start(options: { identities?: boolean } = {}) {
  identities = options.identities === false ? undefined : identityStore();
  documents = documentService();
  accessStore = new AccessStore();
  rateLimitKeys = [];
  server = createApp({
    staff: {
      sessionVerifier: new TokenVerifier(),
      store: accessStore,
      credentialStore: noopCredentialStore,
      leadStore: unusedLeadStore,
      ...(identities ? { identityStore: identities } : {}),
    },
    website: {
      auth: {
        resolveCredential: async (hash) => (hash === SECRET_HASH ? resolution : undefined),
        rateLimit: async (input: RateLimitInput) => {
          rateLimitKeys.push(input.bucketKey);
          return { allowed: true, retryAfterSeconds: 0 };
        },
        botCheck: async () => true,
      },
      leads: { store: unusedLeadStore },
      documents: { service: documents, grants: { verifyLead: async () => undefined } },
      ...(identities ? { identities: { store: identities } } : {}),
    },
  }).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected TCP server');
  baseUrl = `http://127.0.0.1:${address.port}`;
}

beforeEach(() => start());

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function website(path: string, body: unknown) {
  return fetch(`${baseUrl}/api/v1/website/leads/${LEAD}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const sinBody = { idType: 'sin', sin: SIN, dateOfBirth: '1990-01-31', creditCheckConsent: true };
const licenceBody = {
  idType: 'drivers_licence',
  uploadId: FILE,
  checksumSha256: CHECKSUM,
  creditCheckConsent: true,
};

async function errorCode(response: Response) {
  return apiErrorResponseSchema.parse(await response.json()).error.code;
}

describe('the website ID step', () => {
  it('refuses both routes without the sealing key', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await start({ identities: false });
    const submit = await website('/identity', sinBody);
    expect(submit.status).toBe(409);
    expect(await errorCode(submit)).toBe('feature_not_ready');
    const upload = await website('/identity/uploads', { contentType: 'image/jpeg', sizeBytes: 10 });
    expect(upload.status).toBe(409);
  });

  it('records a SIN for the credential, under its own rate limit, and never echoes it', async () => {
    const response = await website('/identity', sinBody);
    expect(response.status).toBe(201);
    const text = await response.text();
    expect(text).not.toContain(SIN);
    expect(JSON.parse(text)).toMatchObject({ identity: { id: IDENTITY, idType: 'sin' } });
    expect(identities!.recordSin).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE,
        actorId: CREDENTIAL,
        leadId: LEAD,
        sin: SIN,
        dateOfBirth: '1990-01-31',
      }),
    );
    expect(rateLimitKeys.some((key) => key.startsWith(`endpoint:identity:ws:${WORKSPACE}:`))).toBe(
      true,
    );
  });

  it('refuses a SIN that fails its check digit, a future birth date or no consent, naming no value', async () => {
    for (const body of [
      { ...sinBody, sin: '046454287' },
      { ...sinBody, dateOfBirth: '2999-01-01' },
      { ...sinBody, creditCheckConsent: false },
      { ...sinBody, extra: 'field' },
    ]) {
      const response = await website('/identity', body);
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain('04645428');
    }
    expect(identities!.recordSin).not.toHaveBeenCalled();
  });

  it('answers 404 for a lead that cannot take an identity and 409 at the cap', async () => {
    identities!.recordSin.mockResolvedValueOnce({ status: 'not_found' });
    const missing = await website('/identity', sinBody);
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe('lead_not_found');

    identities!.recordSin.mockResolvedValueOnce({ status: 'limit_reached' });
    const full = await website('/identity', sinBody);
    expect(full.status).toBe(409);
    expect(await errorCode(full)).toBe('identity_limit_reached');
  });

  it('authorises a licence upload only for an eligible lead', async () => {
    identities!.eligibility.mockResolvedValueOnce({ status: 'not_found' });
    const missing = await website('/identity/uploads', {
      contentType: 'image/jpeg',
      sizeBytes: 10,
    });
    expect(missing.status).toBe(404);
    expect(documents.createIntent).not.toHaveBeenCalled();

    identities!.eligibility.mockResolvedValueOnce({ status: 'limit_reached' });
    const full = await website('/identity/uploads', { contentType: 'image/jpeg', sizeBytes: 10 });
    expect(full.status).toBe(409);

    const created = await website('/identity/uploads', {
      contentType: 'image/jpeg',
      sizeBytes: 10,
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ uploadId: FILE, method: 'PUT' });
    expect(documents.createIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE,
        recordType: 'lead',
        recordId: LEAD,
        documentType: 'drivers_licence',
      }),
    );

    const tooBig = await website('/identity/uploads', {
      contentType: 'image/jpeg',
      sizeBytes: 5 * 1024 * 1024,
    });
    expect(tooBig.status).toBe(400);
  });

  it('records a verified licence photo without a legacy copy when none applies', async () => {
    const response = await website('/identity', licenceBody);
    expect(response.status).toBe(201);
    expect(documents.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: FILE, checksumSha256: CHECKSUM, ownedLeadId: LEAD }),
    );
    expect(documents.copyAvailableToBucket).not.toHaveBeenCalled();
    expect(identities!.recordLicence).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: LEAD, fileId: FILE, legacyPath: null }),
    );
  });

  it("copies the photo into the old admin's bucket before recording it there", async () => {
    identities!.eligibility.mockResolvedValue({ status: 'eligible', legacy: true });
    const response = await website('/identity', licenceBody);
    expect(response.status).toBe(201);
    expect(documents.copyAvailableToBucket).toHaveBeenCalledWith({
      workspaceId: WORKSPACE,
      file: licenceFile,
      destinationBucket: 'mobility-ids',
      destinationKey: `${LEAD}/${FILE}.jpg`,
    });
    expect(identities!.recordLicence).toHaveBeenCalledWith(
      expect.objectContaining({ legacyPath: `${LEAD}/${FILE}.jpg` }),
    );
    expect(documents.removeBucketCopy).not.toHaveBeenCalled();
  });

  it('fails retryably when the copy fails, recording nothing', async () => {
    identities!.eligibility.mockResolvedValue({ status: 'eligible', legacy: true });
    documents.copyAvailableToBucket.mockRejectedValueOnce(new Error('storage down'));
    const response = await website('/identity', licenceBody);
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('2');
    expect(identities!.recordLicence).not.toHaveBeenCalled();
  });

  it('removes a copy nothing links to, but never after not_found or a replay', async () => {
    identities!.eligibility.mockResolvedValue({ status: 'eligible', legacy: true });
    const key = { bucket: 'mobility-ids', key: `${LEAD}/${FILE}.jpg` };

    identities!.recordLicence.mockResolvedValueOnce({ status: 'limit_reached' });
    expect((await website('/identity', licenceBody)).status).toBe(409);
    expect(documents.removeBucketCopy).toHaveBeenLastCalledWith(key);

    identities!.recordLicence.mockResolvedValueOnce(recorded({ mirrored: false }));
    expect((await website('/identity', licenceBody)).status).toBe(201);
    expect(documents.removeBucketCopy).toHaveBeenCalledTimes(2);

    identities!.recordLicence.mockResolvedValueOnce({ status: 'not_found' });
    expect((await website('/identity', licenceBody)).status).toBe(404);
    identities!.recordLicence.mockResolvedValueOnce(recorded({ mirrored: false, replayed: true }));
    expect((await website('/identity', licenceBody)).status).toBe(201);
    expect(documents.removeBucketCopy).toHaveBeenCalledTimes(2);
  });

  it('passes on a failed verification and refuses a file that is not a licence', async () => {
    documents.finalize.mockResolvedValueOnce({
      status: 'rejected',
      file: null,
      reason: 'checksum_mismatch',
    });
    const rejected = await website('/identity', licenceBody);
    expect(rejected.status).toBe(422);
    expect(await errorCode(rejected)).toBe('document_verification_failed');

    documents.finalize.mockResolvedValueOnce({
      status: 'available',
      file: { ...licenceFile, documentType: 'passport' },
    });
    const passport = await website('/identity', licenceBody);
    expect(passport.status).toBe(404);
    expect(await errorCode(passport)).toBe('upload_not_found');
    expect(identities!.recordLicence).not.toHaveBeenCalled();
  });
});

function reveal(identityId = IDENTITY, token = 'owner-token') {
  return fetch(
    `${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/leads/${LEAD}/identities/${identityId}/reveal`,
    { method: 'POST', headers: { authorization: `Bearer ${token}` } },
  );
}

describe('revealing a SIN', () => {
  it('opens it for an owner, uncached', async () => {
    const response = await reveal();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toMatchObject({ sin: SIN });
    expect(identities!.revealSin).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE,
        actorId: ACTOR,
        leadId: LEAD,
        identityId: IDENTITY,
      }),
    );
  });

  it('refuses every other role, even one that works leads', async () => {
    for (const roles of [['leads'], ['finance'], ['viewer']] as const) {
      accessStore.access = { ...accessStore.access, roles };
      expect((await reveal()).status).toBe(403);
    }
    accessStore.access = {
      ...accessStore.access,
      roles: ['leads'],
      permissions: [{ name: 'document_download', effect: 'allow' }],
    };
    expect((await reveal()).status).toBe(403);
    expect(identities!.revealSin).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown identity, 400 for a bad id and 500 for one no key opens', async () => {
    identities!.revealSin.mockResolvedValueOnce({ status: 'not_found' });
    const missing = await reveal();
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe('identity_not_found');

    expect((await reveal('not-a-uuid')).status).toBe(400);

    identities!.revealSin.mockResolvedValueOnce({ status: 'unreadable' });
    expect((await reveal()).status).toBe(500);
  });

  it('is not ready without the sealing key', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await start({ identities: false });
    const response = await reveal();
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe('feature_not_ready');
  });
});
