import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  auditEvents,
  type DatabaseClient,
  membershipPermissions,
  membershipRoles,
  memberships,
  permissions,
  roles,
  withActorTx,
  withTenantTx,
} from '@gt-sales/db';
import {
  membershipStatusSchema,
  staffPermissionNameSchema,
  staffRoleNameSchema,
  type AssignableMember,
  type StaffWorkspace,
} from '@gt-sales/contracts';
import type { StaffRoleName } from '@gt-sales/types';

import type { StaffAccessSnapshot, StaffAccessStore } from './authorization.js';

interface StaffWorkspaceRow {
  [key: string]: unknown;
  id: string;
  slug: string;
  name: string;
  membershipId: string;
  roleNames: string[];
}

export interface BootstrapStaffInput {
  actorId: string;
  verifiedEmail: string;
  requestId: string;
}

export interface InviteStaffInput {
  actorId: string;
  workspaceId: string;
  normalizedEmail: string;
  roleNames: readonly StaffRoleName[];
  requestId: string;
}

export type RevokeResult = 'revoked' | 'already_revoked' | 'not_found' | 'self';

export interface StaffStore extends StaffAccessStore {
  bootstrapStaff(input: BootstrapStaffInput): Promise<StaffWorkspace[]>;
  inviteStaff(input: InviteStaffInput): Promise<string>;
  revokeStaff(input: {
    actorId: string;
    workspaceId: string;
    membershipId: string;
    requestId: string;
  }): Promise<RevokeResult>;
  /** Active staff members as assignee options: membership ids and roles only, never names or emails. */
  listAssignableMembers(workspaceId: string, actorId: string): Promise<AssignableMember[]>;
}

type StaffDatabase = Pick<DatabaseClient, 'withActorTx' | 'withTenantTx'>;

const defaultStaffDatabase: StaffDatabase = { withActorTx, withTenantTx };

export class DatabaseStaffStore implements StaffStore {
  constructor(private readonly database: StaffDatabase = defaultStaffDatabase) {}

  async bootstrapStaff(input: BootstrapStaffInput): Promise<StaffWorkspace[]> {
    return this.database.withActorTx(input.actorId, async (tx) => {
      await tx.execute(
        sql`select app.accept_staff_invitations(${input.verifiedEmail}, ${input.requestId})`,
      );
      const rows = await tx.execute<StaffWorkspaceRow>(sql`
        select
          workspace_id as "id",
          workspace_slug as "slug",
          workspace_name as "name",
          membership_id as "membershipId",
          role_names as "roleNames"
        from app.list_staff_workspaces()
      `);

      return rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        name: row.name,
        membershipId: row.membershipId,
        roles: staffRoleNameSchema.array().parse(row.roleNames),
      }));
    });
  }

  async loadStaffAccess(
    actorId: string,
    workspaceId: string,
  ): Promise<StaffAccessSnapshot | undefined> {
    return this.database.withTenantTx({ actorId, workspaceId }, async (tx) => {
      const [membership] = await tx
        .select({ id: memberships.id, status: memberships.status })
        .from(memberships)
        .where(
          and(
            eq(memberships.workspaceId, workspaceId),
            eq(memberships.userId, actorId),
            eq(memberships.membershipType, 'staff'),
          ),
        )
        .limit(1);

      if (!membership) return undefined;

      const roleRows = await tx
        .select({ name: roles.name })
        .from(membershipRoles)
        .innerJoin(
          roles,
          and(
            eq(roles.workspaceId, membershipRoles.workspaceId),
            eq(roles.id, membershipRoles.roleId),
          ),
        )
        .where(
          and(
            eq(membershipRoles.workspaceId, workspaceId),
            eq(membershipRoles.membershipId, membership.id),
          ),
        );
      const permissionRows = await tx
        .select({ name: permissions.name, effect: membershipPermissions.effect })
        .from(membershipPermissions)
        .innerJoin(
          permissions,
          and(
            eq(permissions.workspaceId, membershipPermissions.workspaceId),
            eq(permissions.id, membershipPermissions.permissionId),
          ),
        )
        .where(
          and(
            eq(membershipPermissions.workspaceId, workspaceId),
            eq(membershipPermissions.membershipId, membership.id),
          ),
        );

      return {
        membershipId: membership.id,
        status: membershipStatusSchema.parse(membership.status),
        roles: roleRows.map((row) => row.name),
        permissions: permissionRows.map((row) => ({
          name: staffPermissionNameSchema.parse(row.name),
          effect: row.effect,
        })),
      };
    });
  }

  async inviteStaff(input: InviteStaffInput): Promise<string> {
    return this.database.withTenantTx(
      { actorId: input.actorId, workspaceId: input.workspaceId },
      async (tx) => {
        const [membership] = await tx
          .insert(memberships)
          .values({
            workspaceId: input.workspaceId,
            invitedEmail: input.normalizedEmail,
            membershipType: 'staff',
            status: 'pending',
          })
          .returning({ id: memberships.id });
        if (!membership) throw new Error('membership insert did not return an id');

        const roleRows = await tx
          .select({ id: roles.id, name: roles.name })
          .from(roles)
          .where(
            and(eq(roles.workspaceId, input.workspaceId), inArray(roles.name, input.roleNames)),
          );
        if (roleRows.length !== new Set(input.roleNames).size) {
          throw new Error('workspace role seed is incomplete');
        }
        await tx.insert(membershipRoles).values(
          roleRows.map((role) => ({
            workspaceId: input.workspaceId,
            membershipId: membership.id,
            roleId: role.id,
          })),
        );
        await tx.insert(auditEvents).values({
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          actorLabel: 'staff actor',
          action: 'membership.invited',
          entity: 'membership',
          entityId: membership.id,
          requestId: input.requestId,
          after: { status: 'pending', roles: input.roleNames },
        });

        return membership.id;
      },
    );
  }

  async revokeStaff(input: {
    actorId: string;
    workspaceId: string;
    membershipId: string;
    requestId: string;
  }): Promise<RevokeResult> {
    return this.database.withTenantTx(
      { actorId: input.actorId, workspaceId: input.workspaceId },
      async (tx) => {
        const [target] = await tx
          .select({ id: memberships.id, status: memberships.status, userId: memberships.userId })
          .from(memberships)
          .where(
            and(
              eq(memberships.workspaceId, input.workspaceId),
              eq(memberships.id, input.membershipId),
              eq(memberships.membershipType, 'staff'),
            ),
          )
          .limit(1);
        if (!target) return 'not_found';
        if (target.userId === input.actorId) return 'self';
        if (target.status === 'revoked') return 'already_revoked';

        await tx
          .update(memberships)
          .set({ status: 'revoked', revokedAt: new Date() })
          .where(
            and(
              eq(memberships.workspaceId, input.workspaceId),
              eq(memberships.id, input.membershipId),
            ),
          );
        await tx.insert(auditEvents).values({
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          actorLabel: 'staff actor',
          action: 'membership.revoked',
          entity: 'membership',
          entityId: input.membershipId,
          requestId: input.requestId,
          before: { status: target.status },
          after: { status: 'revoked' },
        });
        return 'revoked';
      },
    );
  }

  listAssignableMembers(workspaceId: string, actorId: string): Promise<AssignableMember[]> {
    return this.database.withTenantTx({ workspaceId, actorId }, async (tx) => {
      const rows = await tx
        .select({
          membershipId: memberships.id,
          userId: memberships.userId,
          roleName: roles.name,
        })
        .from(memberships)
        .leftJoin(
          membershipRoles,
          and(
            eq(membershipRoles.workspaceId, memberships.workspaceId),
            eq(membershipRoles.membershipId, memberships.id),
          ),
        )
        .leftJoin(
          roles,
          and(
            eq(roles.workspaceId, membershipRoles.workspaceId),
            eq(roles.id, membershipRoles.roleId),
          ),
        )
        .where(
          and(
            eq(memberships.workspaceId, workspaceId),
            eq(memberships.membershipType, 'staff'),
            eq(memberships.status, 'active'),
          ),
        )
        .orderBy(asc(memberships.createdAt));

      const byMembership = new Map<string, AssignableMember>();
      for (const row of rows) {
        const entry = byMembership.get(row.membershipId) ?? {
          membershipId: row.membershipId,
          roles: [],
          isSelf: row.userId === actorId,
        };
        if (row.roleName) entry.roles.push(staffRoleNameSchema.parse(row.roleName));
        byMembership.set(row.membershipId, entry);
      }
      return [...byMembership.values()];
    });
  }
}
