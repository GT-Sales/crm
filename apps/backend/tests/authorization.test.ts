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
    const authorize = createAuthorize({ accessStore: store, assuranceLevel: 'aal2' });

    await expect(
      authorize({ actorId: ACTOR, workspaceId: WORKSPACE_B, action: 'workspace.read' }),
    ).resolves.toEqual({ allowed: false, reason: 'membership_missing' });
  });

  it('denies the Orders role a document download without an individual permission', async () => {
    const store = new MemoryAccessStore();
    store.rows.set(`${ACTOR}:${WORKSPACE_A}`, activeAccess(['orders']));
    const authorize = createAuthorize({ accessStore: store, assuranceLevel: 'aal1' });

    await expect(
      authorize({ actorId: ACTOR, workspaceId: WORKSPACE_A, action: 'document.download' }),
    ).resolves.toEqual({ allowed: false, reason: 'permission_denied' });
  });

  it('requires MFA for an individually granted privileged permission, not only for Owner/Finance', async () => {
    const store = new MemoryAccessStore();
    store.rows.set(
      `${ACTOR}:${WORKSPACE_A}`,
      activeAccess(['orders'], [{ name: 'document_download', effect: 'allow' }]),
    );
    const withoutMfa = createAuthorize({ accessStore: store, assuranceLevel: 'aal1' });
    await expect(
      withoutMfa({ actorId: ACTOR, workspaceId: WORKSPACE_A, action: 'document.download' }),
    ).resolves.toEqual({ allowed: false, reason: 'mfa_required' });
    // Ordinary work stays available without MFA.
    await expect(
      withoutMfa({ actorId: ACTOR, workspaceId: WORKSPACE_A, action: 'order.manage' }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it('lets an explicit allow grant override a role denial and lets an explicit deny override a role allow', async () => {
    const store = new MemoryAccessStore();
    const authorize = createAuthorize({ accessStore: store, assuranceLevel: 'aal2' });
    store.rows.set(
      `${ACTOR}:${WORKSPACE_A}`,
      activeAccess(['orders'], [{ name: 'document_download', effect: 'allow' }]),
    );
    await expect(
      authorize({ actorId: ACTOR, workspaceId: WORKSPACE_A, action: 'document.download' }),
    ).resolves.toMatchObject({ allowed: true, reason: 'individual_allowed' });

    store.rows.set(
      `${ACTOR}:${WORKSPACE_A}`,
      activeAccess(['owner'], [{ name: 'document_download', effect: 'deny' }]),
    );
    await expect(
      authorize({ actorId: ACTOR, workspaceId: WORKSPACE_A, action: 'document.download' }),
    ).resolves.toEqual({ allowed: false, reason: 'permission_denied' });
  });

  it('denies an MFA-less Finance member a privileged finance action', async () => {
    const store = new MemoryAccessStore();
    store.rows.set(`${ACTOR}:${WORKSPACE_A}`, activeAccess(['finance']));
    const authorize = createAuthorize({ accessStore: store, assuranceLevel: 'aal1' });

    await expect(
      authorize({ actorId: ACTOR, workspaceId: WORKSPACE_A, action: 'financial.read' }),
    ).resolves.toEqual({ allowed: false, reason: 'mfa_required' });
  });

  it('denies an Owner privileged action at aal1 and allows it at verified aal2', async () => {
    const store = new MemoryAccessStore();
    store.rows.set(`${ACTOR}:${WORKSPACE_A}`, activeAccess(['owner']));

    await expect(
      createAuthorize({ accessStore: store, assuranceLevel: 'aal1' })({
        actorId: ACTOR,
        workspaceId: WORKSPACE_A,
        action: 'staff.invite',
      }),
    ).resolves.toEqual({ allowed: false, reason: 'mfa_required' });
    await expect(
      createAuthorize({ accessStore: store, assuranceLevel: 'aal2' })({
        actorId: ACTOR,
        workspaceId: WORKSPACE_A,
        action: 'staff.invite',
      }),
    ).resolves.toMatchObject({ allowed: true, reason: 'role_allowed' });
  });
});
