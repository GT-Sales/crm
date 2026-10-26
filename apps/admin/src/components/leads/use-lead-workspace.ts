'use client';

import { useMemo } from 'react';
import type { AssignableMember } from '@gt-sales/contracts';

import { listWorkspaceMembers } from '../../lib/api';
import { useResource } from '../../lib/use-resource';
import { useStaffSession } from '../staff-session-provider';

const NO_MEMBERS: readonly AssignableMember[] = [];

/** The signed-in site for a lead screen: its id, the session token and its members. */
export function useLeadWorkspace(workspaceSlug: string) {
  const staff = useStaffSession();
  const workspace = staff.workspaces.find((item) => item.slug === workspaceSlug);
  const workspaceId = workspace?.id;
  const accessToken = staff.accessToken;

  const loadMembers = useMemo(
    () =>
      accessToken && workspaceId ? () => listWorkspaceMembers(accessToken, workspaceId) : undefined,
    [accessToken, workspaceId],
  );
  const members = useResource(loadMembers);

  return {
    workspaceId,
    accessToken,
    members: members.data?.members ?? NO_MEMBERS,
    reloadMembers: members.reload,
  };
}
