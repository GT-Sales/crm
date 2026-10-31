import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  auditEvents,
  type DatabaseClient,
  membershipRoles,
  memberships,
  roles,
  staffAccessSnapshot,
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
import { permissionEffects, type StaffRoleName } from '@gt-sales/types';
import { z } from 'zod';

import type { StaffAccessSnapshot, StaffAccessStore } from './authorization.js';

const permissionEffectSchema = z.enum(permissionEffects);

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
  /**
   * Active staff members as assignee options: actor and membership ids, roles
   * and the name each chose for themselves; never an email.
   */
  listAssignableMembers(workspaceId: string, actorId: string): Promise<AssignableMember[]>;
  /** Sets the actor's own display name on each of their active memberships; returns how many. */
  setDisplayName(input: {
    actorId: string;
    displayName: string;
    requestId: string;
  }): Promise<number>;
}

type StaffDatabase = Pick<DatabaseClient, 'withActorTx' | 'withTenantTx' | 'staffAccessSnapshot'>;

const defaultStaffDatabase: StaffDatabase = { withActorTx, withTenantTx, staffAccessSnapshot };

export class DatabaseStaffStore implements StaffStore {
  constructor(private readonly database: StaffDatabase = defaultStaffDatabase) {}

  async bootstrapStaff(input: BootstrapStaffInput): Promise<StaffWorkspace[]> {
    return this.database.withActorTx(input.actorId, async (tx) => {
      // One statement: the invitations accepted first, then the verified
      // address recorded on every active membership where it changed (R9),
      // for staff notification mail; it is never returned.
      await tx.execute(sql`
        select app.record_staff_notification_email(${input.verifiedEmail})
        from (
          select app.accept_staff_invitations(${input.verifiedEmail}, ${input.requestId}) as accepted
        ) invitations
      `);
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
    // Every staff request runs this before its data, and the pooler is remote:
    // one call to app.staff_access_snapshot (migration 0004) is one round trip,
    // where a tenant transaction around the same read cost four.
    const row = await this.database.staffAccessSnapshot({ actorId, workspaceId });
    if (!row) return undefined;

    return {
      membershipId: row.membershipId,
      status: membershipStatusSchema.parse(row.status),
      roles: row.roleNames.map((name) => staffRoleNameSchema.parse(name)),
      permissions: row.permissionRows.map((permission) => ({
        name: staffPermissionNameSchema.parse(permission.name),
        effect: permissionEffectSchema.parse(permission.effect),
      })),
    };
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

  async setDisplayName(input: {
    actorId: string;
    displayName: string;
    requestId: string;
  }): Promise<number> {
    // The runtime role reaches one site per transaction, so each membership
    // is renamed in its own; the sites come from the same bootstrap function
    // sign-in uses, which lists only active memberships.
    const workspaceIds = await this.database.withActorTx(input.actorId, async (tx) => {
      const rows = await tx.execute<{ [key: string]: unknown; workspaceId: string }>(sql`
        select workspace_id as "workspaceId" from app.list_staff_workspaces()
      `);
      return rows.map((row) => row.workspaceId);
    });

    let renamed = 0;
    for (const workspaceId of workspaceIds) {
      renamed += await this.database.withTenantTx(
        { actorId: input.actorId, workspaceId },
        async (tx) => {
          const updated = await tx
            .update(memberships)
            .set({ displayName: input.displayName })
            .where(
              and(
                eq(memberships.workspaceId, workspaceId),
                eq(memberships.userId, input.actorId),
                eq(memberships.membershipType, 'staff'),
                eq(memberships.status, 'active'),
              ),
            )
            .returning({ id: memberships.id });
          const membership = updated[0];
          if (!membership) return 0;
          await tx.insert(auditEvents).values({
            workspaceId,
            actorId: input.actorId,
            actorLabel: 'staff actor',
            action: 'membership.display_name_set',
            entity: 'membership',
            entityId: membership.id,
            requestId: input.requestId,
            after: { displayName: input.displayName },
          });
          return 1;
        },
      );
    }
    return renamed;
  }

  listAssignableMembers(workspaceId: string, actorId: string): Promise<AssignableMember[]> {
    return this.database.withTenantTx({ workspaceId, actorId }, async (tx) => {
      const rows = await tx
        .select({
          membershipId: memberships.id,
          userId: memberships.userId,
          displayName: memberships.displayName,
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
        // An active membership always has its user (memberships_identity_state_check).
        if (!row.userId) continue;
        const entry = byMembership.get(row.membershipId) ?? {
          membershipId: row.membershipId,
          actorId: row.userId,
          displayName: row.displayName,
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
