import { z } from 'zod';

import { requestIdSchema } from './common';
import { staffRoleNameSchema } from './staff-auth';

/**
 * Active workspace members offered as assignee options —
 * `GET /staff/workspaces/{workspaceId}/members`. Returns membership ids and
 * roles only: no names or emails, so the list is safe for any workspace reader
 * and the assignee picker never becomes a staff directory.
 */
export const assignableMemberSchema = z.object({
  membershipId: z.uuid(),
  roles: z.array(staffRoleNameSchema),
  isSelf: z.boolean(),
});
export type AssignableMember = z.infer<typeof assignableMemberSchema>;

export const listAssignableMembersResponseSchema = z.object({
  members: z.array(assignableMemberSchema),
  requestId: requestIdSchema,
});
export type ListAssignableMembersResponse = z.infer<typeof listAssignableMembersResponseSchema>;
