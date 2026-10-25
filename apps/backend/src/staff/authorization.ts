import type {
  MembershipStatus,
  PermissionEffect,
  StaffPermissionName,
  StaffRoleName,
} from '@gt-sales/types';

import type { AssuranceLevel } from '../auth/session.js';

const tuple = <const Values extends readonly string[]>(...values: Values): Values => values;

const actionNames = tuple(
  'workspace.read',
  'order.manage',
  'staff.invite',
  'staff.remove',
  'staff.roles.manage',
  'document.download',
  'financial.read',
  'export.bulk',
  'record.delete',
  'invoice.approve',
  'integration.manage',
);

export type StaffAction = (typeof actionNames)[number];

const actions = (...values: StaffAction[]): ReadonlySet<StaffAction> => new Set(values);

const roleActions = {
  owner: actions(...actionNames),
  orders: actions('workspace.read', 'order.manage'),
  partners: actions('workspace.read'),
  finance: actions('workspace.read', 'financial.read', 'invoice.approve'),
  content: actions('workspace.read'),
  viewer: actions('workspace.read'),
} satisfies Record<StaffRoleName, ReadonlySet<StaffAction>>;

const permissionActions = {
  document_download: 'document.download',
  financial_data: 'financial.read',
  bulk_export: 'export.bulk',
  deletion: 'record.delete',
  invoice_approval: 'invoice.approve',
  integration_management: 'integration.manage',
} satisfies Record<StaffPermissionName, StaffAction>;

const privilegedActions = new Set<StaffAction>([
  'staff.invite',
  'staff.remove',
  'staff.roles.manage',
  'document.download',
  'financial.read',
  'export.bulk',
  'record.delete',
  'invoice.approve',
  'integration.manage',
]);

export interface IndividualPermission {
  name: StaffPermissionName;
  effect: PermissionEffect;
}

export interface StaffAccessSnapshot {
  membershipId: string;
  status: MembershipStatus;
  roles: readonly StaffRoleName[];
  permissions: readonly IndividualPermission[];
}

export interface StaffAccessStore {
  loadStaffAccess(actorId: string, workspaceId: string): Promise<StaffAccessSnapshot | undefined>;
}

export type AuthorizationAllowReason = 'role_allowed' | 'individual_allowed';

export type AuthorizationDenyReason =
  | 'membership_missing'
  | 'membership_pending'
  | 'membership_revoked'
  | 'permission_denied'
  | 'mfa_required';

export type AuthorizationReason = AuthorizationAllowReason | AuthorizationDenyReason;

export type AuthorizationDecision =
  | { allowed: true; reason: AuthorizationAllowReason; access: StaffAccessSnapshot }
  | { allowed: false; reason: AuthorizationDenyReason };

/**
 * Extracts the deny reason from a denied decision, for callers that already
 * checked `!decision.allowed`. Narrows via a `switch` on `decision.reason`
 * (ordinary literal-union narrowing) rather than on `decision.allowed`:
 * narrowing `AuthorizationDecision` on its `allowed` discriminant has been
 * observed to not apply under Vercel's isolated Node.js function type-check
 * (reproducible there, never locally, across every tsconfig variant tried),
 * even though the two members are a standard discriminated union. This
 * avoids that specific path without an `as` assertion.
 */
export function denyReasonOf(decision: AuthorizationDecision): AuthorizationDenyReason {
  switch (decision.reason) {
    case 'membership_missing':
    case 'membership_pending':
    case 'membership_revoked':
    case 'permission_denied':
    case 'mfa_required':
      return decision.reason;
    default:
      throw new Error('denyReasonOf called with an allowed AuthorizationDecision');
  }
}

export interface AuthorizeInput {
  actorId: string;
  workspaceId: string;
  action: StaffAction;
}

export function createAuthorize(options: {
  accessStore: StaffAccessStore;
  assuranceLevel: AssuranceLevel;
}) {
  return async function authorize(input: AuthorizeInput): Promise<AuthorizationDecision> {
    const access = await options.accessStore.loadStaffAccess(input.actorId, input.workspaceId);
    if (!access) return { allowed: false, reason: 'membership_missing' };
    if (access.status === 'pending') return { allowed: false, reason: 'membership_pending' };
    if (access.status === 'revoked') return { allowed: false, reason: 'membership_revoked' };

    const matchingOverrides = access.permissions.filter(
      (permission) => permissionActions[permission.name] === input.action,
    );
    if (matchingOverrides.some((permission) => permission.effect === 'deny')) {
      return { allowed: false, reason: 'permission_denied' };
    }

    const individualAllowed = matchingOverrides.some((permission) => permission.effect === 'allow');
    const roleAllowed = access.roles.some((role) => roleActions[role].has(input.action));
    if (!individualAllowed && !roleAllowed) {
      return { allowed: false, reason: 'permission_denied' };
    }

    // Owner decision (22 Oct 2026): every privileged action needs an MFA-verified
    // session, whoever holds it — including an individually granted permission
    // on an Orders/Viewer/Content/Partners member, not only Owner/Finance roles.
    if (privilegedActions.has(input.action) && options.assuranceLevel !== 'aal2') {
      return { allowed: false, reason: 'mfa_required' };
    }

    return {
      allowed: true,
      reason: individualAllowed ? 'individual_allowed' : 'role_allowed',
      access,
    };
  };
}
