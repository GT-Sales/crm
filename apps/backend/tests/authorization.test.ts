import { describe, expect, it } from 'vitest';

import {
  createAuthorize,
  type StaffAccessSnapshot,
  type StaffAccessStore,
} from '../src/staff/authorization.js';

const ACTOR = '20000000-0000-4000-8000-000000000001';
const WORKSPACE_A = '10000000-0000-4000-8000-000000000001';
const WORKSPACE_B = '10000000-0000-4000-8000-000000000002';

class MemoryAccessStore implements StaffAccessStore {
  readonly rows = new Map<string, StaffAccessSnapshot>();

  async loadStaffAccess(actorId: string, workspaceId: string) {
    return this.rows.get(`${actorId}:${workspaceId}`);
  }
}

function activeAccess(
  roles: StaffAccessSnapshot['roles'],
  permissions: StaffAccessSnapshot['permissions'] = [],
): StaffAccessSnapshot {
  return {
    membershipId: '30000000-0000-4000-8000-000000000001',
    status: 'active',
    roles,
    permissions,
  };
}

describe('central staff authorization', () => {
  it('denies an owner in workspace A from reading workspace B without membership', async () => {
    const store = new MemoryAccessStore();
    store.rows.set(`${ACTOR}:${WORKSPACE_A}`, activeAccess(['owner']));
    const authorize = createAuthorize({ accessStore: store });

    await expect(
      authorize({ actorId: ACTOR, workspaceId: WORKSPACE_B, action: 'workspace.read' }),
    ).resolves.toEqual({ allowed: false, reason: 'membership_missing' });
  });

  it('denies a pending or revoked membership before looking at roles', async () => {
    const store = new MemoryAccessStore();
    const authorize = createAuthorize({ accessStore: store });
    for (const status of ['pending', 'revoked'] as const) {
      store.rows.set(`${ACTOR}:${WORKSPACE_A}`, { ...activeAccess(['owner']), status });
      await expect(
        authorize({ actorId: ACTOR, workspaceId: WORKSPACE_A, action: 'workspace.read' }),
      ).resolves.toEqual({ allowed: false, reason: `membership_${status}` });
    }
  });

  it('denies the Orders role a document download without an individual permission', async () => {
    const store = new MemoryAccessStore();
    store.rows.set(`${ACTOR}:${WORKSPACE_A}`, activeAccess(['orders']));
    const authorize = createAuthorize({ accessStore: store });

    await expect(
      authorize({ actorId: ACTOR, workspaceId: WORKSPACE_A, action: 'document.download' }),
    ).resolves.toEqual({ allowed: false, reason: 'permission_denied' });
  });

  it('allows an individually granted privileged permission alongside ordinary work', async () => {
    const store = new MemoryAccessStore();
    store.rows.set(
      `${ACTOR}:${WORKSPACE_A}`,
      activeAccess(['orders'], [{ name: 'document_download', effect: 'allow' }]),
    );
    const authorize = createAuthorize({ accessStore: store });
    // Owner decision (25 Oct 2026): no multi-factor step, so the grant alone
    // is enough for a privileged action.
    await expect(
      authorize({ actorId: ACTOR, workspaceId: WORKSPACE_A, action: 'document.download' }),
    ).resolves.toMatchObject({ allowed: true, reason: 'individual_allowed' });
    await expect(
      authorize({ actorId: ACTOR, workspaceId: WORKSPACE_A, action: 'order.manage' }),
    ).resolves.toMatchObject({ allowed: true, reason: 'role_allowed' });
  });

  it('lets an explicit deny override a role allow', async () => {
    const store = new MemoryAccessStore();
    const authorize = createAuthorize({ accessStore: store });
    store.rows.set(
      `${ACTOR}:${WORKSPACE_A}`,
      activeAccess(['owner'], [{ name: 'document_download', effect: 'deny' }]),
    );
    await expect(
      authorize({ actorId: ACTOR, workspaceId: WORKSPACE_A, action: 'document.download' }),
    ).resolves.toEqual({ allowed: false, reason: 'permission_denied' });
  });

  it('allows a Finance member a privileged finance action', async () => {
    const store = new MemoryAccessStore();
    store.rows.set(`${ACTOR}:${WORKSPACE_A}`, activeAccess(['finance']));
    const authorize = createAuthorize({ accessStore: store });

    await expect(
      authorize({ actorId: ACTOR, workspaceId: WORKSPACE_A, action: 'financial.read' }),
    ).resolves.toMatchObject({ allowed: true, reason: 'role_allowed' });
  });

  it('allows an Owner every privileged action on the signed-in session alone', async () => {
    const store = new MemoryAccessStore();
    store.rows.set(`${ACTOR}:${WORKSPACE_A}`, activeAccess(['owner']));
    const authorize = createAuthorize({ accessStore: store });

    for (const action of ['staff.invite', 'record.delete', 'integration.manage'] as const) {
      await expect(
        authorize({ actorId: ACTOR, workspaceId: WORKSPACE_A, action }),
      ).resolves.toMatchObject({ allowed: true, reason: 'role_allowed' });
    }
  });
});
