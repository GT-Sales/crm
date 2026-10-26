import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type { StaffSessionVerifier, VerifiedStaffSession } from '../src/auth/session.js';
import type { StaffAccessSnapshot } from '../src/staff/authorization.js';
import type { StaffStore } from '../src/staff/store.js';
import type { WebsiteCredentialStore } from '../src/website/store.js';
import type { DocumentService } from '../src/documents/service.js';

const ACTOR = '20000000-0000-4000-8000-0000000000d1';
const WORKSPACE = '10000000-0000-4000-8000-0000000000d1';
const MEMBERSHIP = '30000000-0000-4000-8000-0000000000d1';
const FILE_ID = '50000000-0000-4000-8000-0000000000d1';

const noopCredentialStore: WebsiteCredentialStore = {
  createCredential: async () => {
    throw new Error('unused');
  },
  listCredentials: async () => [],
  revokeCredential: async () => ({ status: 'not_found' }),
};

class TokenVerifier implements StaffSessionVerifier {
  readonly sessions = new Map<string, VerifiedStaffSession>();
  async verify(token: string) {
    return this.sessions.get(token);
  }
}

/** A staff access store whose snapshot the test configures per case. */
class ConfigurableStaffStore implements StaffStore {
  access: StaffAccessSnapshot = {
    membershipId: MEMBERSHIP,
    status: 'active',
    roles: ['viewer'],
    permissions: [],
  };
  async bootstrapStaff() {
    return [];
  }
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

/** Fake document service: a known file yields a signed link; everything else 404s. */
const documentService: Pick<DocumentService, 'listForOrder' | 'review' | 'issueDownload'> = {
  listForOrder: async () => ({ status: 'not_found' }),
  review: async () => ({ status: 'not_found' }),
  issueDownload: async (input) =>
    input.fileId === FILE_ID
      ? { status: 'issued', url: 'memory://signed', expiresAt: new Date(Date.now() + 120_000) }
      : { status: 'not_found' },
};

let server: Server;
let baseUrl: string;
let verifier: TokenVerifier;
let store: ConfigurableStaffStore;

beforeEach(async () => {
  verifier = new TokenVerifier();
  verifier.sessions.set('token', { actorId: ACTOR, verifiedEmail: 'viewer@example.test' });
  store = new ConfigurableStaffStore();
  server = createApp({
    staff: {
      sessionVerifier: verifier,
      store,
      credentialStore: noopCredentialStore,
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
      documentService,
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

async function requestDownloadLink(token = 'token'): Promise<Response> {
  return fetch(`${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/files/${FILE_ID}/download-link`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
  });
}

describe('staff document download permission (REQ 23; gate 5)', () => {
  it('denies download without the document.download permission', async () => {
    store.access = {
      membershipId: MEMBERSHIP,
      status: 'active',
      roles: ['viewer'],
      permissions: [],
    };
    const response = await requestDownloadLink();
    expect(response.status).toBe(403);
  });

  it('allows download when the document.download permission is individually granted', async () => {
    store.access = {
      membershipId: MEMBERSHIP,
      status: 'active',
      roles: ['viewer'],
      permissions: [{ name: 'document_download', effect: 'allow' }],
    };
    // Owner decision (25 Oct 2026): the grant alone is enough; no multi-factor step.
    const response = await requestDownloadLink();
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({ url: 'memory://signed' });
  });

  it('denies a revoked member on the next request', async () => {
    store.access = {
      membershipId: MEMBERSHIP,
      status: 'revoked',
      roles: ['owner'],
      permissions: [],
    };
    const response = await requestDownloadLink();
    expect(response.status).toBe(403);
  });
});
