import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  apiErrorResponseSchema,
  createServiceCredentialResponseSchema,
  listServiceCredentialsResponseSchema,
  revokeServiceCredentialResponseSchema,
} from '@gt-sales/contracts';

import { createApp } from '../src/app.js';
import type { StaffSessionVerifier, VerifiedStaffSession } from '../src/auth/session.js';
import type { StaffAccessSnapshot } from '../src/staff/authorization.js';
import type { StaffStore } from '../src/staff/store.js';
import type { LeadStore } from '../src/leads/store.js';
import type {
  CreateCredentialInput,
  ServiceCredentialRecord,
  WebsiteCredentialStore,
} from '../src/website/store.js';
import { hashServiceSecret } from '../src/website/credential.js';

const ACTOR = '20000000-0000-4000-8000-000000000100';
const WORKSPACE = '10000000-0000-4000-8000-000000000101';
const CREDENTIAL = '80000000-0000-4000-8000-000000000101';

class TokenVerifier implements StaffSessionVerifier {
  sessions = new Map<string, VerifiedStaffSession>();
  async verify(token: string) {
    return this.sessions.get(token);
  }
}

class MemoryStaffStore implements StaffStore {
  access: StaffAccessSnapshot = {
    membershipId: '30000000-0000-4000-8000-000000000101',
    status: 'active',
    roles: ['owner'],
    permissions: [],
  };
  async bootstrapStaff() {
    return [];
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

class MemoryCredentialStore implements WebsiteCredentialStore {
  records: ServiceCredentialRecord[] = [];
  lastSecretHash?: string;

  async createCredential(input: CreateCredentialInput): Promise<ServiceCredentialRecord> {
    this.lastSecretHash = input.secretHash;
    const record: ServiceCredentialRecord = {
      id: CREDENTIAL,
      scopes: [...input.scopes],
      createdAt: '2026-09-14T00:00:00.000Z',
      revokedAt: null,
    };
    this.records.push(record);
    return record;
  }
  async listCredentials() {
    return this.records;
  }
  async revokeCredential(input: { credentialId: string }) {
    if (input.credentialId !== CREDENTIAL) return { status: 'not_found' as const };
    return { status: 'revoked' as const, revokedAt: '2026-09-14T01:00:00.000Z' };
  }
}

const noopLeadStore: LeadStore = {
  readLead: async () => ({ status: 'grant_invalid' }),
  createLead: async () => {
    throw new Error('not used in these service-credential tests');
  },
  updateLead: async () => {
    throw new Error('not used in these service-credential tests');
  },
  listLeads: async () => ({ leads: [], page: { page: 1, pageSize: 25, total: 0 } }),
};

let server: Server;
let baseUrl: string;
let verifier: TokenVerifier;
let store: MemoryStaffStore;
let credentialStore: MemoryCredentialStore;

const credentialsPath = `/api/v1/staff/workspaces/${WORKSPACE}/service-credentials`;

beforeEach(async () => {
  verifier = new TokenVerifier();
  verifier.sessions.set('token', { actorId: ACTOR, verifiedEmail: 'o@example.test' });
  store = new MemoryStaffStore();
  credentialStore = new MemoryCredentialStore();
  server = createApp({
    staff: { sessionVerifier: verifier, store, credentialStore, leadStore: noopLeadStore },
  }).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected TCP server');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function create(token: string, body: unknown) {
  return fetch(`${baseUrl}${credentialsPath}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('service credential management', () => {
  it('issues a credential once for an owner and stores only its hash', async () => {
    const response = await create('token', { scopes: ['leads:write', 'uploads:customer'] });
    expect(response.status).toBe(201);
    const body = createServiceCredentialResponseSchema.parse(await response.json());
    expect(body.secret.startsWith('gtsk_')).toBe(true);
    expect(body.credential.scopes).toEqual(['leads:write', 'uploads:customer']);
    // The persisted value is the hash of the shown secret, never the secret itself.
    expect(credentialStore.lastSecretHash).toBe(hashServiceSecret(body.secret));
  });

  it('refuses a role without integration management', async () => {
    store.access = { ...store.access, roles: ['viewer'] };
    const response = await create('token', { scopes: ['leads:write'] });
    expect(response.status).toBe(403);
    expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe(
      'permission_denied',
    );
  });

  it('rejects an empty or unknown scope set', async () => {
    expect((await create('token', { scopes: [] })).status).toBe(400);
    expect((await create('token', { scopes: ['staff:everything'] })).status).toBe(400);
  });

  it('lists and revokes credentials', async () => {
    await create('token', { scopes: ['leads:write'] });
    const list = await fetch(`${baseUrl}${credentialsPath}`, {
      headers: { authorization: 'Bearer token' },
    });
    expect(listServiceCredentialsResponseSchema.parse(await list.json()).credentials).toHaveLength(
      1,
    );

    const revoke = await fetch(`${baseUrl}${credentialsPath}/${CREDENTIAL}`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer token' },
    });
    expect(revoke.status).toBe(200);
    expect(revokeServiceCredentialResponseSchema.parse(await revoke.json()).id).toBe(CREDENTIAL);
  });

  it('returns credential_not_found when revoking a missing credential', async () => {
    const response = await fetch(
      `${baseUrl}${credentialsPath}/90000000-0000-4000-8000-000000000999`,
      { method: 'DELETE', headers: { authorization: 'Bearer token' } },
    );
    expect(response.status).toBe(404);
    expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe(
      'credential_not_found',
    );
  });
});
