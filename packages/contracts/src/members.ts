import { z } from 'zod';

import { requestIdSchema } from './common';
import { staffRoleNameSchema } from './staff-auth';

/**
 * Active workspace members offered as assignee options —
 * `GET /staff/workspaces/{workspaceId}/members`. Carries the actor id leads
 * and tasks are assigned to, the roles, and the name each member chose for
 * themselves (`displayName`, null until they set one). Never an email, so the
 * list is safe for any workspace reader and the assignee picker never becomes
 * a staff directory.
 */
export const staffDisplayNameSchema = z.string().trim().min(1).max(80);

export const assignableMemberSchema = z.object({
  membershipId: z.uuid(),
  actorId: z.uuid(),
  displayName: z.string().min(1).max(80).nullable(),
  roles: z.array(staffRoleNameSchema),
  isSelf: z.boolean(),
});
export type AssignableMember = z.infer<typeof assignableMemberSchema>;

export const listAssignableMembersResponseSchema = z.object({
  members: z.array(assignableMemberSchema),
  requestId: requestIdSchema,
});
export type ListAssignableMembersResponse = z.infer<typeof listAssignableMembersResponseSchema>;

/**
 * `PATCH /staff/profile` — the caller's own display name, applied to every
 * site they are an active member of.
 */
export const updateStaffProfileRequestSchema = z
  .object({ displayName: staffDisplayNameSchema })
  .strict();
export type UpdateStaffProfileRequest = z.infer<typeof updateStaffProfileRequestSchema>;

export const updateStaffProfileResponseSchema = z.object({
  displayName: z.string().min(1).max(80),
  /** How many site memberships now carry the name. */
  memberships: z.int().nonnegative(),
  requestId: requestIdSchema,
});
export type UpdateStaffProfileResponse = z.infer<typeof updateStaffProfileResponseSchema>;
