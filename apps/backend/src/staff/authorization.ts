import type {
  MembershipStatus,
  PermissionEffect,
  StaffPermissionName,
  StaffRoleName,
} from '@gt-sales/types';

const tuple = <const Values extends readonly string[]>(...values: Values): Values => values;

const actionNames = tuple(
  'workspace.read',
  'lead.manage',
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
  // Opening a sealed value (a customer's SIN). No role but owner has it, and no
  // individual permission grants it.
  'sensitive.reveal',
);

export type StaffAction = (typeof actionNames)[number];

const actions = (...values: StaffAction[]): ReadonlySet<StaffAction> => new Set(values);

const roleActions = {
  owner: actions(...actionNames),
  leads: actions('workspace.read', 'lead.manage'),
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
  'membership_missing' | 'membership_pending' | 'membership_revoked' | 'permission_denied';

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

/**
 * The decision for one action against an access snapshot that is already
 * loaded: an active membership, then an individual deny, then an individual
 * allow or a role allow. Owner decision (25 Oct 2026): there is no
 * multi-factor step, so a signed-in session with the right role or permission
 * is the whole gate, privileged actions included. Pure, so a request that
 * needs several decisions for one actor loads the membership once.
 */
export function decideAccess(
  access: StaffAccessSnapshot | undefined,
  action: StaffAction,
): AuthorizationDecision {
  if (!access) return { allowed: false, reason: 'membership_missing' };
  if (access.status === 'pending') return { allowed: false, reason: 'membership_pending' };
  if (access.status === 'revoked') return { allowed: false, reason: 'membership_revoked' };

  const matchingOverrides = access.permissions.filter(
    (permission) => permissionActions[permission.name] === action,
  );
  if (matchingOverrides.some((permission) => permission.effect === 'deny')) {
    return { allowed: false, reason: 'permission_denied' };
  }

  const individualAllowed = matchingOverrides.some((permission) => permission.effect === 'allow');
  const roleAllowed = access.roles.some((role) => roleActions[role].has(action));
  if (!individualAllowed && !roleAllowed) {
    return { allowed: false, reason: 'permission_denied' };
  }

  return {
    allowed: true,
    reason: individualAllowed ? 'individual_allowed' : 'role_allowed',
    access,
  };
}

/** Per-action authorization from a live membership read. */
export function createAuthorize(options: { accessStore: StaffAccessStore }) {
  return async function authorize(input: AuthorizeInput): Promise<AuthorizationDecision> {
    const access = await options.accessStore.loadStaffAccess(input.actorId, input.workspaceId);
    return decideAccess(access, input.action);
  };
}
